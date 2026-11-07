import type { EmbeddingProfile, PeerId, Transport } from '../types.ts'
import { peerIdFromString } from '@libp2p/peer-id'
import { decodeVector } from '../embed/vector.ts'
import { checkPeerMemorySubject } from './peer-memory.ts'
import type { PeerMemorySubject } from './peer-memory.ts'
import type { AdmissionPolicy, ConferenceDescriptor, ConferenceMessage, PersistableSession, SessionCert } from './conference-records.ts'
import { createDescriptor, createMessage, createSession, createSessionCert, openDescriptor, openMessage, openSessionCert, restoreSession } from './conference-records.ts'
import { ConferencePacket } from './proto/conference.ts'

/** What a local open interest offers when a peer asks to form a conference from it. */
export interface Formable {
  /** The announcement id; becomes the conference id. */
  id: string
  /** The local agent session that holds the interest; becomes the host's session. */
  session: string
  namespace: string
  topicVector: Float32Array
  /** The source text behind the vector, kept host-locally. Never sent. */
  statement?: string
}

export interface ConferenceCreationOptions {
  capacity?: number
  admission?: AdmissionPolicy
  /** Host-selected authenticated peer identities; private to this room. */
  peers?: PeerId[]
}

export function validateConferenceCreationOptions (options: ConferenceCreationOptions): void {
  if (options.capacity !== undefined && (!Number.isInteger(options.capacity) || options.capacity < 2 || options.capacity > 256)) {
    throw new Error('capacity must be an integer from 2 to 256')
  }
  const admission = options.admission === undefined ? 'open' : options.admission
  if (!['open', 'invitation', 'group'].includes(admission)) throw new Error('invalid admission policy')
  if (options.peers !== undefined) {
    if (admission === 'open') throw new Error('open admission cannot specify peers')
    if (!Array.isArray(options.peers) || options.peers.length > 256) throw new Error('peers must be an array of at most 256 peer identities')
    for (const peer of options.peers) {
      if (typeof peer !== 'string') throw new Error('invalid admission peer identity')
      try { peerIdFromString(peer) } catch { throw new Error('invalid admission peer identity') }
    }
  }
}

export type ConferenceEvent =
  | { kind: 'formed', conference: string, session: string }
  | { kind: 'arrival', conference: string, session: string, participant: string, service: PeerId, count: number }
  | { kind: 'departure', conference: string, session: string, participant: string, count: number }
  | { kind: 'message', conference: string, session: string, message: ConferenceMessage, service: PeerId, backlog?: boolean }
  | { kind: 'closed', conference: string, session: string, reason: 'host_closed' | 'expired' | 'left' }

export interface ConferenceInfo {
  id: string
  role: 'host' | 'participant'
  /** Local agent session. */
  session: string
  /** This session's public key in the conference. */
  key: string
  host: PeerId
  descriptor: ConferenceDescriptor
  /** Session keys of everyone in the conference, this session included. */
  participants: string[]
}

export interface ConferenceHistory {
  records: { sequence: number, message: ConferenceMessage, service: PeerId }[]
  cursor: number
  firstAvailable: number
  latest: number
  more: boolean
}

export type HistoryRequest = NonNullable<ConferencePacket['historyRequest']>
export type HistoryReply = NonNullable<ConferencePacket['historyReply']>
export const MAX_HISTORY_PACKET_BYTES = 65536
export const MAX_HISTORY_PAGE = 20

export interface ConferencesOptions {
  transport: Transport
  /** The profile for a namespace this service can evaluate, or undefined. */
  profile: (namespace: string) => EmbeddingProfile | undefined
  /** A live open interest of this service by announcement id, or undefined. Called when a peer asks to form a conference. */
  formable: (id: string) => Formable | undefined
  onEvent: (event: ConferenceEvent) => void
  now?: () => number
  /** Most participants in a conference this service hosts. Default 8, at most 256. */
  capacity?: number
  /** Most conferences this service hosts at once. Default 16. */
  maxHosted?: number
  /** Most conferences this service takes part in without hosting. Default 32. */
  maxJoined?: number
  /** Lifetime of a hosted conference's descriptor, ms. Default 24 hours, at most 7 days. */
  lifetimeMs?: number
  /** Retained messages per hosted room: default 256, maximum 4096; zero disables. */
  historyLimit?: number
  /** Retained message/certificate bytes per hosted room: default 1 MiB, maximum 16 MiB. */
  historyBytes?: number
}

