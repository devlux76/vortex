/**
 * Conferences: one conversation shared by all its participants (Section 6).
 * Star topology (Section 7.3): participants send to the host, the host fans
 * out. A conference forms lazily from an open interest (Section 6.2): its id
 * is that interest's announcement id and its holder is the host.
 *
 * Nothing here imports a Node built-in. Expiry uses an injected clock;
 * history requests have bounded, cancellable deadlines.
 */
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

type HistoryRequest = NonNullable<ConferencePacket['historyRequest']>
type HistoryReply = NonNullable<ConferencePacket['historyReply']>
const MAX_HISTORY_PACKET_BYTES = 65536
const MAX_HISTORY_PAGE = 20

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

interface RosterEntry {
  key: string
  service: PeerId
  bytes: Uint8Array
}

interface Hosted {
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

interface Joined {
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

interface PendingJoin {
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

interface PendingHistory {
  entry: Hosted | Joined
  after: number
  limit: number
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
  resolve: (page: ConferenceHistory) => void
  reject: (error: Error) => void
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

function unhex (text: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('not lowercase hexadecimal')
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

/** Ten minutes: how old a joining certificate may be (Section 6.2). */
const MAX_CERT_AGE_MS = 600000

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

export class Conferences {
  private transport: Transport
  private lookupProfile: (namespace: string) => EmbeddingProfile | undefined
  private formable: (id: string) => Formable | undefined
  private onEvent: (event: ConferenceEvent) => void
  private now: () => number
  private capacity: number
  private maxHosted: number
  private maxJoined: number
  private lifetimeMs: number
  private historyLimit: number
  private historyBytes: number
  private histories = new Map<string, PendingHistory>()
  private hosted = new Map<string, Hosted>()
  private creating = new Map<string, object>()
  private joined = new Map<string, Joined>()
  private pending = new Map<string, PendingJoin>()
  private chains = new Map<string, Promise<void>>()
  private closed: string[] = []
  private removeDirect: (() => void) | undefined
  private running = false
  private generation = 0

  constructor (options: ConferencesOptions) {
    const capacity = options.capacity ?? 8
    const maxHosted = options.maxHosted ?? 16
    const maxJoined = options.maxJoined ?? 32
    const lifetimeMs = options.lifetimeMs ?? 86400000
    const historyLimit = options.historyLimit ?? 256
    const historyBytes = options.historyBytes ?? 1048576
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > 4096) throw new Error('historyLimit must be 0 to 4096')
    if (!Number.isSafeInteger(historyBytes) || historyBytes < 0 || historyBytes > 16777216) throw new Error('historyBytes must be 0 to 16777216')
    if (!(capacity >= 2 && capacity <= 256)) throw new Error('capacity must be 2 to 256')
    if (!(maxHosted >= 1)) throw new Error('maxHosted must be at least 1')
    if (!(maxJoined >= 1)) throw new Error('maxJoined must be at least 1')
    if (!(lifetimeMs >= 1 && lifetimeMs <= 604800000)) throw new Error('lifetimeMs must be 1 to 604800000')
    this.transport = options.transport
    this.lookupProfile = options.profile
    this.formable = options.formable
    this.onEvent = options.onEvent
    this.now = options.now ?? Date.now
    this.capacity = capacity
    this.maxHosted = maxHosted
    this.maxJoined = maxJoined
    this.lifetimeMs = lifetimeMs
    this.historyLimit = historyLimit
    this.historyBytes = historyBytes
  }

  /** Registers the direct-packet handler. The transport must already be started. */
  start (): void {
    if (this.running) throw new Error('conferences already started')
    this.generation++
    this.running = true
    this.removeDirect = this.transport.onDirect(event => {
      const data = event.data
      if (data.length === 0 || data[0] !== 1) return
      const gen = this.generation
      let packet: ConferencePacket
      try {
        packet = ConferencePacket.decode(data.slice(1))
      } catch {
        return
      }
      const key = packetKey(packet)
      const prev = this.chains.get(key) ?? Promise.resolve()
      this.chains.set(key, prev.then(async () => {
        if (!this.current(gen)) return
        try {
          await this.handle(event.from, packet, gen)
        } catch { /* A bad packet never escapes the handler. */ }
      }, async () => {
        if (!this.current(gen)) return
        try {
          await this.handle(event.from, packet, gen)
        } catch { /* A bad packet never escapes the handler. */ }
      }))
    })
  }

  stop (): void {
    if (!this.running) return
    this.running = false
    const remove = this.removeDirect
    this.removeDirect = undefined
    if (remove !== undefined) remove()
    this.cancelHistories(undefined, 'conferences stopped')
    for (const pending of this.pending.values()) pending.reject(new Error('conferences stopped'))
    this.pending.clear()
    this.hosted.clear()
    this.creating.clear()
    this.joined.clear()
    this.chains.clear()
    this.closed = []
  }

  /** Establish a room without waiting for an open-interest match. */
  async create (request: Omit<Formable, 'id'> & ConferenceCreationOptions): Promise<ConferenceInfo> {
    request = { ...request, topicVector: request.topicVector.slice(),
      peers: Array.isArray(request.peers) ? [...request.peers] : request.peers }
    validateConferenceCreationOptions(request)
    if (typeof request.session !== 'string' || request.session.length < 1 || request.session.length > 128) throw new Error('session must contain 1 to 128 characters')
    const id = hex(crypto.getRandomValues(new Uint8Array(16)))
    const hosted = await this.createHosted({ ...request, id }, this.generation)
    return infoOf(hosted)
  }

  /**
   * Ask the holder of `ref` to admit this session. Resolves when the host accepts,
   * rejects with Error('join refused: <reason>') when it refuses. There is no timeout
   * here: the caller bounds the wait and calls abandon(ref).
   */
  async join (request: { session: string, ref: string, host: PeerId, addrs: string[], ownInterest?: string, subject?: PeerMemorySubject }): Promise<ConferenceInfo> {
    if (!this.running) throw new Error('conferences stopped')
    const { session, ref, host, addrs } = request
    if (!/^(?:[0-9a-f]{32})$/.test(ref)) throw new Error('invalid conference ref')
    if (request.ownInterest !== undefined && !/^(?:[0-9a-f]{32})$/.test(request.ownInterest)) throw new Error('invalid own interest')
    const subject = this.copySubject(request.subject)
    this.sweep()
    const live = this.conferenceOf(session)
    if (live !== undefined && live.id === ref) throw new Error('already in this conference')
    if (this.pending.has(ref)) throw new Error('join already pending')
    if (this.hosted.has(ref)) throw new Error('already hosting this conference')
    if (this.joined.size + this.pending.size >= this.maxJoined) throw new Error('too many joined conferences')
    const gen = this.generation
    return await new Promise<ConferenceInfo>((resolve, reject) => {
      // Reserve before crypto: abandon/stop and competing joins can see this request.
      const pending: PendingJoin = { session, host, hostAddrs: [...addrs],
        ownInterest: request.ownInterest, subject, resolve, reject }
      this.pending.set(ref, pending)
      const active = (): boolean => this.current(gen) && this.pending.get(ref) === pending
      void (async () => {
        const created = await createSession()
        if (!active()) return
        pending.created = created
        const { bytes } = await createSessionCert({ conferenceId: ref, sessionKey: created.key,
          service: this.transport.info().peerId, sign: data => this.transport.sign(data), now: this.now() })
        if (!active()) return
        pending.sent = true
        await this.transport.send(host, framed({ join: {
          conferenceRef: unhex(ref), cert: bytes,
          ownAnnouncementId: request.ownInterest === undefined ? undefined : unhex(request.ownInterest)
        } }), addrs)
      })().catch((error: unknown) => {
        if (!active()) return
        this.pending.delete(ref)
        reject(error instanceof Error ? error : new Error('join send failed'))
      })
    })
  }

  /** Give up a join that has not been answered. Its promise rejects with Error('join abandoned'). */
  abandon (ref: string): boolean {
    const pending = this.pending.get(ref)
    if (pending === undefined) return false
    this.pending.delete(ref)
    pending.reject(new Error('join abandoned'))
    // Abandoning a pending refresh never issues a leave: the seat it would
    // vacate still belongs to the current membership.
    if (pending.refresh === undefined && pending.sent && pending.created) {
      void this.transport.send(pending.host, framed({ leave: { conferenceId: unhex(ref),
        sessionKey: unhex(pending.created.key) } }), pending.hostAddrs).catch(() => {})
    }
    return true
  }

  /**
   * Trusted local persistence helper (not an API operation): copy the raw
   * signed descriptor and the participant session private key for a current
   * participant membership. Host roles and wrong sessions reject.
   */
  exportMembership (conference: string, session: string): { descriptor: Uint8Array, privateKey: Uint8Array, subject?: PeerMemorySubject } {
    this.sweep()
    const hosted = this.hosted.get(conference)
    if (hosted !== undefined && hosted.session === session) throw new Error('host membership cannot be exported')
    const joined = this.joined.get(conference)
    if (joined === undefined || joined.session !== session) throw new Error('not in this conference')
    return { descriptor: joined.descriptorBytes.slice(), privateKey: joined.privateKey.slice(),
      ...(joined.subject === undefined ? {} : { subject: { ...joined.subject } }) }
  }

  /**
   * Trusted-local original query behind a participant membership. Copies on
   * every call; undefined for legacy memberships without one. Host sessions
   * use hostTopicSource instead; wrong sessions reject.
   */
  membershipSubject (conference: string, session: string): PeerMemorySubject | undefined {
    this.sweep()
    const joined = this.joined.get(conference)
    if (joined === undefined || joined.session !== session) throw new Error('not in this conference')
    return joined.subject === undefined ? undefined : { ...joined.subject }
  }

  /**
   * Trusted-local provenance for later feedback: participant key plus
   * certifying service for every entry of the verified current roster.
   * Serves owned hosted and joined sessions alike; copies on every call,
   * and nonmembers and wrong sessions reject.
   */
  certifiedParticipants (conference: string, session: string): { participant: string, service: PeerId }[] {
    this.sweep()
    const entry = this.hosted.get(conference) ?? this.joined.get(conference)
    if (entry === undefined || entry.session !== session) throw new Error('not in this conference')
    return entry.roster.map(roster => ({ participant: roster.key, service: roster.service }))
  }

  /**
   * Resume a persisted participant membership with its existing session key.
   * The saved descriptor is verified before any network send; then the join
   * uses the restored key instead of creating a fresh one. No new wire fields.
   * With `refresh`, only an existing same-session membership holding the same
   * restored key and host is refreshed in place: descriptor and roster update,
   * key material and seen ids are preserved, and cancellation never issues a
   * leave. Without it, any currently joined room is rejected as before.
   * `signal` aborts before pending reservation, verification, sending and on
   * late replies, without emitting leave packets.
   */
  async resumeMembership (session: string, saved: { descriptor: Uint8Array, privateKey: Uint8Array },
    options?: { signal?: AbortSignal, refresh?: boolean, subject?: PeerMemorySubject }): Promise<ConferenceInfo> {
    options?.signal?.throwIfAborted()
    if (!this.running) throw new Error('conferences stopped')
    if (typeof session !== 'string' || session.length < 1 || session.length > 128) throw new Error('session must contain 1 to 128 characters')
    if (saved === undefined || !(saved.descriptor instanceof Uint8Array) || !(saved.privateKey instanceof Uint8Array)) {
      throw new Error('invalid saved membership')
    }
    // Capture and copy before any asynchronous verification.
    const descriptorBytes = saved.descriptor.slice()
    const privateKeyBytes = saved.privateKey.slice()
    const signal = options?.signal
    const wantRefresh = options?.refresh === true
    const subject = wantRefresh ? undefined : this.copySubject(options?.subject)
    const gen = this.generation
    let descriptor: ConferenceDescriptor
    try {
      descriptor = await openDescriptor(descriptorBytes, {
        profile: namespace => this.lookupProfile(namespace),
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature),
        now: this.now()
      })
    } catch (error) {
      throw error instanceof Error ? error : new Error('invalid saved membership')
    }
    signal?.throwIfAborted()
    let restored: PersistableSession
    try {
      restored = await restoreSession(privateKeyBytes)
    } catch (error) {
      throw error instanceof Error ? error : new Error('invalid saved membership')
    }
    signal?.throwIfAborted()
    if (!this.current(gen)) throw new Error('conferences stopped')
    const ref = descriptor.id
    const host = descriptor.host
    const addrs = [...descriptor.addrs]
    if (!/^(?:[0-9a-f]{32})$/.test(ref)) throw new Error('invalid saved membership')
    this.sweep()
    let refresh: Joined | undefined
    if (wantRefresh) {
      const existing = this.joined.get(ref)
      if (existing === undefined || existing.session !== session) throw new Error('no matching membership to refresh')
      if (existing.key !== restored.key) throw new Error('refreshed key does not match membership')
      if (existing.host !== host) throw new Error('refreshed host does not match membership')
      if (this.pending.has(ref)) throw new Error('join already pending')
      refresh = existing
    } else {
      if (this.joined.has(ref)) throw new Error('already in this conference')
      if (this.pending.has(ref)) throw new Error('join already pending')
      if (this.hosted.has(ref)) throw new Error('already hosting this conference')
      if (this.joined.size + this.pending.size >= this.maxJoined) throw new Error('too many joined conferences')
    }
    return await new Promise<ConferenceInfo>((resolve, reject) => {
      const pending: PendingJoin = { session, host, hostAddrs: addrs, created: restored,
        refresh, subject,
        resolve: (info: ConferenceInfo) => { cleanup(); resolve(info) },
        reject: (error: Error) => { cleanup(); reject(error) } }
      const active = (): boolean => this.current(gen) && this.pending.get(ref) === pending &&
        (pending.refresh === undefined || this.joined.get(ref) === pending.refresh) && signal?.aborted !== true
      const onAbort = (): void => {
        if (this.pending.get(ref) !== pending) return
        this.pending.delete(ref)
        pending.reject(signal?.reason instanceof Error ? signal.reason : new Error('resume aborted'))
      }
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(ref, pending)
      if (!active()) {
        this.pending.delete(ref)
        pending.reject(signal?.reason instanceof Error ? signal.reason : new Error('resume aborted'))
        return
      }
      void (async () => {
        if (!active()) return
        const { bytes } = await createSessionCert({ conferenceId: ref, sessionKey: restored.key,
          service: this.transport.info().peerId, sign: data => this.transport.sign(data), now: this.now() })
        if (!active()) return
        pending.sent = true
        await this.transport.send(host, framed({ join: {
          conferenceRef: unhex(ref), cert: bytes
        } }), addrs)
      })().catch((error: unknown) => {
        if (!active()) return
        this.pending.delete(ref)
        pending.reject(error instanceof Error ? error : new Error('join send failed'))
      })
    })
  }

