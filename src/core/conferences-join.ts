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
import { onHistoryRequest, onHistoryReply, current, sweep, emit } from './conferences-state.ts'
import { onArrival, onLeave, onDeparture, onTopicUpdate, onPost, onClose } from './conferences-events.ts'
import { abandon, get } from './conferences-api.ts'

export async function handle (self: Conferences, from: PeerId, packet: ConferencePacket, gen: number): Promise<void> {
  if (packet.join !== undefined) await onJoinRequest(self, from, packet.join, gen)
  else if (packet.reply !== undefined) await onJoinReply(self, from, packet.reply, gen)
  else if (packet.arrival !== undefined) await onArrival(self, from, packet.arrival, gen)
  else if (packet.leave !== undefined) await onLeave(self, from, packet.leave, gen)
  else if (packet.departure !== undefined) await onDeparture(self, from, packet.departure, gen)
  else if (packet.post !== undefined) await onPost(self, from, packet.post, gen)
  else if (packet.topicUpdate !== undefined) await onTopicUpdate(self, from, packet.topicUpdate, gen)
  else if (packet.close !== undefined) await onClose(self, from, packet.close, gen)
  else if (packet.historyRequest !== undefined) await onHistoryRequest(self, from, packet.historyRequest)
  else if (packet.historyReply !== undefined) await onHistoryReply(self, from, packet.historyReply, gen)
}

export function sendPacket (self: Conferences, peer: PeerId, packet: Parameters<typeof ConferencePacket.encode>[0], addrs?: string[]): Promise<void> {
  return self.transport.send(peer, framed(packet), addrs).catch(() => {})
}

