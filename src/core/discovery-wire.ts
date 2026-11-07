import type { Embedder, GossipEvent, PeerId, Tier, Transport } from '../types.ts'
import { AnnouncementError, createAnnouncement, expiresAt, openAnnouncement } from './announcement.ts'
import type { Announcement } from './announcement.ts'
import { openDescriptor } from './conference-records.ts'
import type { ConferenceDescriptor } from './conference-records.ts'
import { OpenInterests, SeenAnnouncements } from './interests.ts'
import type { OpenInterest, OpenInterestsOptions } from './interests.ts'
import { DiscoveryPacket } from './proto/discovery.ts'
import { encodeContact, openContact } from './contact.ts'
import { announceTopic } from './topics.ts'
import { compareCandidates, matchTier, resolveThresholds } from '../embed/match.ts'
import { similarity } from '../embed/vector.ts'
import type { Discovery } from './discovery.ts'
import { type MatchCommon, type MatchFound, type MatchRecord, recordVector, recordExpiry, type DiscoveryOptions, hex, unhex } from './discovery-types.ts'
import { notifyOrBuffer, scheduleExpiry } from './discovery-windows.ts'

export async function onGossip (self: Discovery, event: GossipEvent): Promise<'accept' | 'reject' | 'ignore'> {
  if (!self.running) return 'ignore'
  const gen = self.generation
  const profile = self.embedder.profile()
  let thresholds: Record<number, number>
  try {
    thresholds = resolveThresholds(profile, self.localThresholds)
  } catch {
    return 'reject'
  }
  const now = self.now()
  let announcement: Announcement
  try {
    announcement = await openAnnouncement(event.data, {
      profile: ns => ns === profile.id ? profile : undefined,
      verify: (peer, data, sig) => self.transport.verify(peer, data, sig),
      now
    })
  } catch (error) {
    if (error instanceof AnnouncementError && (error.fault === 'unknown_namespace' || error.fault === 'expired')) return 'ignore'
    return 'reject'
  }
  // A stop, or a stop and start, during the await leaves no state behind (Section 2.2).
  if (!self.running || gen !== self.generation) return 'ignore'
  // The transport authenticated event.origin as the publisher (Section 10.1).
  if (announcement.origin !== event.origin) return 'reject'
  const addrs = openContact(announcement.contact, announcement.origin)
  if (addrs === undefined) return 'reject'
  // Own announcements are seen but never matched (Section 4.3).
  if (announcement.origin === self.transport.info().peerId) return 'accept'
  if (self.seen.has(announcement.id)) return 'ignore'
  if (!countAccept(self, announcement.origin, now)) return 'ignore'
  self.seen.add(announcement.id, expiresAt(announcement))
  // Answer without holding the validator (Section 11.2).
  void respond(self, announcement, addrs, profile.id, thresholds).catch(() => {})
  return 'accept'
}

export function countAccept (self: Discovery, origin: PeerId, now: number): boolean {
  const windowStart = now - 60000
  const kept = (self.originTimes.get(origin) ?? []).filter(t => t > windowStart)
  if (kept.length >= self.announcementsPerOriginPerMinute) {
    if (kept.length === 0) self.originTimes.delete(origin)
    else self.originTimes.set(origin, kept)
    return false
  }
  kept.push(now)
  // Forgetting timestamps older than 60 s keeps entries bounded (Section 10.7).
  for (const [peer, times] of self.originTimes) {
    if (peer === origin) continue
    const live = times.filter(t => t > windowStart)
    if (live.length === 0) self.originTimes.delete(peer)
    else if (live.length !== times.length) self.originTimes.set(peer, live)
  }
  if (!self.originTimes.has(origin) && self.originTimes.size >= 1024) {
    let oldestPeer: string | undefined
    let oldestTime = Infinity
    for (const [peer, times] of self.originTimes) {
      const last = times[times.length - 1] ?? -Infinity
      if (last < oldestTime) {
        oldestTime = last
        oldestPeer = peer
      }
    }
    if (oldestPeer !== undefined) self.originTimes.delete(oldestPeer)
  }
  self.originTimes.set(origin, kept)
  return true
}

export async function respond (self: Discovery, announcement: Announcement, addrs: string[], namespace: string, thresholds: Record<number, number>): Promise<void> {
  if (!self.running) return
  const profile = self.embedder.profile()
  const rooms = self.conferences().filter(room => room.descriptor.namespace === namespace && room.descriptor.expiresAt > self.now())
  const hostedIds = new Set(rooms.map(room => room.descriptor.id))
  const candidates: (MatchRecord & { bytes: Uint8Array })[] = [
    ...self.registry.list().filter(interest => interest.announcement.namespace === namespace && !hostedIds.has(interest.id))
      .map(interest => ({ kind: 'interest' as const, record: interest.announcement, bytes: interest.bytes })),
    ...rooms.map(room => ({ kind: 'conference' as const, record: room.descriptor, bytes: room.bytes }))
  ]
  const ranked: Array<MatchRecord & { bytes: Uint8Array, tier: Tier, fullScore: number }> = []
  for (const candidate of candidates) {
    let tier: Tier | null
    try {
      tier = matchTier(announcement.vector, recordVector(candidate), profile, thresholds)
    } catch {
      continue
    }
    if (tier === null) continue
    ranked.push({ ...candidate, tier, fullScore: similarity(announcement.vector, recordVector(candidate), profile.dims[0]) })
  }
  ranked.sort((a, b) => compareCandidates(a, b))
  const best = ranked.slice(0, self.maxResultsPerAnnouncement)
  if (best.length === 0) return
  let idBytes: Uint8Array
  try {
    idBytes = unhex(announcement.id)
  } catch {
    return
  }
  if (idBytes.length !== 16) return
  const encoded = DiscoveryPacket.encode({
    results: best.map(candidate => ({
      announcementId: idBytes,
      record: candidate.kind === 'interest' ? candidate.bytes : new Uint8Array(0),
      conference: candidate.kind === 'conference' ? candidate.bytes : new Uint8Array(0),
      tier: candidate.tier.tier === 'exact' ? 0 : candidate.tier.tier,
      score: candidate.tier.score
    }))
  })
  const packet = new Uint8Array(1 + encoded.length)
  packet[0] = 0
  packet.set(encoded, 1)
  if (!self.running) return
  try {
    await self.transport.send(announcement.origin, packet, addrs)
  } catch {
    // A send failure is swallowed (Section 11.2).
  }
}