  /** Send a message to the conference as this session. Resolves with the message once it has been handed to the transport. */
  async post (conference: string, session: string, message: { type: string, content: Uint8Array, replyTo?: string }): Promise<ConferenceMessage> {
    if (!this.running) throw new Error('conferences stopped')
    this.sweep()
    const entry = this.hosted.get(conference) ?? this.joined.get(conference)
    if (entry === undefined || entry.session !== session) throw new Error('not in this conference')
    const gen = this.generation
    const { message: posted, bytes } = await createMessage({ conferenceId: conference,
      session: { key: entry.key, sign: entry.sign }, type: message.type, content: message.content,
      replyTo: message.replyTo, now: this.now() })
    if (!this.current(gen) || (this.hosted.get(conference) ?? this.joined.get(conference)) !== entry) throw new Error('conference membership ended')
    this.rememberSeen(entry, posted.id)
    if (entry.kind === 'host') this.retainMessage(entry, bytes, posted.sender)
    const packet = framed({ post: { conferenceId: unhex(conference), message: bytes } })
    if (entry.kind === 'host') {
      for (const participant of entry.roster) {
        const service = entry.services.get(participant.key)
        if (service === undefined || service === this.transport.info().peerId) continue
        await this.transport.send(service, packet).catch(() => {})
      }
    } else {
      await this.transport.send(entry.host, packet, entry.hostAddrs)
    }
    return posted
  }

