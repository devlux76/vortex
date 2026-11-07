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
import { emit, current, touchOne, retainMessage, rememberSeen, cancelHistories, cancelRefresh } from './conferences-state.ts'
import { signDescriptor } from './conferences-join.ts'

export async function onArrival (self: Conferences, from: PeerId, arrival: { conferenceId: Uint8Array, cert: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
  if (arrival.conferenceId.length !== 16) return
  const id = hex(arrival.conferenceId)
  touchOne(self, id)
  const joined = self.joined.get(id)
  if (joined === undefined || from !== joined.host) return
  const now = self.now()
  let cert: SessionCert
  try {
    cert = await openSessionCert(arrival.cert, {
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now })
  } catch {
    return
  }
  if (!current(self, gen)) return
  if (cert.conferenceId !== id || joined.services.has(cert.sessionKey)) return
  let descriptor: ConferenceDescriptor
  try {
    descriptor = await openDescriptor(arrival.descriptor, {
      profile: namespace => self.lookupProfile(namespace),
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now })
  } catch {
    return
  }
  if (!current(self, gen)) return
  if (descriptor.id !== id || descriptor.host !== joined.host ||
    descriptor.createdAt !== joined.descriptor.createdAt || descriptor.revision <= joined.descriptor.revision) return
  joined.roster.push({ key: cert.sessionKey, service: cert.service, bytes: arrival.cert })
  joined.services.set(cert.sessionKey, cert.service)
  joined.descriptor = descriptor
  joined.descriptorBytes = arrival.descriptor.slice()
  emit(self, { kind: 'arrival', conference: id, session: joined.session,
    participant: cert.sessionKey, service: cert.service, count: joined.roster.length })
}

export async function onLeave (self: Conferences, from: PeerId, leave: { conferenceId: Uint8Array, sessionKey: Uint8Array }, gen: number): Promise<void> {
  if (leave.conferenceId.length !== 16 || leave.sessionKey.length !== 32) return
  const id = hex(leave.conferenceId)
  touchOne(self, id)
  const hosted = self.hosted.get(id)
  if (hosted === undefined) return
  const key = hex(leave.sessionKey)
  if (hosted.services.get(key) !== from) return
  hosted.roster = hosted.roster.filter(entry => entry.key !== key)
  hosted.services.delete(key)
  await signDescriptor(self, hosted, self.now())
  if (!current(self, gen)) return
  const packet = framed({ departure: { conferenceId: unhex(id),
    sessionKey: unhex(key), descriptor: hosted.descriptorBytes } })
  for (const participant of hosted.roster) {
    const service = hosted.services.get(participant.key)
    if (service === undefined || service === self.transport.info().peerId) continue
    await self.transport.send(service, packet).catch(() => {})
  }
  emit(self, { kind: 'departure', conference: id, session: hosted.session, participant: key, count: hosted.roster.length })
}

export async function onDeparture (self: Conferences, from: PeerId, departure: { conferenceId: Uint8Array, sessionKey: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
  if (departure.conferenceId.length !== 16 || departure.sessionKey.length !== 32) return
  const id = hex(departure.conferenceId)
  touchOne(self, id)
  const joined = self.joined.get(id)
  if (joined === undefined || from !== joined.host) return
  const key = hex(departure.sessionKey)
  if (key === joined.key || !joined.services.has(key)) return
  let descriptor: ConferenceDescriptor
  try {
    descriptor = await openDescriptor(departure.descriptor, {
      profile: namespace => self.lookupProfile(namespace),
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now: self.now() })
  } catch {
    return
  }
  if (!current(self, gen)) return
  if (descriptor.id !== id || descriptor.host !== joined.host ||
    descriptor.createdAt !== joined.descriptor.createdAt || descriptor.revision <= joined.descriptor.revision) return
  joined.roster = joined.roster.filter(entry => entry.key !== key)
  joined.services.delete(key)
  joined.descriptor = descriptor
  joined.descriptorBytes = departure.descriptor.slice()
  emit(self, { kind: 'departure', conference: id, session: joined.session, participant: key, count: joined.roster.length })
}

export async function onTopicUpdate (self: Conferences, from: PeerId, update: { conferenceId: Uint8Array, descriptor: Uint8Array }, gen: number): Promise<void> {
  if (update.conferenceId.length !== 16) return
  const id = hex(update.conferenceId)
  touchOne(self, id)
  const joined = self.joined.get(id)
  if (joined === undefined || from !== joined.host) return
  const now = self.now()
  let descriptor: ConferenceDescriptor
  try {
    descriptor = await openDescriptor(update.descriptor, {
      profile: namespace => self.lookupProfile(namespace),
      verify: (peer, data, signature) => self.transport.verify(peer, data, signature), now })
  } catch {
    return
  }
  if (!current(self, gen)) return
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

export async function onPost (self: Conferences, from: PeerId, post: { conferenceId: Uint8Array, message: Uint8Array }, gen: number): Promise<void> {
  if (post.conferenceId.length !== 16) return
  const id = hex(post.conferenceId)
  touchOne(self, id)
  const hosted = self.hosted.get(id)
  if (hosted !== undefined) {
    let message: ConferenceMessage
    try {
      message = await openMessage(post.message, { now: self.now() })
    } catch {
      return
    }
    if (!current(self, gen) || self.hosted.get(id) !== hosted) return
    if (message.conferenceId !== id || hosted.seen.includes(message.id)) return
    if (hosted.services.get(message.sender) !== from) return
    rememberSeen(self, hosted, message.id)
    retainMessage(self, hosted, post.message, message.sender)
    emit(self, { kind: 'message', conference: id, session: hosted.session, message, service: from })
    const packet = framed({ post: { conferenceId: unhex(id), message: post.message } })
    for (const participant of hosted.roster) {
      const service = hosted.services.get(participant.key)
      if (service === undefined || service === from || service === self.transport.info().peerId) continue
      await self.transport.send(service, packet).catch(() => {})
    }
    return
  }
  const joined = self.joined.get(id)
  if (joined === undefined || from !== joined.host) return
  let message: ConferenceMessage
  try {
    message = await openMessage(post.message, { now: self.now() })
  } catch {
    return
  }
  if (!current(self, gen)) return
  if (message.conferenceId !== id || message.sender === joined.key || joined.seen.includes(message.id)) return
  const service = joined.services.get(message.sender)
  if (service === undefined) return
  rememberSeen(self, joined, message.id)
  emit(self, { kind: 'message', conference: id, session: joined.session, message, service })
}

export async function onClose (self: Conferences, from: PeerId, close: { conferenceId: Uint8Array }, gen: number): Promise<void> {
  if (!current(self, gen) || close.conferenceId.length !== 16) return
  const id = hex(close.conferenceId)
  touchOne(self, id)
  const joined = self.joined.get(id)
  if (joined === undefined || from !== joined.host) return
  cancelHistories(self, id, 'conference membership ended')
  self.joined.delete(id)
  cancelRefresh(self, id)
  emit(self, { kind: 'closed', conference: id, session: joined.session, reason: 'host_closed' })
}