export interface RosterEntry {
  key: string
  service: PeerId
  bytes: Uint8Array
}

export interface Hosted {
  kind: 'host'
  id: string
  session: string
  key: string
  sign: (data: Uint8Array) => Promise<Uint8Array>
  host: PeerId
  descriptor: ConferenceDescriptor
  descriptorBytes: Uint8Array
  roster: RosterEntry[]
  services: Map<string, PeerId>
  seen: string[]
  namespace: string
  profile: EmbeddingProfile
  topicVector: Float32Array
  /** Source text behind the vector, host-local only. Never sent or listed. */
  statement?: string
  capacity: number
  admission: AdmissionPolicy
  allowedPeers: Set<PeerId>
  createdAt: number
  history: { sequence: number, message: Uint8Array<ArrayBuffer>, cert: Uint8Array<ArrayBuffer> }[]
  historySequence: number
  historySize: number
}

export interface Joined {
  kind: 'participant'
  id: string
  session: string
  key: string
  sign: (data: Uint8Array) => Promise<Uint8Array>
  privateKey: Uint8Array
  host: PeerId
  hostAddrs: string[]
  descriptor: ConferenceDescriptor
  descriptorBytes: Uint8Array
  roster: RosterEntry[]
  services: Map<string, PeerId>
  seen: string[]
  /** Original query behind this membership, participant-local only. */
  subject?: PeerMemorySubject
}

export interface PendingJoin {
  session: string
  created?: PersistableSession
  sent?: boolean
  host: PeerId
  hostAddrs: string[]
  ownInterest?: string
  /** Original query captured at join time, stored on admission. */
  subject?: PeerMemorySubject
  /** Captured joined identity for an in-place refresh; absent for fresh joins/resumes. */
  refresh?: Joined
  resolve: (info: ConferenceInfo) => void
  reject: (error: Error) => void
}

export interface PendingHistory {
  entry: Hosted | Joined
  after: number
  limit: number
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
  resolve: (page: ConferenceHistory) => void
  reject: (error: Error) => void
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

export function unhex (text: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('not lowercase hexadecimal')
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

/** Ten minutes: how old a joining certificate may be (Section 6.2). */
export const MAX_CERT_AGE_MS = 600000

/**
 * The expected host definitively reports the room as unknown: it closed or
 * restarted while the participant was offline. Distinct from transport
 * failures, malformed replies and other refusals, which stay retryable.
 */
export class ConferenceRoomUnknownError extends Error {
  readonly conference: string
  constructor (conference: string) {
    super('join refused: unknown')
    this.conference = conference
  }
}


/** The chain key for a packet: its conference hex, or 'bad' when it has none. */
export function packetKey (packet: ConferencePacket): string {
  const bytes = packet.join?.conferenceRef ?? packet.reply?.conferenceRef ?? packet.arrival?.conferenceId ??
    packet.leave?.conferenceId ?? packet.departure?.conferenceId ?? packet.post?.conferenceId ?? packet.topicUpdate?.conferenceId ?? packet.close?.conferenceId ?? packet.historyRequest?.conferenceId ?? packet.historyReply?.conferenceId
  if (bytes === undefined || bytes.length !== 16) return 'bad'
  return hex(bytes)
}

/** One conference packet on the wire: a leading 1 byte plus the encoding. */
export function framed (packet: Parameters<typeof ConferencePacket.encode>[0]): Uint8Array {
  const encoded = ConferencePacket.encode(packet)
  const out = new Uint8Array(1 + encoded.length)
  out[0] = 1
  out.set(encoded, 1)
  return out
}

export function infoOf (entry: Hosted | Joined): ConferenceInfo {
  return {
    id: entry.id, role: entry.kind, session: entry.session, key: entry.key,
    host: entry.host, descriptor: entry.descriptor,
    participants: entry.roster.map(participant => participant.key)
  }
}