  /** Fetch verified history for a current local membership, including departed authors. */
  async history (request: { conference: string, session: string, after?: number, limit?: number, timeoutMs?: number, signal?: AbortSignal }): Promise<ConferenceHistory> {
    if (!this.running) throw new Error('conferences stopped')
    request = { ...request }
    request.signal?.throwIfAborted()
    const { conference, session } = request
    const after = request.after === undefined ? 0 : request.after
    const limit = request.limit === undefined ? MAX_HISTORY_PAGE : request.limit
    const timeoutMs = request.timeoutMs === undefined ? 20000 : request.timeoutMs
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid history cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) throw new Error('history limit must be 1 to 20')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('history timeout must be 1 to 60000 ms')
    this.touchOne(conference)
    const entry = this.hosted.get(conference) ?? this.joined.get(conference)
    if (entry === undefined || entry.session !== session) throw new Error('not in this conference')
    if (this.histories.size >= 32) throw new Error('too many pending history requests')
    const gen = this.generation
    const id = hex(crypto.getRandomValues(new Uint8Array(16)))
    const packet: HistoryRequest = { conferenceId: unhex(conference), requestId: unhex(id), sessionKey: unhex(entry.key), after: BigInt(after), limit }
    return await new Promise<ConferenceHistory>((resolve, reject) => {
      const timer = setTimeout(() => this.finishHistory(id, new Error('history request timed out')), timeoutMs)
      if (typeof timer === 'object') timer.unref()
      const aborted = (): void => this.finishHistory(id, new Error('history request canceled'))
      this.histories.set(id, { entry, after, limit, timer, resolve, reject,
        removeAbort: () => request.signal?.removeEventListener('abort', aborted) })
      request.signal?.addEventListener('abort', aborted, { once: true })
      const work = entry.kind === 'host'
        ? this.onHistoryReply(entry.host, this.historyReply(entry, packet), gen)
        : this.transport.send(entry.host, framed({ historyRequest: packet }), entry.hostAddrs)
      void work.catch(() => this.finishHistory(id, new Error('history request failed')))
    })
  }

  private finishHistory (id: string, error?: Error, page?: ConferenceHistory): void {
    const pending = this.histories.get(id)
    if (pending === undefined) return
    this.histories.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbort()
    if (error !== undefined) pending.reject(error)
    else pending.resolve(page!)
  }

  private cancelHistories (conference: string | undefined, reason: string): void {
    for (const [id, pending] of this.histories) {
      if (conference === undefined || pending.entry.id === conference) this.finishHistory(id, new Error(reason))
    }
  }

  private retainMessage (hosted: Hosted, message: Uint8Array, sender: string): void {
    const sequence = ++hosted.historySequence
    if (this.historyLimit === 0 || this.historyBytes === 0) return
    const cert = hosted.roster.find(entry => entry.key === sender)!.bytes
    const row = { sequence, message: message.slice(), cert: cert.slice() }
    hosted.history.push(row)
    hosted.historySize += row.message.length + row.cert.length
    while (hosted.history.length > this.historyLimit || hosted.historySize > this.historyBytes) {
      const removed = hosted.history.shift()!
      hosted.historySize -= removed.message.length + removed.cert.length
    }
  }

  private historyReply (hosted: Hosted, request: HistoryRequest): HistoryReply {
    const reply: HistoryReply = { conferenceId: request.conferenceId, requestId: request.requestId,
      error: '', entries: [], cursor: request.after, firstAvailable: BigInt(hosted.history[0]?.sequence ?? hosted.historySequence + 1),
      latest: BigInt(hosted.historySequence), more: false }
    if (request.after > reply.latest) return { ...reply, error: 'invalid', firstAvailable: 0n, latest: 0n, cursor: 0n }
    for (const row of hosted.history) {
      if (BigInt(row.sequence) <= request.after) continue
      reply.entries.push({ sequence: BigInt(row.sequence), message: row.message, cert: row.cert })
      reply.cursor = BigInt(row.sequence)
      reply.more = reply.cursor < reply.latest
      if (framed({ historyReply: reply }).length > MAX_HISTORY_PACKET_BYTES) {
        reply.entries.pop()
        reply.cursor = reply.entries.at(-1)?.sequence ?? request.after
        break
      }
      if (reply.entries.length === request.limit) break
    }
    if (reply.entries.length === 0) reply.cursor = reply.latest
    reply.more = reply.cursor < reply.latest
    return reply
  }

  private async onHistoryRequest (from: PeerId, request: HistoryRequest): Promise<void> {
    if (request.conferenceId.length !== 16 || request.requestId.length !== 16) return
    const deny = async (error: string): Promise<void> => this.sendPacket(from, { historyReply: {
      conferenceId: request.conferenceId, requestId: request.requestId, error, entries: [], cursor: 0n, firstAvailable: 0n, latest: 0n, more: false } })
    const id = hex(request.conferenceId)
    this.touchOne(id)
    const hosted = this.hosted.get(id)
    if (hosted === undefined) { await deny('unknown'); return }
    if (request.sessionKey.length !== 32 || hosted.services.get(hex(request.sessionKey)) !== from) { await deny('not_member'); return }
    if (request.after > BigInt(Number.MAX_SAFE_INTEGER) || request.limit < 1 || request.limit > MAX_HISTORY_PAGE) { await deny('invalid'); return }
    await this.sendPacket(from, { historyReply: this.historyReply(hosted, request) })
  }

