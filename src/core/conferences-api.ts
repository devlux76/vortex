import type { EmbeddingProfile, PeerId, Transport } from '../types.ts'
import { peerIdFromString } from '@libp2p/peer-id'
import { decodeVector } from '../embed/vector.ts'
import { checkPeerMemorySubject } from './peer-memory.ts'
import type { PeerMemorySubject } from './peer-memory.ts'
import type { AdmissionPolicy, ConferenceDescriptor, ConferenceMessage, PersistableSession, SessionCert } from './conference-records.ts'
import { createDescriptor, createMessage, createSession, createSessionCert, openDescriptor, openMessage, openSessionCert, restoreSession } from './conference-records.ts'
import { ConferencePacket } from './proto/conference.ts'
import type { Conferences } from './conferences.ts'
import { type Formable, type ConferenceCreationOptions, validateConferenceCreationOptions, type ConferenceEvent, type ConferenceInfo, type ConferenceHistory, type HistoryRequest, type HistoryReply, MAX_HISTORY_PACKET_BYTES, MAX_HISTORY_PAGE, type ConferencesOptions, type RosterEntry, type Hosted, type Joined, type PendingJoin, type PendingHistory, hex, unhex, MAX_CERT_AGE_MS, ConferenceRoomUnknownError, packetKey, framed, infoOf } from './conferences-types.ts'
import { current, cancelHistories, copySubject, conferenceOf, sweep, retainMessage, rememberSeen, finishHistory, historyReply, onHistoryReply, touchOne, cancelRefresh, emit, rememberClosed, doReviseTopic } from './conferences-state.ts'
import { handle, createHosted } from './conferences-join.ts'

export function start (self: Conferences): void {
  if (self.running) throw new Error('conferences already started')
  self.generation++
  self.running = true
  self.removeDirect = self.transport.onDirect(event => {
    const data = event.data
    if (data.length === 0 || data[0] !== 1) return
    const gen = self.generation
    let packet: ConferencePacket
    try {
      packet = ConferencePacket.decode(data.slice(1))
    } catch {
      return
    }
    const key = packetKey(packet)
    const prev = self.chains.get(key) ?? Promise.resolve()
    self.chains.set(key, prev.then(async () => {
      if (!current(self, gen)) return
      try {
        await handle(self, event.from, packet, gen)
      } catch { /* A bad packet never escapes the handler. */ }
    }, async () => {
      if (!current(self, gen)) return
      try {
        await handle(self, event.from, packet, gen)
      } catch { /* A bad packet never escapes the handler. */ }
    }))
  })
}

export function stop (self: Conferences): void {
  if (!self.running) return
  self.running = false
  const remove = self.removeDirect
  self.removeDirect = undefined
  if (remove !== undefined) remove()
  cancelHistories(self, undefined, 'conferences stopped')
  for (const pending of self.pending.values()) pending.reject(new Error('conferences stopped'))
  self.pending.clear()
  self.hosted.clear()
  self.creating.clear()
  self.joined.clear()
  self.chains.clear()
  self.closed = []
}

export async function create (self: Conferences, request: Omit<Formable, 'id'> & ConferenceCreationOptions): Promise<ConferenceInfo> {
  request = { ...request, topicVector: request.topicVector.slice(),
    peers: Array.isArray(request.peers) ? [...request.peers] : request.peers }
  validateConferenceCreationOptions(request)
  if (typeof request.session !== 'string' || request.session.length < 1 || request.session.length > 128) throw new Error('session must contain 1 to 128 characters')
  const id = hex(crypto.getRandomValues(new Uint8Array(16)))
  const hosted = await createHosted(self, { ...request, id }, self.generation)
  return infoOf(hosted)
}