export async function onDirectEvent (self: Discovery, event: { from: PeerId, data: Uint8Array }): Promise<void> {
  if (!self.running) return
  const gen = self.generation
  const data = event.data
  if (data.length === 0 || data[0] !== 0) return
  const profile = self.embedder.profile()
  let thresholds: Record<number, number>
  try {
    thresholds = resolveThresholds(profile, self.localThresholds)
  } catch {
    return
  }
  let results: Array<{ announcementId: Uint8Array, record: Uint8Array, conference: Uint8Array }>
  try {
    const packet = DiscoveryPacket.decode(data.slice(1))
    results = packet.results
  } catch {
    return
  }
  if (results.length === 0 || results.length > self.maxResultsPerAnnouncement) return
  const selfId = self.transport.info().peerId
  const now = self.now()
  for (const result of results) {
    try {
      if (result.announcementId.length !== 16) continue
      const interest = self.registry.get(hex(result.announcementId))
      if (interest === undefined) continue
      if ((result.record.length > 0) === (result.conference.length > 0)) continue
      const options = {
        profile: (ns: string) => ns === profile.id ? profile : undefined,
        verify: (peer: PeerId, signed: Uint8Array, sig: Uint8Array) => self.transport.verify(peer, signed, sig),
        now
      }
      const candidate: MatchRecord = result.conference.length > 0
        ? { kind: 'conference', record: await openDescriptor(result.conference, options) }
        : { kind: 'interest', record: await openAnnouncement(result.record, options) }
      const record = candidate.record
      // A stop, or a stop and start, during the await stores nothing.
      if (!self.running || gen !== self.generation) return
      const peer = candidate.kind === 'interest' ? candidate.record.origin : candidate.record.host
      // Only the authenticated origin or host may answer for this record (Section 10.6).
      if (peer !== event.from || peer === selfId) continue
      if (record.namespace !== interest.announcement.namespace) continue
      const addrs = candidate.kind === 'interest' ? openContact(candidate.record.contact, peer) : candidate.record.addrs
      if (addrs === undefined) continue
      const tier = matchTier(interest.announcement.vector, recordVector(candidate), profile, thresholds)
      if (tier === null) continue
      const fullScore = similarity(interest.announcement.vector, recordVector(candidate), profile.dims[0])
      if (!self.running) return
      // The interest may have been withdrawn or expired while the record was being verified.
      if (self.registry.get(interest.id) !== interest) continue
      // Stale kept matches hold no slot: prune them before the duplicate check and caps (Section 5.3).
      const pruneNow = self.now()
      const held = self.matchesByInterest.get(interest.id) ?? []
      const kept = held.filter(match => recordExpiry(match) > pruneNow)
      if (kept.length !== held.length) {
        if (kept.length === 0) self.matchesByInterest.delete(interest.id)
        else self.matchesByInterest.set(interest.id, kept)
      }
      if (recordExpiry(candidate) <= pruneNow) continue
      // An explicit handle already retained cannot be redirected by another signed host.
      if (kept.some(match => match.record.id === record.id && match.peer !== peer)) continue
      const previous = kept.find(match => match.kind === candidate.kind && match.record.id === record.id)
      if (previous !== undefined && candidate.kind === 'interest') continue
      // Once a room is known, a replay of its forming interest cannot downgrade it.
      if (candidate.kind === 'interest' && kept.some(match => match.kind === 'conference' && match.record.id === record.id)) continue
      if (previous?.kind === 'conference' && candidate.kind === 'conference' &&
        (candidate.record.createdAt !== previous.record.createdAt || candidate.record.revision <= previous.record.revision)) continue
      const match: MatchFound = {
        ...candidate,
        interest: interest.id,
        session: interest.session,
        peer,
        addrs,
        tier,
        fullScore
      }
      const remaining = kept.filter(m => !(m.record.id === record.id && (m.kind === candidate.kind || candidate.kind === 'conference')))
      // Rank within the peer's own share first then the whole list, so a better
      // record from the same peer displaces its weaker one (Sections 5.3 and 11.2).
      const withNew = [...remaining, match]
      const peerBest = withNew.filter(m => m.peer === peer)
        .sort((a, b) => compareCandidates(a, b)).slice(0, self.maxResultsPerAnnouncement)
      const rest = withNew.filter(m => m.peer !== peer)
      const next = [...rest, ...peerBest]
        .sort((a, b) => compareCandidates(a, b)).slice(0, self.maxMatchesPerInterest)
      self.matchesByInterest.set(interest.id, next)
      scheduleExpiry(self)
      if (next.includes(match) && previous === undefined) {
        notifyOrBuffer(self, interest.id, match, gen)
      }
    } catch {
      // One bad result never stops the rest: peer content is untrusted (Section 10.5).
      continue
    }
  }
}