  private async onHistoryReply (from: PeerId, reply: HistoryReply, gen: number): Promise<void> {
    if (reply.requestId.length !== 16) return
    const id = hex(reply.requestId)
    const pending = this.histories.get(id)
    if (pending === undefined || from !== pending.entry.host) return
    const active = (): boolean => {
      this.touchOne(pending.entry.id)
      return this.current(gen) && this.histories.get(id) === pending &&
        (this.hosted.get(pending.entry.id) ?? this.joined.get(pending.entry.id)) === pending.entry
    }
    if (!active()) return
    try {
      if (reply.conferenceId.length !== 16 || hex(reply.conferenceId) !== pending.entry.id) throw new Error('wrong conference')
      if (reply.error) {
        this.finishHistory(id, new Error('history refused: ' + (['unknown', 'not_member', 'invalid'].includes(reply.error) ? reply.error : 'invalid')))
        return
      }
      if (reply.entries.length > pending.limit || framed({ historyReply: reply }).length > MAX_HISTORY_PACKET_BYTES) throw new Error('oversized page')
      const safe = (value: bigint): number => {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid sequence')
        return Number(value)
      }
      const cursor = safe(reply.cursor), firstAvailable = safe(reply.firstAvailable), latest = safe(reply.latest)
      if (cursor < pending.after || cursor > latest || firstAvailable < 1 || firstAvailable > latest + 1 || reply.more !== (cursor < latest)) throw new Error('invalid history bounds')
      if (reply.entries.length === 0 && Math.max(pending.after + 1, firstAvailable) <= latest) throw new Error('missing retained history')
      const records: ConferenceHistory['records'] = []
      const ids = new Set<string>()
      for (const row of reply.entries) {
        const sequence = safe(row.sequence)
        if (sequence !== Math.max(pending.after + 1, firstAvailable) + records.length || sequence > latest) throw new Error('invalid sequence')
        const cert = await openSessionCert(row.cert, { now: this.now(), verify: (peer, data, signature) => this.transport.verify(peer, data, signature) })
        if (!active()) return
        const message = await openMessage(row.message, { now: this.now() })
        if (!active()) return
        if (cert.conferenceId !== pending.entry.id || message.conferenceId !== pending.entry.id || message.sender !== cert.sessionKey || ids.has(message.id)) throw new Error('invalid sender')
        ids.add(message.id)
        records.push({ sequence, message, service: cert.service })
      }
      if (cursor !== (records.at(-1)?.sequence ?? latest)) throw new Error('invalid cursor')
      this.finishHistory(id, undefined, { records, cursor, firstAvailable, latest, more: reply.more })
    } catch { this.finishHistory(id, new Error('invalid conference history')) }
  }

  /** Settle a pending in-place refresh without touching membership or wire. */
  private cancelRefresh (id: string): void {
    const pending = this.pending.get(id)
    if (pending?.refresh === undefined) return
    this.pending.delete(id)
    pending.reject(new Error('refresh ended: membership closed'))
  }

  /** Leave. A host leaving closes the conference for everyone. False if this session is not in it. */
  async leave (conference: string, session: string): Promise<boolean> {
    if (!this.running) return false
    this.sweep()
    const hosted = this.hosted.get(conference)
    if (hosted !== undefined && hosted.session === session) {
      const packet = framed({ close: { conferenceId: unhex(conference) } })
      for (const participant of hosted.roster) {
        const service = hosted.services.get(participant.key)
        if (service === undefined || service === this.transport.info().peerId) continue
        await this.transport.send(service, packet).catch(() => {})
      }
      this.cancelHistories(conference, 'conference membership ended')
      this.hosted.delete(conference)
      this.rememberClosed(conference)
      this.emit({ kind: 'closed', conference, session, reason: 'host_closed' })
      return true
    }
    const joined = this.joined.get(conference)
    if (joined === undefined || joined.session !== session) return false
    const packet = framed({ leave: { conferenceId: unhex(conference), sessionKey: unhex(joined.key) } })
    await this.transport.send(joined.host, packet, joined.hostAddrs).catch(() => {})
    this.cancelHistories(conference, 'conference membership ended')
    this.joined.delete(conference)
    this.cancelRefresh(conference)
    this.emit({ kind: 'closed', conference, session, reason: 'left' })
    return true
  }

  list (session?: string): ConferenceInfo[] {
    this.sweep()
    const out: ConferenceInfo[] = []
    for (const entry of this.hosted.values()) {
      if (session === undefined || entry.session === session) out.push(infoOf(entry))
    }
    for (const entry of this.joined.values()) {
      if (session === undefined || entry.session === session) out.push(infoOf(entry))
    }
    return out
  }

  /**
   * Revise the topic of an owned hosted room: same id, key and roster, a new
   * signed revision fanned out to participants. The work runs on this room's
   * chain, after queued admissions and departures, so revisions stay monotonic.
   */
  async reviseTopic (request: { conference: string, session: string, topicVector: Float32Array, statement: string }): Promise<ConferenceInfo> {
    if (!this.running) throw new Error('conferences stopped')
    const { conference, session } = request
    if (!/^(?:[0-9a-f]{32})$/.test(conference)) throw new Error('invalid conference id')
    if (typeof session !== 'string' || session.length < 1 || session.length > 128) throw new Error('session must contain 1 to 128 characters')
    if (!(request.topicVector instanceof Float32Array)) throw new Error('invalid topic vector')
    if (typeof request.statement !== 'string' || !request.statement) throw new Error('invalid statement')
    const topicVector = request.topicVector.slice()
    const statement = request.statement
    const gen = this.generation
    const prev = this.chains.get(conference) ?? Promise.resolve()
    const task = prev.then(() => this.doReviseTopic(conference, session, topicVector, statement, gen),
      () => this.doReviseTopic(conference, session, topicVector, statement, gen))
    this.chains.set(conference, task.then(() => undefined, () => undefined))
    return await task
  }

  /** The staged revision commits only here, inside the room chain. */
  private async doReviseTopic (conference: string, session: string, topicVector: Float32Array,
    statement: string, gen: number): Promise<ConferenceInfo> {
    const hosted = this.hosted.get(conference)
    if (hosted === undefined || hosted.session !== session) throw new Error('not hosting this conference')
    const checkCurrent = (): void => {
      if (!this.current(gen) || this.hosted.get(conference) !== hosted) throw new Error('conferences stopped')
    }
    checkCurrent()
    const now = this.now()
    const { descriptor, bytes } = await createDescriptor({ id: hosted.id, profile: hosted.profile,
      topicVector, host: this.transport.info().peerId,
      addrs: this.transport.info().addrs, participantCount: hosted.roster.length,
      capacity: hosted.capacity, admission: hosted.admission, createdAt: hosted.createdAt,
      revision: hosted.descriptor.revision + 1,
      expiresAt: hosted.createdAt + this.lifetimeMs, sign: data => this.transport.sign(data), now })
    checkCurrent()
    hosted.topicVector = topicVector
    hosted.statement = statement
    hosted.descriptor = descriptor
    hosted.descriptorBytes = bytes
    const packet = framed({ topicUpdate: { conferenceId: unhex(conference), descriptor: bytes } })
    for (const participant of hosted.roster) {
      checkCurrent()
      const service = hosted.services.get(participant.key)
      if (service === undefined || service === this.transport.info().peerId) continue
      await this.transport.send(service, packet).catch(() => {})
    }
    checkCurrent()
    return infoOf(hosted)
  }

