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
import { sendPacket } from './conferences-join.ts'

export function finishHistory (self: Conferences, id: string, error?: Error, page?: ConferenceHistory): void {
  const pending = self.histories.get(id)
  if (pending === undefined) return
  self.histories.delete(id)
  clearTimeout(pending.timer)
  pending.removeAbort()
  if (error !== undefined) pending.reject(error)
  else pending.resolve(page!)
}

export function cancelHistories (self: Conferences, conference: string | undefined, reason: string): void {
  for (const [id, pending] of self.histories) {
    if (conference === undefined || pending.entry.id === conference) finishHistory(self, id, new Error(reason))
  }
}

export function retainMessage (self: Conferences, hosted: Hosted, message: Uint8Array, sender: string): void {
  const sequence = ++hosted.historySequence
  if (self.historyLimit === 0 || self.historyBytes === 0) return
  const cert = hosted.roster.find(entry => entry.key === sender)!.bytes
  const row = { sequence, message: message.slice(), cert: cert.slice() }
  hosted.history.push(row)
  hosted.historySize += row.message.length + row.cert.length
  while (hosted.history.length > self.historyLimit || hosted.historySize > self.historyBytes) {
    const removed = hosted.history.shift()!
    hosted.historySize -= removed.message.length + removed.cert.length
  }
}