export async function join (self: Conferences, request: { session: string, ref: string, host: PeerId, addrs: string[], ownInterest?: string, subject?: PeerMemorySubject }): Promise<ConferenceInfo> {
  if (!self.running) throw new Error('conferences stopped')
  const { session, ref, host, addrs } = request
  if (!/^(?:[0-9a-f]{32})$/.test(ref)) throw new Error('invalid conference ref')
  if (request.ownInterest !== undefined && !/^(?:[0-9a-f]{32})$/.test(request.ownInterest)) throw new Error('invalid own interest')
  const subject = copySubject(self, request.subject)
  sweep(self)
  const live = conferenceOf(self, session)
  if (live !== undefined && live.id === ref) throw new Error('already in this conference')
  if (self.pending.has(ref)) throw new Error('join already pending')
  if (self.hosted.has(ref)) throw new Error('already hosting this conference')
  if (self.joined.size + self.pending.size >= self.maxJoined) throw new Error('too many joined conferences')
  const gen = self.generation
  return await new Promise<ConferenceInfo>((resolve, reject) => {
    // Reserve before crypto: abandon/stop and competing joins can see this request.
    const pending: PendingJoin = { session, host, hostAddrs: [...addrs],
      ownInterest: request.ownInterest, subject, resolve, reject }
    self.pending.set(ref, pending)
    const active = (): boolean => current(self, gen) && self.pending.get(ref) === pending
    void (async () => {
      const created = await createSession()
      if (!active()) return
      pending.created = created
      const { bytes } = await createSessionCert({ conferenceId: ref, sessionKey: created.key,
        service: self.transport.info().peerId, sign: data => self.transport.sign(data), now: self.now() })
      if (!active()) return
      pending.sent = true
      await self.transport.send(host, framed({ join: {
        conferenceRef: unhex(ref), cert: bytes,
        ownAnnouncementId: request.ownInterest === undefined ? undefined : unhex(request.ownInterest)
      } }), addrs)
    })().catch((error: unknown) => {
      if (!active()) return
      self.pending.delete(ref)
      reject(error instanceof Error ? error : new Error('join send failed'))
    })
  })
}

export function abandon (self: Conferences, ref: string): boolean {
  const pending = self.pending.get(ref)
  if (pending === undefined) return false
  self.pending.delete(ref)
  pending.reject(new Error('join abandoned'))
  // Abandoning a pending refresh never issues a leave: the seat it would
  // vacate still belongs to the current membership.
  if (pending.refresh === undefined && pending.sent && pending.created) {
    void self.transport.send(pending.host, framed({ leave: { conferenceId: unhex(ref),
      sessionKey: unhex(pending.created.key) } }), pending.hostAddrs).catch(() => {})
  }
  return true
}

export function exportMembership (self: Conferences, conference: string, session: string): { descriptor: Uint8Array, privateKey: Uint8Array, subject?: PeerMemorySubject } {
  sweep(self)
  const hosted = self.hosted.get(conference)
  if (hosted !== undefined && hosted.session === session) throw new Error('host membership cannot be exported')
  const joined = self.joined.get(conference)
  if (joined === undefined || joined.session !== session) throw new Error('not in this conference')
  return { descriptor: joined.descriptorBytes.slice(), privateKey: joined.privateKey.slice(),
    ...(joined.subject === undefined ? {} : { subject: { ...joined.subject } }) }
}

export function membershipSubject (self: Conferences, conference: string, session: string): PeerMemorySubject | undefined {
  sweep(self)
  const joined = self.joined.get(conference)
  if (joined === undefined || joined.session !== session) throw new Error('not in this conference')
  return joined.subject === undefined ? undefined : { ...joined.subject }
}

export function certifiedParticipants (self: Conferences, conference: string, session: string): { participant: string, service: PeerId }[] {
  sweep(self)
  const entry = self.hosted.get(conference) ?? self.joined.get(conference)
  if (entry === undefined || entry.session !== session) throw new Error('not in this conference')
  return entry.roster.map(roster => ({ participant: roster.key, service: roster.service }))
}