  /**
   * Trusted-local source behind a hosted room's vector: only the owning host
   * session may read it. Copies on every call; never part of public views.
   */
  hostTopicSource (conference: string, session: string): { statement: string | undefined, topicVector: Float32Array, namespace: string, profileVersion: number } {
    this.sweep()
    const hosted = this.hosted.get(conference)
    if (hosted === undefined || hosted.session !== session) throw new Error('not hosting this conference')
    return { statement: hosted.statement, topicVector: hosted.topicVector.slice(),
      namespace: hosted.namespace, profileVersion: hosted.profile.version }
  }

  /** Public signed metadata for locally hosted rooms, without admission credentials or messages. */
  hostedRecords (): { descriptor: ConferenceDescriptor, bytes: Uint8Array }[] {
    this.sweep()
    return [...this.hosted.values()].filter(entry => entry.descriptorBytes.length > 0).map(entry => ({
      descriptor: { ...entry.descriptor, topicVector: entry.descriptor.topicVector.slice(), addrs: [...entry.descriptor.addrs] },
      bytes: entry.descriptorBytes.slice()
    }))
  }

  get (conference: string): ConferenceInfo | undefined {
    this.sweep()
    const hosted = this.hosted.get(conference)
    if (hosted !== undefined) return infoOf(hosted)
    const joined = this.joined.get(conference)
    if (joined !== undefined) return infoOf(joined)
    return undefined
  }

  /** Copy an optional subject, validating structure plus exact profile vector. Never echoes text. */
  private copySubject (subject: PeerMemorySubject | undefined): PeerMemorySubject | undefined {
    if (subject === undefined) return undefined
    const copy = { statement: subject.statement, vector: subject.vector,
      namespace: subject.namespace, profileVersion: subject.profileVersion }
    checkPeerMemorySubject(copy)
    const profile = this.lookupProfile(copy.namespace)
    if (profile === undefined || profile.version !== copy.profileVersion) throw new Error('invalid subject profile')
    try {
      decodeVector(unhex(copy.vector), profile)
    } catch {
      throw new Error('invalid subject vector')
    }
    return copy
  }

  /** The conference holding a local session, if any. Expired entries are gone: callers sweep first. */
  private conferenceOf (session: string): Hosted | Joined | undefined {
    for (const entry of this.hosted.values()) {
      if (entry.session === session) return entry
    }
    for (const entry of this.joined.values()) {
      if (entry.session === session) return entry
    }
    return undefined
  }

  private emit (event: ConferenceEvent): void {
    try {
      this.onEvent(event)
    } catch { /* A throwing onEvent never stops delivery elsewhere. */ }
  }

  /** True while this run is live: started and not superseded by a restart. */
  private current (gen: number): boolean {
    return this.running && gen === this.generation
  }

  private rememberClosed (id: string): void {
    if (!this.closed.includes(id)) this.closed.push(id)
    while (this.closed.length > 256) this.closed.shift()
  }

  private rememberSeen (entry: Hosted | Joined, id: string): void {
    if (entry.seen.includes(id)) return
    entry.seen.push(id)
    while (entry.seen.length > 4096) entry.seen.shift()
  }

  /** Drop expired conferences, emitting `closed`/`expired` and remembering hosted ids. */
  private sweep (): void {
    const now = this.now()
    for (const [id, entry] of this.hosted) {
      // Formation reserves the room before its first descriptor finishes signing.
      if (entry.descriptorBytes.length > 0 && entry.descriptor.expiresAt <= now) {
        this.cancelHistories(id, 'conference expired')
        this.hosted.delete(id)
        this.rememberClosed(id)
        this.emit({ kind: 'closed', conference: id, session: entry.session, reason: 'expired' })
      }
    }
    for (const [id, entry] of this.joined) {
      if (entry.descriptor.expiresAt <= now) {
        this.cancelHistories(id, 'conference expired')
        this.joined.delete(id)
        this.cancelRefresh(id)
        this.emit({ kind: 'closed', conference: id, session: entry.session, reason: 'expired' })
      }
    }
  }

  private async handle (from: PeerId, packet: ConferencePacket, gen: number): Promise<void> {
    if (packet.join !== undefined) await this.onJoinRequest(from, packet.join, gen)
    else if (packet.reply !== undefined) await this.onJoinReply(from, packet.reply, gen)
    else if (packet.arrival !== undefined) await this.onArrival(from, packet.arrival, gen)
    else if (packet.leave !== undefined) await this.onLeave(from, packet.leave, gen)
    else if (packet.departure !== undefined) await this.onDeparture(from, packet.departure, gen)
    else if (packet.post !== undefined) await this.onPost(from, packet.post, gen)
    else if (packet.topicUpdate !== undefined) await this.onTopicUpdate(from, packet.topicUpdate, gen)
    else if (packet.close !== undefined) await this.onClose(from, packet.close, gen)
    else if (packet.historyRequest !== undefined) await this.onHistoryRequest(from, packet.historyRequest)
    else if (packet.historyReply !== undefined) await this.onHistoryReply(from, packet.historyReply, gen)
  }

  private sendPacket (peer: PeerId, packet: Parameters<typeof ConferencePacket.encode>[0], addrs?: string[]): Promise<void> {
    return this.transport.send(peer, framed(packet), addrs).catch(() => {})
  }

