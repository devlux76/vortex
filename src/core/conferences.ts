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
export * from './conferences-types.ts'
import { type Formable, type ConferenceCreationOptions, validateConferenceCreationOptions, type ConferenceEvent, type ConferenceInfo, type ConferenceHistory, type HistoryRequest, type HistoryReply, MAX_HISTORY_PACKET_BYTES, MAX_HISTORY_PAGE, type ConferencesOptions, type RosterEntry, type Hosted, type Joined, type PendingJoin, type PendingHistory, hex, unhex, MAX_CERT_AGE_MS, ConferenceRoomUnknownError, packetKey, framed, infoOf } from './conferences-types.ts'
import { start, stop, create, join, abandon, exportMembership, membershipSubject, certifiedParticipants, resumeMembership, post, history, leave, list, reviseTopic, hostTopicSource, hostedRecords, get } from './conferences-api.ts'
import { finishHistory, cancelHistories, retainMessage, historyReply, onHistoryRequest, onHistoryReply, cancelRefresh, doReviseTopic, copySubject, conferenceOf, emit, current, rememberClosed, rememberSeen, sweep, touchOne } from './conferences-state.ts'
import { handle, sendPacket, onJoinRequest, formAndAdmit, createHosted, signDescriptor, admit, onJoinReply } from './conferences-join.ts'
import { onArrival, onLeave, onDeparture, onTopicUpdate, onPost, onClose } from './conferences-events.ts'

