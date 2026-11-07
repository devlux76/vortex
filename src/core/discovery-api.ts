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
import { onGossip, onDirectEvent } from './discovery-wire.ts'
import { clearWindow, suspendWindow, resumeWindow, scheduleExpiry } from './discovery-windows.ts'

export async function start (self: Discovery): Promise<void> {
  if (self.running) throw new Error('discovery already started')
  self.generation++
  const profile = self.embedder.profile()
  // Throws when local thresholds do not fit the profile (Section 5.2).
  resolveThresholds(profile, self.localThresholds)
  const topic = announceTopic(profile.id)
  await self.transport.subscribe(topic, event => onGossip(self, event))
  self.topic = topic
  self.removeDirect = self.transport.onDirect(event => {
    onDirectEvent(self, event).catch(() => {})
  })
  self.running = true
}

export async function stop (self: Discovery): Promise<void> {
  if (!self.running) return
  self.running = false
  clearTimeout(self.expiryTimer)
  self.expiryTimer = undefined
  for (const timer of self.windowTimers.values()) clearTimeout(timer)
  self.windowTimers.clear()
  self.windowDeadlines.clear()
  self.announced.clear()
  self.suspendedWindows.clear()
  const topic = self.topic
  self.topic = undefined
  const remove = self.removeDirect
  self.removeDirect = undefined
  if (remove !== undefined) remove()
  for (const interest of self.registry.list()) self.registry.withdraw(interest.session, interest.id)
  self.matchesByInterest.clear()
  if (topic !== undefined) await self.transport.unsubscribe(topic)
}

export async function announce (self: Discovery, request: { session: string, statement: string, ttl?: number, publishStatement?: boolean, replaces?: string }): Promise<string> {
  request = { ...request }
  const generation = self.generation
  const pending = { session: request.session, cancelled: false }
  const checkCurrent = (): void => {
    if (!self.running || generation !== self.generation) throw new Error('discovery stopped during announcement')
    if (pending.cancelled) throw new Error('announcement session ended')
  }
  checkCurrent()
  self.announcing.add(pending)
  try {
    await self.checkOutbound(request.statement)
    checkCurrent()
    const profile = self.embedder.profile()
    const vector = await self.embedder.embed(request.statement)
    checkCurrent()
    const info = self.transport.info()
    const contact = encodeContact(info.addrs)
    const { announcement, bytes } = await createAnnouncement({
      profile,
      vector,
      origin: info.peerId,
      contact,
      ttl: request.ttl ?? self.defaultTtl,
      statement: request.publishStatement === true ? request.statement : undefined,
      sign: data => self.transport.sign(data),
      now: self.now()
    })
    checkCurrent()
    const replaces = request.replaces
    const replaced = replaces === undefined ? undefined : self.registry.get(replaces)
    const replacedMatches = replaces === undefined ? undefined : self.matchesByInterest.get(replaces)
    self.registry.add({ session: request.session, announcement, bytes, statement: request.statement, replaces })
    // Only the transaction that actually captured a live original owns its
    // old window: a concurrent announce naming an already-replaced id is a
    // fresh announce and must not suspend or steal the holder's state.
    if (replaced !== undefined) suspendWindow(self, replaces as string, request.session)
    scheduleExpiry(self)
    try {
      await self.transport.publish(announceTopic(profile.id), bytes)
      checkCurrent()
      if (self.registry.get(announcement.id) === undefined) throw new Error('announcement no longer held')
    } catch (error) {
      // Restore a failed replacement only while its run and session still hold it.
      const stillHeld = self.registry.get(announcement.id) !== undefined
      self.registry.withdraw(request.session, announcement.id)
      self.matchesByInterest.delete(announcement.id)
      clearWindow(self, announcement.id)
      if (stillHeld && !pending.cancelled && self.running && generation === self.generation && replaced !== undefined && replaced.session === request.session) {
        try {
          self.registry.add({ session: replaced.session, announcement: replaced.announcement, bytes: replaced.bytes, statement: replaced.statement })
          if (replacedMatches !== undefined) self.matchesByInterest.set(replaced.id, replacedMatches)
        } catch { /* It expired in the meantime. */ }
        if (replaced !== undefined) resumeWindow(self, replaces as string, generation)
      } else if (replaced !== undefined) {
        self.suspendedWindows.delete(replaces as string)
      }
      scheduleExpiry(self)
      throw error
    }
    // Only the captor of a live original clears its old matches and window;
    // a fresh announce that named an absent id leaves them to their owner.
    if (replaced !== undefined) {
      self.matchesByInterest.delete(replaces as string)
      clearWindow(self, replaces as string)
      self.suspendedWindows.delete(replaces as string)
    }
    scheduleExpiry(self)
    return announcement.id
  } finally {
    self.announcing.delete(pending)
  }
}

export function withdraw (self: Discovery, session: string, id: string): boolean {
  const removed = self.registry.withdraw(session, id)
  if (removed) {
    self.matchesByInterest.delete(id)
    clearWindow(self, id)
  }
  scheduleExpiry(self)
  return removed
}

export function endSession (self: Discovery, session: string): string[] {
  for (const pending of self.announcing) {
    if (pending.session === session) pending.cancelled = true
  }
  const ended = self.registry.endSession(session)
  for (const id of ended) {
    self.matchesByInterest.delete(id)
    clearWindow(self, id)
  }
  // An in-flight replacement already removed its original interest from
  // the registry, so it is not in `ended`: release its dormant suspended
  // state now instead of leaving a timer/record leak while publish stays
  // blocked. The later rollback stays guarded and cleans anything missed.
  for (const [id, suspended] of [...self.suspendedWindows]) {
    const owner = suspended.session ?? self.matchesByInterest.get(id)?.[0]?.session
    if (owner !== session) continue
    self.suspendedWindows.delete(id)
    self.matchesByInterest.delete(id)
    self.announced.delete(id)
    const timer = self.windowTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      self.windowTimers.delete(id)
    }
    self.windowDeadlines.delete(id)
  }
  scheduleExpiry(self)
  return ended
}

export function interests (self: Discovery, session?: string): OpenInterest[] {
  return self.registry.list(session)
}

export function matches (self: Discovery, id: string): MatchFound[] {
  const interest = self.registry.get(id)
  if (interest === undefined) {
    self.matchesByInterest.delete(id)
    return []
  }
  const kept = self.matchesByInterest.get(id) ?? []
  const now = self.now()
  const live = kept.filter(match => recordExpiry(match) > now)
  if (live.length !== kept.length) {
    if (live.length === 0) self.matchesByInterest.delete(id)
    else self.matchesByInterest.set(id, live)
  }
  return [...live]
}