  private async onJoinRequest (from: PeerId, request: { conferenceRef: Uint8Array, cert: Uint8Array, ownAnnouncementId?: Uint8Array }, gen: number): Promise<void> {
    const now = this.now()
    const deny = async (reason: string): Promise<void> => {
      const ref = request.conferenceRef.length === 16 ? request.conferenceRef : new Uint8Array(16)
      await this.sendPacket(from, { reply: { conferenceRef: ref, accepted: false, reason, descriptor: new Uint8Array(0), roster: [] } })
    }
    if (request.conferenceRef.length !== 16) {
      await deny('invalid')
      return
    }
    const ref = hex(request.conferenceRef)
    let cert: SessionCert
    try {
      cert = await openSessionCert(request.cert, {
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now
      })
    } catch {
      await deny('invalid')
      return
    }
    // A stop and start across the verification leaves no state behind.
    if (!this.current(gen)) return
    if (cert.conferenceId !== ref || cert.service !== from || now - cert.issuedAt > MAX_CERT_AGE_MS) {
      await deny('invalid')
      return
    }
    this.sweep()
    if (this.closed.includes(ref)) {
      await deny('closed')
      return
    }
    // Crossing (Section 6.2): both services asked for each other's interest at once.
    if (request.ownAnnouncementId !== undefined) {
      const other = hex(request.ownAnnouncementId)
      const pending = this.pending.get(other)
      if (pending !== undefined && pending.host === from && this.formable(ref) !== undefined) {
        if (other < ref) {
          await deny('crossing')
          return
        }
        await this.formAndAdmit(ref, from, cert, request.cert, now, gen)
        this.abandon(other)
        return
      }
      // Late arrival of the same crossing: already in the lower conference the
      // requester belongs to, so the lower id has won and nothing forms here.
      const otherConf = this.hosted.get(other) ?? this.joined.get(other)
      if (otherConf !== undefined && other < ref) {
        const associated = otherConf.kind === 'host'
          ? [...otherConf.services.values()].includes(from)
          : otherConf.host === from
        if (associated) {
          await deny('crossing')
          return
        }
      }
    }
    const hosted = this.hosted.get(ref)
    if (hosted === undefined && this.formable(ref) === undefined) {
      await deny('unknown')
      return
    }
    if (hosted !== undefined) {
      // Authenticated resume: the certified key already belongs to the sender.
      // Refresh with the current descriptor and roster without a new seat,
      // capacity charge, arrival event, or consuming a grant.
      if (hosted.services.get(cert.sessionKey) === from) {
        await this.sendPacket(from, { reply: { conferenceRef: unhex(hosted.id), accepted: true,
          reason: '', descriptor: hosted.descriptorBytes, roster: hosted.roster.map(entry => entry.bytes) } })
        return
      }
      if (hosted.admission !== 'open' && !hosted.allowedPeers.has(from)) {
        await deny('not_admitted')
        return
      }
      if (hosted.roster.length >= hosted.capacity) {
        await deny('full')
        return
      }
      if (hosted.services.has(cert.sessionKey) || [...hosted.services.values()].includes(from)) {
        await deny('invalid')
        return
      }
      await this.admit(hosted, from, cert, request.cert, now, gen)
      return
    }
    if (this.hosted.size + this.creating.size >= this.maxHosted) {
      await deny('full')
      return
    }
    await this.formAndAdmit(ref, from, cert, request.cert, now, gen)
  }

  /** Create the hosted conference for a formable interest, then admit the requester. */
  private async formAndAdmit (ref: string, from: PeerId, cert: SessionCert, certBytes: Uint8Array, now: number, gen: number): Promise<void> {
    const deny = async (reason: string): Promise<void> => {
      await this.sendPacket(from, { reply: { conferenceRef: unhex(ref), accepted: false, reason, descriptor: new Uint8Array(0), roster: [] } })
    }
    const interest = this.formable(ref)
    if (interest === undefined) {
      await deny('unknown')
      return
    }
    if (from === this.transport.info().peerId) {
      await deny('invalid')
      return
    }
    let hosted: Hosted
    try {
      hosted = await this.createHosted(interest, gen)
    } catch {
      if (this.current(gen)) await deny('invalid')
      return
    }
    if (!this.current(gen)) return
    await this.admit(hosted, from, cert, certBytes, now, gen)
  }

  /** Reserve capacity before crypto, then expose only a fully signed hosted room. */
  private async createHosted (request: Formable & ConferenceCreationOptions, gen: number): Promise<Hosted> {
    if (!this.current(gen)) throw new Error('conferences stopped')
    this.sweep()
    if (this.hosted.size + this.creating.size >= this.maxHosted) throw new Error('too many hosted conferences')
    if (this.hosted.has(request.id) || this.creating.has(request.id)) throw new Error('conference already exists')
    const profile = this.lookupProfile(request.namespace)
    if (profile === undefined) throw new Error('unknown namespace')
    const reservation = {}
    this.creating.set(request.id, reservation)
    const checkCurrent = (): void => {
      if (!this.current(gen) || this.creating.get(request.id) !== reservation) throw new Error('conferences stopped')
    }
    try {
      const now = this.now()
      const own = this.transport.info().peerId
      const created = await createSession()
      checkCurrent()
      const ownCert = await createSessionCert({ conferenceId: request.id, sessionKey: created.key,
        service: own, sign: data => this.transport.sign(data), now })
      checkCurrent()
      const hosted: Hosted = {
        kind: 'host', id: request.id, session: request.session, key: created.key, sign: created.sign, host: own,
        descriptor: undefined as never, descriptorBytes: new Uint8Array(0),
        roster: [{ key: created.key, service: own, bytes: ownCert.bytes }],
        services: new Map([[created.key, own]]), seen: [], namespace: request.namespace, profile,
        topicVector: request.topicVector.slice(), statement: request.statement,
        capacity: request.capacity ?? this.capacity,
        admission: request.admission ?? 'open', allowedPeers: new Set((request.peers ?? []).map(peer => peerIdFromString(peer).toString())), createdAt: now,
        history: [], historySequence: 0, historySize: 0
      }
      await this.signDescriptor(hosted, now)
      checkCurrent()
      this.hosted.set(hosted.id, hosted)
      this.emit({ kind: 'formed', conference: hosted.id, session: hosted.session })
      return hosted
    } finally {
      if (this.creating.get(request.id) === reservation) this.creating.delete(request.id)
    }
  }

  /** Sign a fresh descriptor counting the current roster. */
  private async signDescriptor (hosted: Hosted, now: number): Promise<void> {
    const { descriptor, bytes } = await createDescriptor({ id: hosted.id, profile: hosted.profile,
      topicVector: hosted.topicVector, host: this.transport.info().peerId,
      addrs: this.transport.info().addrs, participantCount: hosted.roster.length,
      capacity: hosted.capacity, admission: hosted.admission, createdAt: hosted.createdAt,
      revision: (hosted.descriptor?.revision ?? 0) + 1,
      expiresAt: hosted.createdAt + this.lifetimeMs, sign: data => this.transport.sign(data), now })
    hosted.descriptor = descriptor
    hosted.descriptorBytes = bytes
  }

  /** Add an accepted certificate, reply with descriptor and roster, tell the others, emit. */
  private async admit (hosted: Hosted, from: PeerId, cert: SessionCert, certBytes: Uint8Array, now: number, gen: number): Promise<void> {
    const deny = async (reason: string): Promise<void> => {
      await this.sendPacket(from, { reply: { conferenceRef: unhex(hosted.id), accepted: false, reason, descriptor: new Uint8Array(0), roster: [] } })
    }
    if (hosted.roster.length >= hosted.capacity) {
      await deny('full')
      return
    }
    if (hosted.services.has(cert.sessionKey) || [...hosted.services.values()].includes(from)) {
      await deny('invalid')
      return
    }
    hosted.roster.push({ key: cert.sessionKey, service: from, bytes: certBytes })
    hosted.services.set(cert.sessionKey, from)
    try {
      await this.signDescriptor(hosted, now)
    } catch {
      hosted.roster.pop()
      hosted.services.delete(cert.sessionKey)
      if (this.current(gen) && this.hosted.get(hosted.id) === hosted) await deny('invalid')
      return
    }
    if (!this.current(gen) || this.hosted.get(hosted.id) !== hosted) {
      hosted.roster.pop()
      hosted.services.delete(cert.sessionKey)
      return
    }
    if (hosted.admission === 'invitation') hosted.allowedPeers.delete(from)
    await this.sendPacket(from, { reply: { conferenceRef: unhex(hosted.id), accepted: true,
      reason: '', descriptor: hosted.descriptorBytes, roster: hosted.roster.map(entry => entry.bytes) } })
    const arrival = framed({ arrival: { conferenceId: unhex(hosted.id),
      cert: certBytes, descriptor: hosted.descriptorBytes } })
    for (const participant of hosted.roster) {
      const service = hosted.services.get(participant.key)
      if (service === undefined || service === from || service === this.transport.info().peerId) continue
      await this.transport.send(service, arrival).catch(() => {})
    }
    this.emit({ kind: 'arrival', conference: hosted.id, session: hosted.session,
      participant: cert.sessionKey, service: from, count: hosted.roster.length })
  }