export async function resumeMembership (self: Conferences, session: string, saved: { descriptor: Uint8Array, privateKey: Uint8Array },
  options?: { signal?: AbortSignal, refresh?: boolean, subject?: PeerMemorySubject }): Promise<ConferenceInfo> {
  options?.signal?.throwIfAborted()
  if (!self.running) throw new Error('conferences stopped')
  if (typeof session !== 'string' || session.length < 1 || session.length > 128) throw new Error('session must contain 1 to 128 characters')
  if (saved === undefined || !(saved.descriptor instanceof Uint8Array) || !(saved.privateKey instanceof Uint8Array)) {
    throw new Error('invalid saved membership')
  }
  // Capture and copy before any asynchronous verification.
  const descriptorBytes = saved.descriptor.slice()
  const privateKeyBytes = saved.privateKey.slice()
  const signal = options?.signal
  const wantRefresh = options?.refresh === true
  const subject = wantRefresh ? undefined : copySubject(self, options?.subject)
  const gen = self.generation
  let descriptor: ConferenceDescriptor
  try {
    descriptor = await openDescriptor(descriptorBytes, {
      profile: namespace => self.lookupProfile(namespace),
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature),
      now: self.now()
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
  if (!current(self, gen)) throw new Error('conferences stopped')
  const ref = descriptor.id
  const host = descriptor.host
  const addrs = [...descriptor.addrs]
  if (!/^(?:[0-9a-f]{32})$/.test(ref)) throw new Error('invalid saved membership')
  sweep(self)
  let refresh: Joined | undefined
  if (wantRefresh) {
    const existing = self.joined.get(ref)
    if (existing === undefined || existing.session !== session) throw new Error('no matching membership to refresh')
    if (existing.key !== restored.key) throw new Error('refreshed key does not match membership')
    if (existing.host !== host) throw new Error('refreshed host does not match membership')
    if (self.pending.has(ref)) throw new Error('join already pending')
    refresh = existing
  } else {
    if (self.joined.has(ref)) throw new Error('already in this conference')
    if (self.pending.has(ref)) throw new Error('join already pending')
    if (self.hosted.has(ref)) throw new Error('already hosting this conference')
    if (self.joined.size + self.pending.size >= self.maxJoined) throw new Error('too many joined conferences')
  }
  return await new Promise<ConferenceInfo>((resolve, reject) => {
    const pending: PendingJoin = { session, host, hostAddrs: addrs, created: restored,
      refresh, subject,
      resolve: (info: ConferenceInfo) => { cleanup(); resolve(info) },
      reject: (error: Error) => { cleanup(); reject(error) } }
    const active = (): boolean => current(self, gen) && self.pending.get(ref) === pending &&
      (pending.refresh === undefined || self.joined.get(ref) === pending.refresh) && signal?.aborted !== true
    const onAbort = (): void => {
      if (self.pending.get(ref) !== pending) return
      self.pending.delete(ref)
      pending.reject(signal?.reason instanceof Error ? signal.reason : new Error('resume aborted'))
    }
    const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    self.pending.set(ref, pending)
    if (!active()) {
      self.pending.delete(ref)
      pending.reject(signal?.reason instanceof Error ? signal.reason : new Error('resume aborted'))
      return
    }
    void (async () => {
      if (!active()) return
      const { bytes } = await createSessionCert({ conferenceId: ref, sessionKey: restored.key,
        service: self.transport.info().peerId, sign: data => self.transport.sign(data), now: self.now() })
      if (!active()) return
      pending.sent = true
      await self.transport.send(host, framed({ join: {
        conferenceRef: unhex(ref), cert: bytes
      } }), addrs)
    })().catch((error: unknown) => {
      if (!active()) return
      self.pending.delete(ref)
      pending.reject(error instanceof Error ? error : new Error('join send failed'))
    })
  })
}

export async function post (self: Conferences, conference: string, session: string, message: { type: string, content: Uint8Array, replyTo?: string }): Promise<ConferenceMessage> {
  if (!self.running) throw new Error('conferences stopped')
  sweep(self)
  const entry = self.hosted.get(conference) ?? self.joined.get(conference)
  if (entry === undefined || entry.session !== session) throw new Error('not in this conference')
  const gen = self.generation
  const { message: posted, bytes } = await createMessage({ conferenceId: conference,
    session: { key: entry.key, sign: entry.sign }, type: message.type, content: message.content,
    replyTo: message.replyTo, now: self.now() })
  if (!current(self, gen) || (self.hosted.get(conference) ?? self.joined.get(conference)) !== entry) throw new Error('conference membership ended')
  rememberSeen(self, entry, posted.id)
  if (entry.kind === 'host') retainMessage(self, entry, bytes, posted.sender)
  const packet = framed({ post: { conferenceId: unhex(conference), message: bytes } })
  if (entry.kind === 'host') {
    for (const participant of entry.roster) {
      const service = entry.services.get(participant.key)
      if (service === undefined || service === self.transport.info().peerId) continue
      await self.transport.send(service, packet).catch(() => {})
    }
  } else {
    await self.transport.send(entry.host, packet, entry.hostAddrs)
  }
  return posted
}

export async function history (self: Conferences, request: { conference: string, session: string, after?: number, limit?: number, timeoutMs?: number, signal?: AbortSignal }): Promise<ConferenceHistory> {
  if (!self.running) throw new Error('conferences stopped')
  request = { ...request }
  request.signal?.throwIfAborted()
  const { conference, session } = request
  const after = request.after === undefined ? 0 : request.after
  const limit = request.limit === undefined ? MAX_HISTORY_PAGE : request.limit
  const timeoutMs = request.timeoutMs === undefined ? 20000 : request.timeoutMs
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid history cursor')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) throw new Error('history limit must be 1 to 20')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('history timeout must be 1 to 60000 ms')
  touchOne(self, conference)
  const entry = self.hosted.get(conference) ?? self.joined.get(conference)
  if (entry === undefined || entry.session !== session) throw new Error('not in this conference')
  if (self.histories.size >= 32) throw new Error('too many pending history requests')
  const gen = self.generation
  const id = hex(crypto.getRandomValues(new Uint8Array(16)))
  const packet: HistoryRequest = { conferenceId: unhex(conference), requestId: unhex(id), sessionKey: unhex(entry.key), after: BigInt(after), limit }
  return await new Promise<ConferenceHistory>((resolve, reject) => {
    const timer = setTimeout(() => finishHistory(self, id, new Error('history request timed out')), timeoutMs)
    if (typeof timer === 'object') timer.unref()
    const aborted = (): void => finishHistory(self, id, new Error('history request canceled'))
    self.histories.set(id, { entry, after, limit, timer, resolve, reject,
      removeAbort: () => request.signal?.removeEventListener('abort', aborted) })
    request.signal?.addEventListener('abort', aborted, { once: true })
    const work = entry.kind === 'host'
      ? onHistoryReply(self, entry.host, historyReply(self, entry, packet), gen)
      : self.transport.send(entry.host, framed({ historyRequest: packet }), entry.hostAddrs)
    void work.catch(() => finishHistory(self, id, new Error('history request failed')))
  })
}

export async function leave (self: Conferences, conference: string, session: string): Promise<boolean> {
  if (!self.running) return false
  sweep(self)
  const hosted = self.hosted.get(conference)
  if (hosted !== undefined && hosted.session === session) {
    const packet = framed({ close: { conferenceId: unhex(conference) } })
    for (const participant of hosted.roster) {
      const service = hosted.services.get(participant.key)
      if (service === undefined || service === self.transport.info().peerId) continue
      await self.transport.send(service, packet).catch(() => {})
    }
    cancelHistories(self, conference, 'conference membership ended')
    self.hosted.delete(conference)
    rememberClosed(self, conference)
    emit(self, { kind: 'closed', conference, session, reason: 'host_closed' })
    return true
  }
  const joined = self.joined.get(conference)
  if (joined === undefined || joined.session !== session) return false
  const packet = framed({ leave: { conferenceId: unhex(conference), sessionKey: unhex(joined.key) } })
  await self.transport.send(joined.host, packet, joined.hostAddrs).catch(() => {})
  cancelHistories(self, conference, 'conference membership ended')
  self.joined.delete(conference)
  cancelRefresh(self, conference)
  emit(self, { kind: 'closed', conference, session, reason: 'left' })
  return true
}

export function list (self: Conferences, session?: string): ConferenceInfo[] {
  sweep(self)
  const out: ConferenceInfo[] = []
  for (const entry of self.hosted.values()) {
    if (session === undefined || entry.session === session) out.push(infoOf(entry))
  }
  for (const entry of self.joined.values()) {
    if (session === undefined || entry.session === session) out.push(infoOf(entry))
  }
  return out
}

export async function reviseTopic (self: Conferences, request: { conference: string, session: string, topicVector: Float32Array, statement: string }): Promise<ConferenceInfo> {
  if (!self.running) throw new Error('conferences stopped')
  const { conference, session } = request
  if (!/^(?:[0-9a-f]{32})$/.test(conference)) throw new Error('invalid conference id')
  if (typeof session !== 'string' || session.length < 1 || session.length > 128) throw new Error('session must contain 1 to 128 characters')
  if (!(request.topicVector instanceof Float32Array)) throw new Error('invalid topic vector')
  if (typeof request.statement !== 'string' || !request.statement) throw new Error('invalid statement')
  const topicVector = request.topicVector.slice()
  const statement = request.statement
  const gen = self.generation
  const prev = self.chains.get(conference) ?? Promise.resolve()
  const task = prev.then(() => doReviseTopic(self, conference, session, topicVector, statement, gen),
    () => doReviseTopic(self, conference, session, topicVector, statement, gen))
  self.chains.set(conference, task.then(() => undefined, () => undefined))
  return await task
}

export function hostTopicSource (self: Conferences, conference: string, session: string): { statement: string | undefined, topicVector: Float32Array, namespace: string, profileVersion: number } {
  sweep(self)
  const hosted = self.hosted.get(conference)
  if (hosted === undefined || hosted.session !== session) throw new Error('not hosting this conference')
  return { statement: hosted.statement, topicVector: hosted.topicVector.slice(),
    namespace: hosted.namespace, profileVersion: hosted.profile.version }
}

export function hostedRecords (self: Conferences): { descriptor: ConferenceDescriptor, bytes: Uint8Array }[] {
  sweep(self)
  return [...self.hosted.values()].filter(entry => entry.descriptorBytes.length > 0).map(entry => ({
    descriptor: { ...entry.descriptor, topicVector: entry.descriptor.topicVector.slice(), addrs: [...entry.descriptor.addrs] },
    bytes: entry.descriptorBytes.slice()
  }))
}

export function get (self: Conferences, conference: string): ConferenceInfo | undefined {
  sweep(self)
  const hosted = self.hosted.get(conference)
  if (hosted !== undefined) return infoOf(hosted)
  const joined = self.joined.get(conference)
  if (joined !== undefined) return infoOf(joined)
  return undefined
}