export class Conferences {
  transport: Transport
  lookupProfile: (namespace: string) => EmbeddingProfile | undefined
  formable: (id: string) => Formable | undefined
  onEvent: (event: ConferenceEvent) => void
  now: () => number
  capacity: number
  maxHosted: number
  maxJoined: number
  lifetimeMs: number
  historyLimit: number
  historyBytes: number
  histories = new Map<string, PendingHistory>()
  hosted = new Map<string, Hosted>()
  creating = new Map<string, object>()
  joined = new Map<string, Joined>()
  pending = new Map<string, PendingJoin>()
  chains = new Map<string, Promise<void>>()
  closed: string[] = []
  removeDirect: (() => void) | undefined
  running = false
  generation = 0

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
    return start(this)
  }

  stop (): void {
    return stop(this)
  }

  /** Establish a room without waiting for an open-interest match. */
  async create (request: Omit<Formable, 'id'> & ConferenceCreationOptions): Promise<ConferenceInfo> {
    return create(this, request)
  }

  /**
   * Ask the holder of `ref` to admit this session. Resolves when the host accepts,
   * rejects with Error('join refused: <reason>') when it refuses. There is no timeout
   * here: the caller bounds the wait and calls abandon(ref).
   */
  async join (request: { session: string, ref: string, host: PeerId, addrs: string[], ownInterest?: string, subject?: PeerMemorySubject }): Promise<ConferenceInfo> {
    return join(this, request)
  }

  /** Give up a join that has not been answered. Its promise rejects with Error('join abandoned'). */
  abandon (ref: string): boolean {
    return abandon(this, ref)
  }

  /**
   * Trusted local persistence helper (not an API operation): copy the raw
   * signed descriptor and the participant session private key for a current
   * participant membership. Host roles and wrong sessions reject.
   */
  exportMembership (conference: string, session: string): { descriptor: Uint8Array, privateKey: Uint8Array, subject?: PeerMemorySubject } {
    return exportMembership(this, conference, session)
  }

  /**
   * Trusted-local original query behind a participant membership. Copies on
   * every call; undefined for legacy memberships without one. Host sessions
   * use hostTopicSource instead; wrong sessions reject.
   */
  membershipSubject (conference: string, session: string): PeerMemorySubject | undefined {
    return membershipSubject(this, conference, session)
  }

  /**
   * Trusted-local provenance for later feedback: participant key plus
   * certifying service for every entry of the verified current roster.
   * Serves owned hosted and joined sessions alike; copies on every call,
   * and nonmembers and wrong sessions reject.
   */
  certifiedParticipants (conference: string, session: string): { participant: string, service: PeerId }[] {
    return certifiedParticipants(this, conference, session)
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
    return resumeMembership(this, session, saved, options)
  }

  /** Send a message to the conference as this session. Resolves with the message once it has been handed to the transport. */
  async post (conference: string, session: string, message: { type: string, content: Uint8Array, replyTo?: string }): Promise<ConferenceMessage> {
    return post(this, conference, session, message)
  }

  /** Fetch verified history for a current local membership, including departed authors. */
  async history (request: { conference: string, session: string, after?: number, limit?: number, timeoutMs?: number, signal?: AbortSignal }): Promise<ConferenceHistory> {
    return history(this, request)
  }

  private finishHistory (id: string, error?: Error, page?: ConferenceHistory): void {
    return finishHistory(this, id, error, page)
  }

  private cancelHistories (conference: string | undefined, reason: string): void {
    return cancelHistories(this, conference, reason)
  }

  private retainMessage (hosted: Hosted, message: Uint8Array, sender: string): void {
    return retainMessage(this, hosted, message, sender)
  }

  private historyReply (hosted: Hosted, request: HistoryRequest): HistoryReply {
    return historyReply(this, hosted, request)
  }

  private async onHistoryRequest (from: PeerId, request: HistoryRequest): Promise<void> {
    return onHistoryRequest(this, from, request)
  }

  private async onHistoryReply (from: PeerId, reply: HistoryReply, gen: number): Promise<void> {
    return onHistoryReply(this, from, reply, gen)
  }

  /** Settle a pending in-place refresh without touching membership or wire. */
  private cancelRefresh (id: string): void {
    return cancelRefresh(this, id)
  }

  /** Leave. A host leaving closes the conference for everyone. False if this session is not in it. */
  async leave (conference: string, session: string): Promise<boolean> {
    return leave(this, conference, session)
  }

  list (session?: string): ConferenceInfo[] {
    return list(this, session)
  }

  /**
   * Revise the topic of an owned hosted room: same id, key and roster, a new
   * signed revision fanned out to participants. The work runs on this room's
   * chain, after queued admissions and departures, so revisions stay monotonic.
   */
  async reviseTopic (request: { conference: string, session: string, topicVector: Float32Array, statement: string }): Promise<ConferenceInfo> {
    return reviseTopic(this, request)
  }

  /** The staged revision commits only here, inside the room chain. */
  private async doReviseTopic (conference: string, session: string, topicVector: Float32Array,
    statement: string, gen: number): Promise<ConferenceInfo> {
    return doReviseTopic(this, conference, session, topicVector, statement, gen)
  }

  /**
   * Trusted-local source behind a hosted room's vector: only the owning host
   * session may read it. Copies on every call; never part of public views.
   */
  hostTopicSource (conference: string, session: string): { statement: string | undefined, topicVector: Float32Array, namespace: string, profileVersion: number } {
    return hostTopicSource(this, conference, session)
  }

  /** Public signed metadata for locally hosted rooms, without admission credentials or messages. */
  hostedRecords (): { descriptor: ConferenceDescriptor, bytes: Uint8Array }[] {
    return hostedRecords(this)
  }

  get (conference: string): ConferenceInfo | undefined {
    return get(this, conference)
  }

  /** Copy an optional subject, validating structure plus exact profile vector. Never echoes text. */
  private copySubject (subject: PeerMemorySubject | undefined): PeerMemorySubject | undefined {
    return copySubject(this, subject)
  }

  /** The conference holding a local session, if any. Expired entries are gone: callers sweep first. */
  private conferenceOf (session: string): Hosted | Joined | undefined {
    return conferenceOf(this, session)
  }

  private emit (event: ConferenceEvent): void {
    return emit(this, event)
  }

  /** True while this run is live: started and not superseded by a restart. */
  private current (gen: number): boolean {
    return current(this, gen)
  }

  private rememberClosed (id: string): void {
    return rememberClosed(this, id)
  }

  private rememberSeen (entry: Hosted | Joined, id: string): void {
    return rememberSeen(this, entry, id)
  }

  /** Drop expired conferences, emitting `closed`/`expired` and remembering hosted ids. */
  private sweep (): void {
    return sweep(this)
  }

  private async handle (from: PeerId, packet: ConferencePacket, gen: number): Promise<void> {
    return handle(this, from, packet, gen)
  }

  private sendPacket (peer: PeerId, packet: Parameters<typeof ConferencePacket.encode>[0], addrs?: string[]): Promise<void> {
    return sendPacket(this, peer, packet, addrs)
  }

  private async onJoinRequest (from: PeerId, request: { conferenceRef: Uint8Array, cert: Uint8Array, ownAnnouncementId?: Uint8Array }, gen: number): Promise<void> {
    return onJoinRequest(this, from, request, gen)
  }

  /** Create the hosted conference for a formable interest, then admit the requester. */
  private async formAndAdmit (ref: string, from: PeerId, cert: SessionCert, certBytes: Uint8Array, now: number, gen: number): Promise<void> {
    return formAndAdmit(this, ref, from, cert, certBytes, now, gen)
  }

  /** Reserve capacity before crypto, then expose only a fully signed hosted room. */
  private async createHosted (request: Formable & ConferenceCreationOptions, gen: number): Promise<Hosted> {
    return createHosted(this, request, gen)
  }

  /** Sign a fresh descriptor counting the current roster. */
  private async signDescriptor (hosted: Hosted, now: number): Promise<void> {
    return signDescriptor(this, hosted, now)
  }

  /** Add an accepted certificate, reply with descriptor and roster, tell the others, emit. */
  private async admit (hosted: Hosted, from: PeerId, cert: SessionCert, certBytes: Uint8Array, now: number, gen: number): Promise<void> {
    return admit(this, hosted, from, cert, certBytes, now, gen)
  }

  private async onJoinReply (from: PeerId, reply: { conferenceRef: Uint8Array, accepted: boolean, reason: string, descriptor: Uint8Array, roster: Uint8Array[] }, gen: number): Promise<void> {
    return onJoinReply(this, from, reply, gen)
  }

  private async onArrival (from: PeerId, arrival: { conferenceId: Uint8Array, cert: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
    return onArrival(this, from, arrival, gen)
  }

  private async onLeave (from: PeerId, leave: { conferenceId: Uint8Array, sessionKey: Uint8Array }, gen: number): Promise<void> {
    return onLeave(this, from, leave, gen)
  }

  private async onDeparture (from: PeerId, departure: { conferenceId: Uint8Array, sessionKey: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
    return onDeparture(this, from, departure, gen)
  }

  /**
   * A host-signed topic revision: newer revision only, same room, profile,
   * creation, roster count, admission, capacity and lifetime. The roster,
   * keys and seen ids are untouched, and no event fires.
   */
  private async onTopicUpdate (from: PeerId, update: { conferenceId: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
    return onTopicUpdate(this, from, update, gen)
  }

  private async onPost (from: PeerId, post: { conferenceId: Uint8Array, message: Uint8Array }, gen: number): Promise<void> {
    return onPost(this, from, post, gen)
  }

  private async onClose (from: PeerId, close: { conferenceId: Uint8Array }, gen: number): Promise<void> {
    return onClose(this, from, close, gen)
  }

  /** Expiry-check one conference, emitting `closed`/`expired` when it lapsed. */
  private touchOne (id: string): void {
    return touchOne(this, id)
  }
}