  private async onJoinReply (from: PeerId, reply: { conferenceRef: Uint8Array, accepted: boolean, reason: string, descriptor: Uint8Array, roster: Uint8Array[] }, gen: number): Promise<void> {
    if (reply.conferenceRef.length !== 16) return
    const ref = hex(reply.conferenceRef)
    const pending = this.pending.get(ref)
    if (pending === undefined || pending.created === undefined || from !== pending.host) return
    const created = pending.created
    const active = (): boolean => this.current(gen) && this.pending.get(ref) === pending &&
      (pending.refresh === undefined || this.joined.get(ref) === pending.refresh)
    if (!reply.accepted) {
      if (!active()) return
      this.pending.delete(ref)
      // An expected-host 'unknown' refusal is definitive: the room no longer
      // exists there. Anything else stays a plain refusal.
      if (reply.reason === 'unknown') {
        if (pending.refresh !== undefined) await this.onClose(from, { conferenceId: reply.conferenceRef }, gen)
        pending.reject(new ConferenceRoomUnknownError(ref))
      }
      else pending.reject(new Error('join refused: ' + reply.reason))
      return
    }
    const fail = async (): Promise<void> => {
      if (!active()) return
      this.pending.delete(ref)
      pending.reject(new Error(pending.refresh === undefined ? 'join refused: invalid' : 'refresh refused: invalid'))
      if (pending.refresh !== undefined) return
      await this.transport.send(pending.host, framed({ leave: {
        conferenceId: unhex(ref), sessionKey: unhex(created.key) } }), pending.hostAddrs).catch(() => {})
    }
    const now = this.now()
    let descriptor: ConferenceDescriptor
    try {
      descriptor = await openDescriptor(reply.descriptor, {
        profile: namespace => this.lookupProfile(namespace),
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now })
    } catch {
      await fail()
      return
    }
    if (!active()) return
    if (descriptor.id !== ref || descriptor.host !== from) {
      await fail()
      return
    }
    const own = this.transport.info().peerId
    const roster: RosterEntry[] = []
    const keys = new Set<string>()
    for (const bytes of reply.roster) {
      let cert: SessionCert
      try {
        cert = await openSessionCert(bytes, {
          verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now })
      } catch {
        await fail()
        return
      }
      if (!active()) return
      if (cert.conferenceId !== ref || keys.has(cert.sessionKey)) {
        await fail()
        return
      }
      keys.add(cert.sessionKey)
      roster.push({ key: cert.sessionKey, service: cert.service, bytes })
    }
    if (roster.length === 0 || roster[0].service !== from) {
      await fail()
      return
    }
    const ownEntry = roster.find(entry => entry.key === created.key)
    if (ownEntry === undefined || ownEntry.service !== own) {
      await fail()
      return
    }
    if (roster.length !== descriptor.participantCount || roster.length > descriptor.capacity) {
      await fail()
      return
    }
    if (!active()) return
    if (pending.refresh !== undefined) {
      const current = this.joined.get(ref)
      if (current !== pending.refresh) return
      // A reply older than the current descriptor resolves against current
      // state without regressing signed metadata.
      if (descriptor.createdAt !== current.descriptor.createdAt || descriptor.revision < current.descriptor.revision) {
        this.pending.delete(ref)
        pending.resolve(this.get(ref) as ConferenceInfo)
        return
      }
      if (descriptor.revision === current.descriptor.revision && descriptor.participantCount !== current.descriptor.participantCount) {
        await fail()
        return
      }
      current.descriptor = descriptor
      current.descriptorBytes = reply.descriptor.slice()
      current.roster = roster
      current.services = new Map(roster.map(entry => [entry.key, entry.service] as [string, PeerId]))
      this.pending.delete(ref)
      pending.resolve(this.get(ref) as ConferenceInfo)
      return
    }
    this.pending.delete(ref)
    const services = new Map(roster.map(entry => [entry.key, entry.service] as [string, PeerId]))
    this.joined.set(ref, { kind: 'participant', id: ref, session: pending.session, key: created.key,
      sign: created.sign, privateKey: created.privateKey.slice(), host: from, hostAddrs: pending.hostAddrs,
      descriptor, descriptorBytes: reply.descriptor.slice(), roster, services, seen: [],
      subject: pending.subject === undefined ? undefined : { ...pending.subject } })
    pending.resolve(this.get(ref) as ConferenceInfo)
  }