export async function onJoinRequest (self: Conferences, from: PeerId, request: { conferenceRef: Uint8Array, cert: Uint8Array, ownAnnouncementId?: Uint8Array }, gen: number): Promise<void> {
  const now = self.now()
  const deny = async (reason: string): Promise<void> => {
    const ref = request.conferenceRef.length === 16 ? request.conferenceRef : new Uint8Array(16)
    await sendPacket(self, from, { reply: { conferenceRef: ref, accepted: false, reason, descriptor: new Uint8Array(0), roster: [] } })
  }
  if (request.conferenceRef.length !== 16) {
    await deny('invalid')
    return
  }
  const ref = hex(request.conferenceRef)
  let cert: SessionCert
  try {
    cert = await openSessionCert(request.cert, {
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now
    })
  } catch {
    await deny('invalid')
    return
  }
  // A stop and start across the verification leaves no state behind.
  if (!current(self, gen)) return
  if (cert.conferenceId !== ref || cert.service !== from || now - cert.issuedAt > MAX_CERT_AGE_MS) {
    await deny('invalid')
    return
  }
  sweep(self)
  if (self.closed.includes(ref)) {
    await deny('closed')
    return
  }
  // Crossing (Section 6.2): both services asked for each other's interest at once.
  if (request.ownAnnouncementId !== undefined) {
    const other = hex(request.ownAnnouncementId)
    const pending = self.pending.get(other)
    if (pending !== undefined && pending.host === from && self.formable(ref) !== undefined) {
      if (other < ref) {
        await deny('crossing')
        return
      }
      await formAndAdmit(self, ref, from, cert, request.cert, now, gen)
      abandon(self, other)
      return
    }
    // Late arrival of the same crossing: already in the lower conference the
    // requester belongs to, so the lower id has won and nothing forms here.
    const otherConf = self.hosted.get(other) ?? self.joined.get(other)
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
  const hosted = self.hosted.get(ref)
  if (hosted === undefined && self.formable(ref) === undefined) {
    await deny('unknown')
    return
  }
  if (hosted !== undefined) {
    // Authenticated resume: the certified key already belongs to the sender.
    // Refresh with the current descriptor and roster without a new seat,
    // capacity charge, arrival event, or consuming a grant.
    if (hosted.services.get(cert.sessionKey) === from) {
      await sendPacket(self, from, { reply: { conferenceRef: unhex(hosted.id), accepted: true,
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
    await admit(self, hosted, from, cert, request.cert, now, gen)
    return
  }
  if (self.hosted.size + self.creating.size >= self.maxHosted) {
    await deny('full')
    return
  }
  await formAndAdmit(self, ref, from, cert, request.cert, now, gen)
}

export async function formAndAdmit (self: Conferences, ref: string, from: PeerId, cert: SessionCert, certBytes: Uint8Array, now: number, gen: number): Promise<void> {
  const deny = async (reason: string): Promise<void> => {
    await sendPacket(self, from, { reply: { conferenceRef: unhex(ref), accepted: false, reason, descriptor: new Uint8Array(0), roster: [] } })
  }
  const interest = self.formable(ref)
  if (interest === undefined) {
    await deny('unknown')
    return
  }
  if (from === self.transport.info().peerId) {
    await deny('invalid')
    return
  }
  let hosted: Hosted
  try {
    hosted = await createHosted(self, interest, gen)
  } catch {
    if (current(self, gen)) await deny('invalid')
    return
  }
  if (!current(self, gen)) return
  await admit(self, hosted, from, cert, certBytes, now, gen)
}

export async function createHosted (self: Conferences, request: Formable & ConferenceCreationOptions, gen: number): Promise<Hosted> {
  if (!current(self, gen)) throw new Error('conferences stopped')
  sweep(self)
  if (self.hosted.size + self.creating.size >= self.maxHosted) throw new Error('too many hosted conferences')
  if (self.hosted.has(request.id) || self.creating.has(request.id)) throw new Error('conference already exists')
  const profile = self.lookupProfile(request.namespace)
  if (profile === undefined) throw new Error('unknown namespace')
  const reservation = {}
  self.creating.set(request.id, reservation)
  const checkCurrent = (): void => {
    if (!current(self, gen) || self.creating.get(request.id) !== reservation) throw new Error('conferences stopped')
  }
  try {
    const now = self.now()
    const own = self.transport.info().peerId
    const created = await createSession()
    checkCurrent()
    const ownCert = await createSessionCert({ conferenceId: request.id, sessionKey: created.key,
      service: own, sign: data => self.transport.sign(data), now })
    checkCurrent()
    const hosted: Hosted = {
      kind: 'host', id: request.id, session: request.session, key: created.key, sign: created.sign, host: own,
      descriptor: undefined as never, descriptorBytes: new Uint8Array(0),
      roster: [{ key: created.key, service: own, bytes: ownCert.bytes }],
      services: new Map([[created.key, own]]), seen: [], namespace: request.namespace, profile,
      topicVector: request.topicVector.slice(), statement: request.statement,
      capacity: request.capacity ?? self.capacity,
      admission: request.admission ?? 'open', allowedPeers: new Set((request.peers ?? []).map(peer => peerIdFromString(peer).toString())), createdAt: now,
      history: [], historySequence: 0, historySize: 0
    }
    await signDescriptor(self, hosted, now)
    checkCurrent()
    self.hosted.set(hosted.id, hosted)
    emit(self, { kind: 'formed', conference: hosted.id, session: hosted.session })
    return hosted
  } finally {
    if (self.creating.get(request.id) === reservation) self.creating.delete(request.id)
  }
}

export async function signDescriptor (self: Conferences, hosted: Hosted, now: number): Promise<void> {
  const { descriptor, bytes } = await createDescriptor({ id: hosted.id, profile: hosted.profile,
    topicVector: hosted.topicVector, host: self.transport.info().peerId,
    addrs: self.transport.info().addrs, participantCount: hosted.roster.length,
    capacity: hosted.capacity, admission: hosted.admission, createdAt: hosted.createdAt,
    revision: (hosted.descriptor?.revision ?? 0) + 1,
    expiresAt: hosted.createdAt + self.lifetimeMs, sign: data => self.transport.sign(data), now })
  hosted.descriptor = descriptor
  hosted.descriptorBytes = bytes
}

export async function admit (self: Conferences, hosted: Hosted, from: PeerId, cert: SessionCert, certBytes: Uint8Array, now: number, gen: number): Promise<void> {
  const deny = async (reason: string): Promise<void> => {
    await sendPacket(self, from, { reply: { conferenceRef: unhex(hosted.id), accepted: false, reason, descriptor: new Uint8Array(0), roster: [] } })
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
    await signDescriptor(self, hosted, now)
  } catch {
    hosted.roster.pop()
    hosted.services.delete(cert.sessionKey)
    if (current(self, gen) && self.hosted.get(hosted.id) === hosted) await deny('invalid')
    return
  }
  if (!current(self, gen) || self.hosted.get(hosted.id) !== hosted) {
    hosted.roster.pop()
    hosted.services.delete(cert.sessionKey)
    return
  }
  if (hosted.admission === 'invitation') hosted.allowedPeers.delete(from)
  await sendPacket(self, from, { reply: { conferenceRef: unhex(hosted.id), accepted: true,
    reason: '', descriptor: hosted.descriptorBytes, roster: hosted.roster.map(entry => entry.bytes) } })
  const arrival = framed({ arrival: { conferenceId: unhex(hosted.id),
    cert: certBytes, descriptor: hosted.descriptorBytes } })
  for (const participant of hosted.roster) {
    const service = hosted.services.get(participant.key)
    if (service === undefined || service === from || service === self.transport.info().peerId) continue
    await self.transport.send(service, arrival).catch(() => {})
  }
  emit(self, { kind: 'arrival', conference: hosted.id, session: hosted.session,
    participant: cert.sessionKey, service: from, count: hosted.roster.length })
}

export async function onJoinReply (self: Conferences, from: PeerId, reply: { conferenceRef: Uint8Array, accepted: boolean, reason: string, descriptor: Uint8Array, roster: Uint8Array[] }, gen: number): Promise<void> {
  if (reply.conferenceRef.length !== 16) return
  const ref = hex(reply.conferenceRef)
  const pending = self.pending.get(ref)
  if (pending === undefined || pending.created === undefined || from !== pending.host) return
  const created = pending.created
  const active = (): boolean => current(self, gen) && self.pending.get(ref) === pending &&
    (pending.refresh === undefined || self.joined.get(ref) === pending.refresh)
  if (!reply.accepted) {
    if (!active()) return
    self.pending.delete(ref)
    // An expected-host 'unknown' refusal is definitive: the room no longer
    // exists there. Anything else stays a plain refusal.
    if (reply.reason === 'unknown') {
      if (pending.refresh !== undefined) await onClose(self, from, { conferenceId: reply.conferenceRef }, gen)
      pending.reject(new ConferenceRoomUnknownError(ref))
    }
    else pending.reject(new Error('join refused: ' + reply.reason))
    return
  }
  const fail = async (): Promise<void> => {
    if (!active()) return
    self.pending.delete(ref)
    pending.reject(new Error(pending.refresh === undefined ? 'join refused: invalid' : 'refresh refused: invalid'))
    if (pending.refresh !== undefined) return
    await self.transport.send(pending.host, framed({ leave: {
      conferenceId: unhex(ref), sessionKey: unhex(created.key) } }), pending.hostAddrs).catch(() => {})
  }
  const now = self.now()
  let descriptor: ConferenceDescriptor
  try {
    descriptor = await openDescriptor(reply.descriptor, {
      profile: namespace => self.lookupProfile(namespace),
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now })
  } catch {
    await fail()
    return
  }
  if (!active()) return
  if (descriptor.id !== ref || descriptor.host !== from) {
    await fail()
    return
  }
  const own = self.transport.info().peerId
  const roster: RosterEntry[] = []
  const keys = new Set<string>()
  for (const bytes of reply.roster) {
    let cert: SessionCert
    try {
      cert = await openSessionCert(bytes, {
        verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now })
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
    const current = self.joined.get(ref)
    if (current !== pending.refresh) return
    // A reply older than the current descriptor resolves against current
    // state without regressing signed metadata.
    if (descriptor.createdAt !== current.descriptor.createdAt || descriptor.revision < current.descriptor.revision) {
      self.pending.delete(ref)
      pending.resolve(get(self, ref) as ConferenceInfo)
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
    self.pending.delete(ref)
    pending.resolve(get(self, ref) as ConferenceInfo)
    return
  }
  self.pending.delete(ref)
  const services = new Map(roster.map(entry => [entry.key, entry.service] as [string, PeerId]))
  self.joined.set(ref, { kind: 'participant', id: ref, session: pending.session, key: created.key,
    sign: created.sign, privateKey: created.privateKey.slice(), host: from, hostAddrs: pending.hostAddrs,
    descriptor, descriptorBytes: reply.descriptor.slice(), roster, services, seen: [],
    subject: pending.subject === undefined ? undefined : { ...pending.subject } })
  pending.resolve(get(self, ref) as ConferenceInfo)
}

