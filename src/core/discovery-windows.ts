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

export function notifyOrBuffer (self: Discovery, id: string, match: MatchFound, generation: number): void {
  if (self.matchWindowMs <= 0) {
    try {
      self.onMatch(match)
    } catch {
      // A throwing onMatch is caught and ignored.
    }
    return
  }
  if (self.windowTimers.has(id)) return
  const deadline = Date.now() + self.matchWindowMs
  const timer = setTimeout(() => {
    self.windowTimers.delete(id)
    self.windowDeadlines.delete(id)
    flushWindow(self, id, generation)
  }, self.matchWindowMs)
  // Node/Bun must not stay alive for a pending batch; browsers return a numeric handle.
  if (typeof timer === 'object') timer.unref()
  self.windowTimers.set(id, timer)
  self.windowDeadlines.set(id, deadline)
}

export function flushWindow (self: Discovery, id: string, generation: number): void {
  if (!self.running || generation !== self.generation) return
  if (self.registry.get(id) === undefined) {
    self.announced.delete(id)
    return
  }
  const now = self.now()
  const kept = (self.matchesByInterest.get(id) ?? []).filter(match => recordExpiry(match) > now)
  let told = self.announced.get(id)
  if (told === undefined) {
    told = new Set<string>()
    self.announced.set(id, told)
  }
  for (const match of kept) {
    if (!self.running || generation !== self.generation) return
    if (self.registry.get(id) === undefined) {
      self.announced.delete(id)
      return
    }
    const current = (self.matchesByInterest.get(id) ?? []).find(candidate => candidate.record.id === match.record.id)
    if (current === undefined || told.has(match.record.id)) continue
    told.add(match.record.id)
    try {
      self.onMatch(current)
    } catch {
      // A throwing onMatch is caught and ignored.
    }
  }
  for (const toldId of [...told]) {
    if (!kept.some(match => match.record.id === toldId)) told.delete(toldId)
  }
  if (told.size === 0) self.announced.delete(id)
}

export function clearWindow (self: Discovery, id: string): void {
  const timer = self.windowTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    self.windowTimers.delete(id)
  }
  self.windowDeadlines.delete(id)
  self.announced.delete(id)
  self.suspendedWindows.delete(id)
}

export function suspendWindow (self: Discovery, id: string, session?: string): void {
  if (self.suspendedWindows.has(id)) return
  const timer = self.windowTimers.get(id)
  const told = self.announced.get(id)
  if (timer === undefined && (told === undefined || told.size === 0)) return
  let deadline: number | undefined
  if (timer !== undefined) {
    clearTimeout(timer)
    self.windowTimers.delete(id)
    deadline = self.windowDeadlines.get(id) ?? Date.now()
    self.windowDeadlines.delete(id)
  }
  self.announced.delete(id)
  if (deadline === undefined) self.suspendedWindows.set(id, { told: told ?? new Set<string>(), session })
  else self.suspendedWindows.set(id, { deadline, told: told ?? new Set<string>(), session })
}

export function resumeWindow (self: Discovery, id: string, generation: number): void {
  const suspended = self.suspendedWindows.get(id)
  if (suspended === undefined) return
  self.suspendedWindows.delete(id)
  if (!self.running || generation !== self.generation) return
  const live = self.registry.get(id)
  if (live === undefined || live.expires <= self.now()) return
  const liveIds = new Set((self.matchesByInterest.get(id) ?? []).map(match => match.record.id))
  for (const toldId of [...suspended.told]) {
    if (!liveIds.has(toldId)) suspended.told.delete(toldId)
  }
  if (suspended.told.size > 0) self.announced.set(id, suspended.told)
  if (suspended.deadline === undefined) return
  const timer = setTimeout(() => {
    self.windowTimers.delete(id)
    self.windowDeadlines.delete(id)
    flushWindow(self, id, generation)
  }, Math.max(0, suspended.deadline - Date.now()))
  if (typeof timer === 'object') timer.unref()
  self.windowTimers.set(id, timer)
  self.windowDeadlines.set(id, suspended.deadline)
}

export function dropDeadMatches (self: Discovery): void {
  const now = self.now()
  for (const [id, matches] of self.matchesByInterest) {
    if (self.registry.get(id) === undefined) {
      // A suspended replacement window owns this id until its transaction
      // resolves; the success and failure paths handle it from there.
      if (self.suspendedWindows.has(id)) continue
      self.matchesByInterest.delete(id)
      clearWindow(self, id)
    }
    else {
      const live = matches.filter(match => recordExpiry(match) > now)
      if (live.length === 0) self.matchesByInterest.delete(id)
      else if (live.length !== matches.length) self.matchesByInterest.set(id, live)
      const told = self.announced.get(id)
      if (told !== undefined) {
        for (const toldId of [...told]) {
          if (!live.some(match => match.record.id === toldId)) told.delete(toldId)
        }
        if (told.size === 0) self.announced.delete(id)
      }
    }
  }
}

export function scheduleExpiry (self: Discovery): void {
  clearTimeout(self.expiryTimer)
  self.expiryTimer = undefined
  if (!self.running) return
  self.registry.sweep()
  dropDeadMatches(self)
  let next = self.registry.nextExpiry()
  for (const [id, matches] of self.matchesByInterest) {
    // A suspended replacement window is owned by its transaction until
    // rollback or flush revalidates expiry; scheduling its past deadline
    // would spin zero-delay callbacks while publication is blocked.
    if (self.suspendedWindows.has(id)) continue
    for (const match of matches) next = Math.min(next ?? Infinity, recordExpiry(match))
  }
  if (next === undefined) return
  self.expiryTimer = setTimeout(() => scheduleExpiry(self), Math.max(0, next - self.now()))
  // Node/Bun must not stay alive for an interest; browsers return a numeric handle.
  if (typeof self.expiryTimer === 'object') self.expiryTimer.unref()
}