  private async onArrival (from: PeerId, arrival: { conferenceId: Uint8Array, cert: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
    if (arrival.conferenceId.length !== 16) return
    const id = hex(arrival.conferenceId)
    this.touchOne(id)
    const joined = this.joined.get(id)
    if (joined === undefined || from !== joined.host) return
    const now = this.now()
    let cert: SessionCert
    try {
      cert = await openSessionCert(arrival.cert, {
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now })
    } catch {
      return
    }
    if (!this.current(gen)) return
    if (cert.conferenceId !== id || joined.services.has(cert.sessionKey)) return
    let descriptor: ConferenceDescriptor
    try {
      descriptor = await openDescriptor(arrival.descriptor, {
        profile: namespace => this.lookupProfile(namespace),
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now })
    } catch {
      return
    }
    if (!this.current(gen)) return
    if (descriptor.id !== id || descriptor.host !== joined.host ||
      descriptor.createdAt !== joined.descriptor.createdAt || descriptor.revision <= joined.descriptor.revision) return
    joined.roster.push({ key: cert.sessionKey, service: cert.service, bytes: arrival.cert })
    joined.services.set(cert.sessionKey, cert.service)
    joined.descriptor = descriptor
    joined.descriptorBytes = arrival.descriptor.slice()
    this.emit({ kind: 'arrival', conference: id, session: joined.session,
      participant: cert.sessionKey, service: cert.service, count: joined.roster.length })
  }

  private async onLeave (from: PeerId, leave: { conferenceId: Uint8Array, sessionKey: Uint8Array }, gen: number): Promise<void> {
    if (leave.conferenceId.length !== 16 || leave.sessionKey.length !== 32) return
    const id = hex(leave.conferenceId)
    this.touchOne(id)
    const hosted = this.hosted.get(id)
    if (hosted === undefined) return
    const key = hex(leave.sessionKey)
    if (hosted.services.get(key) !== from) return
    hosted.roster = hosted.roster.filter(entry => entry.key !== key)
    hosted.services.delete(key)
    await this.signDescriptor(hosted, this.now())
    if (!this.current(gen)) return
    const packet = framed({ departure: { conferenceId: unhex(id),
      sessionKey: unhex(key), descriptor: hosted.descriptorBytes } })
    for (const participant of hosted.roster) {
      const service = hosted.services.get(participant.key)
      if (service === undefined || service === this.transport.info().peerId) continue
      await this.transport.send(service, packet).catch(() => {})
    }
    this.emit({ kind: 'departure', conference: id, session: hosted.session, participant: key, count: hosted.roster.length })
  }

  private async onDeparture (from: PeerId, departure: { conferenceId: Uint8Array, sessionKey: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
    if (departure.conferenceId.length !== 16 || departure.sessionKey.length !== 32) return
    const id = hex(departure.conferenceId)
    this.touchOne(id)
    const joined = this.joined.get(id)
    if (joined === undefined || from !== joined.host) return
    const key = hex(departure.sessionKey)
    if (key === joined.key || !joined.services.has(key)) return
    let descriptor: ConferenceDescriptor
    try {
      descriptor = await openDescriptor(departure.descriptor, {
        profile: namespace => this.lookupProfile(namespace),
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now: this.now() })
    } catch {
      return
    }
    if (!this.current(gen)) return
    if (descriptor.id !== id || descriptor.host !== joined.host ||
      descriptor.createdAt !== joined.descriptor.createdAt || descriptor.revision <= joined.descriptor.revision) return
    joined.roster = joined.roster.filter(entry => entry.key !== key)
    joined.services.delete(key)
    joined.descriptor = descriptor
    joined.descriptorBytes = departure.descriptor.slice()
    this.emit({ kind: 'departure', conference: id, session: joined.session, participant: key, count: joined.roster.length })
  }

  /**
   * A host-signed topic revision: newer revision only, same room, profile,
   * creation, roster count, admission, capacity and lifetime. The roster,
   * keys and seen ids are untouched, and no event fires.
   */
  private async onTopicUpdate (from: PeerId, update: { conferenceId: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
    if (update.conferenceId.length !== 16) return
    const id = hex(update.conferenceId)
    this.touchOne(id)
    const joined = this.joined.get(id)
    if (joined === undefined || from !== joined.host) return
    const now = this.now()
    let descriptor: ConferenceDescriptor
    try {
      descriptor = await openDescriptor(update.descriptor, {
        profile: namespace => this.lookupProfile(namespace),
        verify: (peer, data, signature) => this.transport.verify(peer, data, signature), now })
    } catch {
      return
    }
    if (!this.current(gen)) return
    if (descriptor.id !== id || descriptor.host !== joined.host ||
      descriptor.namespace !== joined.descriptor.namespace ||
      descriptor.createdAt !== joined.descriptor.createdAt ||
      descriptor.revision <= joined.descriptor.revision) return
    if (descriptor.participantCount !== joined.descriptor.participantCount ||
      descriptor.admission !== joined.descriptor.admission ||
      descriptor.capacity !== joined.descriptor.capacity ||
      descriptor.expiresAt !== joined.descriptor.expiresAt) return
    joined.descriptor = descriptor
    joined.descriptorBytes = update.descriptor.slice()
  }

  private async onPost (from: PeerId, post: { conferenceId: Uint8Array, message: Uint8Array }, gen: number): Promise<void> {
    if (post.conferenceId.length !== 16) return
    const id = hex(post.conferenceId)
    this.touchOne(id)
    const hosted = this.hosted.get(id)
    if (hosted !== undefined) {
      let message: ConferenceMessage
      try {
        message = await openMessage(post.message, { now: this.now() })
      } catch {
        return
      }
      if (!this.current(gen) || this.hosted.get(id) !== hosted) return
      if (message.conferenceId !== id || hosted.seen.includes(message.id)) return
      if (hosted.services.get(message.sender) !== from) return
      this.rememberSeen(hosted, message.id)
      this.retainMessage(hosted, post.message, message.sender)
      this.emit({ kind: 'message', conference: id, session: hosted.session, message, service: from })
      const packet = framed({ post: { conferenceId: unhex(id), message: post.message } })
      for (const participant of hosted.roster) {
        const service = hosted.services.get(participant.key)
        if (service === undefined || service === from || service === this.transport.info().peerId) continue
        await this.transport.send(service, packet).catch(() => {})
      }
      return
    }
    const joined = this.joined.get(id)
    if (joined === undefined || from !== joined.host) return
    let message: ConferenceMessage
    try {
      message = await openMessage(post.message, { now: this.now() })
    } catch {
      return
    }
    if (!this.current(gen)) return
    if (message.conferenceId !== id || message.sender === joined.key || joined.seen.includes(message.id)) return
    const service = joined.services.get(message.sender)
    if (service === undefined) return
    this.rememberSeen(joined, message.id)
    this.emit({ kind: 'message', conference: id, session: joined.session, message, service })
  }

  private async onClose (from: PeerId, close: { conferenceId: Uint8Array }, gen: number): Promise<void> {
    if (!this.current(gen) || close.conferenceId.length !== 16) return
    const id = hex(close.conferenceId)
    this.touchOne(id)
    const joined = this.joined.get(id)
    if (joined === undefined || from !== joined.host) return
    this.cancelHistories(id, 'conference membership ended')
    this.joined.delete(id)
    this.cancelRefresh(id)
    this.emit({ kind: 'closed', conference: id, session: joined.session, reason: 'host_closed' })
  }

  /** Expiry-check one conference, emitting `closed`/`expired` when it lapsed. */
  private touchOne (id: string): void {
    const now = this.now()
    const hosted = this.hosted.get(id)
    if (hosted !== undefined && hosted.descriptor.expiresAt <= now) {
      this.cancelHistories(id, 'conference expired')
      this.hosted.delete(id)
      this.rememberClosed(id)
      this.emit({ kind: 'closed', conference: id, session: hosted.session, reason: 'expired' })
      return
    }
    const joined = this.joined.get(id)
    if (joined !== undefined && joined.descriptor.expiresAt <= now) {
      this.cancelHistories(id, 'conference expired')
      this.joined.delete(id)
      this.cancelRefresh(id)
      this.emit({ kind: 'closed', conference: id, session: joined.session, reason: 'expired' })
    }
  }
}

/** The chain key for a packet: its conference hex, or 'bad' when it has none. */
function packetKey (packet: ConferencePacket): string {
  const bytes = packet.join?.conferenceRef ?? packet.reply?.conferenceRef ?? packet.arrival?.conferenceId ??
    packet.leave?.conferenceId ?? packet.departure?.conferenceId ?? packet.post?.conferenceId ?? packet.topicUpdate?.conferenceId ?? packet.close?.conferenceId ?? packet.historyRequest?.conferenceId ?? packet.historyReply?.conferenceId
  if (bytes === undefined || bytes.length !== 16) return 'bad'
  return hex(bytes)
}

/** One conference packet on the wire: a leading 1 byte plus the encoding. */
function framed (packet: Parameters<typeof ConferencePacket.encode>[0]): Uint8Array {
  const encoded = ConferencePacket.encode(packet)
  const out = new Uint8Array(1 + encoded.length)
  out[0] = 1
  out.set(encoded, 1)
  return out
}

function infoOf (entry: Hosted | Joined): ConferenceInfo {
  return {
    id: entry.id, role: entry.kind, session: entry.session, key: entry.key,
    host: entry.host, descriptor: entry.descriptor,
    participants: entry.roster.map(participant => participant.key)
  }
}