export function historyReply (self: Conferences, hosted: Hosted, request: HistoryRequest): HistoryReply {
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

export async function onHistoryRequest (self: Conferences, from: PeerId, request: HistoryRequest): Promise<void> {
  if (request.conferenceId.length !== 16 || request.requestId.length !== 16) return
  const deny = async (error: string): Promise<void> => sendPacket(self, from, { historyReply: {
    conferenceId: request.conferenceId, requestId: request.requestId, error, entries: [], cursor: 0n, firstAvailable: 0n, latest: 0n, more: false } })
  const id = hex(request.conferenceId)
  touchOne(self, id)
  const hosted = self.hosted.get(id)
  if (hosted === undefined) { await deny('unknown'); return }
  if (request.sessionKey.length !== 32 || hosted.services.get(hex(request.sessionKey)) !== from) { await deny('not_member'); return }
  if (request.after > BigInt(Number.MAX_SAFE_INTEGER) || request.limit < 1 || request.limit > MAX_HISTORY_PAGE) { await deny('invalid'); return }
  await sendPacket(self, from, { historyReply: historyReply(self, hosted, request) })
}

export async function onHistoryReply (self: Conferences, from: PeerId, reply: HistoryReply, gen: number): Promise<void> {
  if (reply.requestId.length !== 16) return
  const id = hex(reply.requestId)
  const pending = self.histories.get(id)
  if (pending === undefined || from !== pending.entry.host) return
  const active = (): boolean => {
    touchOne(self, pending.entry.id)
    return current(self, gen) && self.histories.get(id) === pending &&
      (self.hosted.get(pending.entry.id) ?? self.joined.get(pending.entry.id)) === pending.entry
  }
  if (!active()) return
  try {
    if (reply.conferenceId.length !== 16 || hex(reply.conferenceId) !== pending.entry.id) throw new Error('wrong conference')
    if (reply.error) {
      finishHistory(self, id, new Error('history refused: ' + (['unknown', 'not_member', 'invalid'].includes(reply.error) ? reply.error : 'invalid')))
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
      const cert = await openSessionCert(row.cert, { now: self.now(), verify: (peer, data, signature) => self.transport.verify(peer, data, signature) })
      if (!active()) return
      const message = await openMessage(row.message, { now: self.now() })
      if (!active()) return
      if (cert.conferenceId !== pending.entry.id || message.conferenceId !== pending.entry.id || message.sender !== cert.sessionKey || ids.has(message.id)) throw new Error('invalid sender')
      ids.add(message.id)
      records.push({ sequence, message, service: cert.service })
    }
    if (cursor !== (records.at(-1)?.sequence ?? latest)) throw new Error('invalid cursor')
    finishHistory(self, id, undefined, { records, cursor, firstAvailable, latest, more: reply.more })
  } catch { finishHistory(self, id, new Error('invalid conference history')) }
}

export function cancelRefresh (self: Conferences, id: string): void {
  const pending = self.pending.get(id)
  if (pending?.refresh === undefined) return
  self.pending.delete(id)
  pending.reject(new Error('refresh ended: membership closed'))
}

export async function doReviseTopic (self: Conferences, conference: string, session: string, topicVector: Float32Array,
  statement: string, gen: number): Promise<ConferenceInfo> {
  const hosted = self.hosted.get(conference)
  if (hosted === undefined || hosted.session !== session) throw new Error('not hosting this conference')
  const checkCurrent = (): void => {
    if (!current(self, gen) || self.hosted.get(conference) !== hosted) throw new Error('conferences stopped')
  }
  checkCurrent()
  const now = self.now()
  const { descriptor, bytes } = await createDescriptor({ id: hosted.id, profile: hosted.profile,
    topicVector, host: self.transport.info().peerId,
    addrs: self.transport.info().addrs, participantCount: hosted.roster.length,
    capacity: hosted.capacity, admission: hosted.admission, createdAt: hosted.createdAt,
    revision: hosted.descriptor.revision + 1,
    expiresAt: hosted.createdAt + self.lifetimeMs, sign: data => self.transport.sign(data), now })
  checkCurrent()
  hosted.topicVector = topicVector
  hosted.statement = statement
  hosted.descriptor = descriptor
  hosted.descriptorBytes = bytes
  const packet = framed({ topicUpdate: { conferenceId: unhex(conference), descriptor: bytes } })
  for (const participant of hosted.roster) {
    checkCurrent()
    const service = hosted.services.get(participant.key)
    if (service === undefined || service === self.transport.info().peerId) continue
    await self.transport.send(service, packet).catch(() => {})
  }
  checkCurrent()
  return infoOf(hosted)
}

export function copySubject (self: Conferences, subject: PeerMemorySubject | undefined): PeerMemorySubject | undefined {
  if (subject === undefined) return undefined
  const copy = { statement: subject.statement, vector: subject.vector,
    namespace: subject.namespace, profileVersion: subject.profileVersion }
  checkPeerMemorySubject(copy)
  const profile = self.lookupProfile(copy.namespace)
  if (profile === undefined || profile.version !== copy.profileVersion) throw new Error('invalid subject profile')
  try {
    decodeVector(unhex(copy.vector), profile)
  } catch {
    throw new Error('invalid subject vector')
  }
  return copy
}

export function conferenceOf (self: Conferences, session: string): Hosted | Joined | undefined {
  for (const entry of self.hosted.values()) {
    if (entry.session === session) return entry
  }
  for (const entry of self.joined.values()) {
    if (entry.session === session) return entry
  }
  return undefined
}

export function emit (self: Conferences, event: ConferenceEvent): void {
  try {
    self.onEvent(event)
  } catch { /* A throwing onEvent never stops delivery elsewhere. */ }
}

export function current (self: Conferences, gen: number): boolean {
  return self.running && gen === self.generation
}

export function rememberClosed (self: Conferences, id: string): void {
  if (!self.closed.includes(id)) self.closed.push(id)
  while (self.closed.length > 256) self.closed.shift()
}

export function rememberSeen (self: Conferences, entry: Hosted | Joined, id: string): void {
  if (entry.seen.includes(id)) return
  entry.seen.push(id)
  while (entry.seen.length > 4096) entry.seen.shift()
}

export function sweep (self: Conferences): void {
  const now = self.now()
  for (const [id, entry] of self.hosted) {
    // Formation reserves the room before its first descriptor finishes signing.
    if (entry.descriptorBytes.length > 0 && entry.descriptor.expiresAt <= now) {
      cancelHistories(self, id, 'conference expired')
      self.hosted.delete(id)
      rememberClosed(self, id)
      emit(self, { kind: 'closed', conference: id, session: entry.session, reason: 'expired' })
    }
  }
  for (const [id, entry] of self.joined) {
    if (entry.descriptor.expiresAt <= now) {
      cancelHistories(self, id, 'conference expired')
      self.joined.delete(id)
      cancelRefresh(self, id)
      emit(self, { kind: 'closed', conference: id, session: entry.session, reason: 'expired' })
    }
  }
}

export function touchOne (self: Conferences, id: string): void {
  const now = self.now()
  const hosted = self.hosted.get(id)
  if (hosted !== undefined && hosted.descriptor.expiresAt <= now) {
    cancelHistories(self, id, 'conference expired')
    self.hosted.delete(id)
    rememberClosed(self, id)
    emit(self, { kind: 'closed', conference: id, session: hosted.session, reason: 'expired' })
    return
  }
  const joined = self.joined.get(id)
  if (joined !== undefined && joined.descriptor.expiresAt <= now) {
    cancelHistories(self, id, 'conference expired')
    self.joined.delete(id)
    cancelRefresh(self, id)
    emit(self, { kind: 'closed', conference: id, session: joined.session, reason: 'expired' })
  }
}

