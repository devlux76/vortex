/**
 * The discovery loop of spec section 11.2 for open interests and hosted conferences.
 * Nothing here imports a Node built-in: the core runs in browsers.
 */

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
export * from './discovery-types.ts'
import { type MatchCommon, type MatchFound, type MatchRecord, recordVector, recordExpiry, type DiscoveryOptions, hex, unhex } from './discovery-types.ts'
import { start, stop, announce, withdraw, endSession, interests, matches } from './discovery-api.ts'
import { notifyOrBuffer, flushWindow, clearWindow, suspendWindow, resumeWindow, dropDeadMatches, scheduleExpiry } from './discovery-windows.ts'
import { onGossip, countAccept, respond, onDirectEvent } from './discovery-wire.ts'

export class Discovery {
  transport: Transport
  embedder: Embedder
  onMatch: (match: MatchFound) => void
  localThresholds: Record<number, number>
  checkOutbound: (statement: string) => void | Promise<void>
  now: () => number
  defaultTtl: number
  maxResultsPerAnnouncement: number
  maxMatchesPerInterest: number
  announcementsPerOriginPerMinute: number
  matchWindowMs: number
  windowTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Fixed flush deadlines (wall clock) for open windows, alongside the timers. */
  windowDeadlines = new Map<string, number>()
  /** Record ids already notified per interest, so batches notify once each. */
  announced = new Map<string, Set<string>>()
  /**
   * Suspended windows of interests replaced mid-announcement: timer and told
   * set stashed with the original fixed deadline, restored only if the
   * replacement publish fails while the old run still holds.
   */
  suspendedWindows = new Map<string, { deadline?: number, told: Set<string>, session?: string }>()
  conferences: NonNullable<DiscoveryOptions['conferences']>
  registry: OpenInterests
  seen = new SeenAnnouncements()
  matchesByInterest = new Map<string, MatchFound[]>()
  originTimes = new Map<string, number[]>()
  topic: string | undefined
  removeDirect: (() => void) | undefined
  announcing = new Set<{ session: string, cancelled: boolean }>()
  expiryTimer: ReturnType<typeof setTimeout> | undefined
  running = false
  /** Bumped on every start, so work begun under an old run never lands after a restart. */
  generation = 0

  constructor (options: DiscoveryOptions) {
    const maxResults = options.maxResultsPerAnnouncement ?? 3
    const maxMatches = options.maxMatchesPerInterest ?? 8
    const perOrigin = options.announcementsPerOriginPerMinute ?? 6
    const ttl = options.defaultTtl ?? 300
    const windowMs = options.matchWindowMs ?? 500
    if (!(maxResults >= 1)) throw new Error('maxResultsPerAnnouncement must be at least 1')
    if (!(maxMatches >= 1)) throw new Error('maxMatchesPerInterest must be at least 1')
    if (!(perOrigin >= 1)) throw new Error('announcementsPerOriginPerMinute must be at least 1')
    if (!(ttl >= 1)) throw new Error('defaultTtl must be at least 1')
    if (!Number.isInteger(windowMs) || windowMs < 0 || windowMs > 60000) {
      throw new Error('matchWindowMs must be an integer from 0 to 60000')
    }
    this.transport = options.transport
    this.embedder = options.embedder
    this.onMatch = options.onMatch
    this.localThresholds = options.thresholds ?? {}
    this.checkOutbound = options.checkOutbound ?? ((): void => {})
    this.now = options.now ?? Date.now
    this.defaultTtl = ttl
    this.maxResultsPerAnnouncement = maxResults
    this.maxMatchesPerInterest = maxMatches
    this.announcementsPerOriginPerMinute = perOrigin
    this.matchWindowMs = windowMs
    this.conferences = options.conferences ?? (() => [])
    this.registry = new OpenInterests({ ...options.interests, now: options.interests?.now ?? this.now })
    // SeenAnnouncements keeps its own clock; align it with the injected one.
    this.seen = new SeenAnnouncements({ now: this.now })
  }

  /** Subscribes to the profile's topic and to direct packets. The transport must already be started. */
  async start (): Promise<void> {
    return start(this)
  }

  async stop (): Promise<void> {
    return stop(this)
  }

  async announce (request: { session: string, statement: string, ttl?: number, publishStatement?: boolean, replaces?: string }): Promise<string> {
    return announce(this, request)
  }

  /**
   * Notify for a newly retained match: at once with a zero window, otherwise
   * open a fixed collection window for the interest. Later arrivals never
   * extend the deadline, so stronger latecomers displace weaker ones before
   * any callback, and a second batch opens only after the first flushes.
   */
  private notifyOrBuffer (id: string, match: MatchFound, generation: number): void {
    return notifyOrBuffer(this, id, match, generation)
  }

  /**
   * Emit one callback per still-retained, never-notified handle, in current
   * ranked order and with current metadata. Lifecycle is rechecked before
   * every callback, so reentrant withdrawal, session end or stop drops the
   * rest silently; callback errors stay isolated as on the immediate path.
   */
  private flushWindow (id: string, generation: number): void {
    return flushWindow(this, id, generation)
  }
  private clearWindow (id: string): void {
    return clearWindow(this, id)
  }

  /**
   * Stash an open window before a replacement transaction removes its
   * interest. The fixed deadline travels with it when a timer is open; a
   * flushed batch with only told state is stashed without a deadline and
   * resumes without opening a new timer. Called after the synchronous
   * registry.add succeeds, so a rejected registration never mutates the
   * original window and no JS timer can interleave in between.
   */
  private suspendWindow (id: string, session?: string): void {
    return suspendWindow(this, id, session)
  }

  /**
   * Resume a suspended window after an eligible rollback: the old told set
   * returns pruned to still-live handles, and the original fixed deadline
   * resumes only when a timer was actually open, flushing promptly when it
   * already elapsed. Skipped when the interest is gone, withdrawn, expired
   * or from another run.
   */
  private resumeWindow (id: string, generation: number): void {
    return resumeWindow(this, id, generation)
  }

  /** Forgets the matches of interests that are no longer live, so expired interests leave nothing behind. */
  private dropDeadMatches (): void {
    return dropDeadMatches(this)
  }

  /** One timer releases idle interests and results at their earliest expiry. */
  private scheduleExpiry (): void {
    return scheduleExpiry(this)
  }

  withdraw (session: string, id: string): boolean {
    return withdraw(this, session, id)
  }

  endSession (session: string): string[] {
    return endSession(this, session)
  }

  interests (session?: string): OpenInterest[] {
    return interests(this, session)
  }

  /** Matches kept for one of this service's interests, best first. Empty for an unknown or expired id. */
  matches (id: string): MatchFound[] {
    return matches(this, id)
  }

  /** Topic validator and delivery point (Section 2.2). */
  private async onGossip (event: GossipEvent): Promise<'accept' | 'reject' | 'ignore'> {
    return onGossip(this, event)
  }

  /**
   * Count one accepted announcement from an origin for the rate limit.
   * False when the origin is already at its limit (Section 2.2).
   */
  private countAccept (origin: PeerId, now: number): boolean {
    return countAccept(this, origin, now)
  }

  /** Answer an accepted announcement with the best local open interests (Section 11.2). */
  private async respond (announcement: Announcement, addrs: string[], namespace: string, thresholds: Record<number, number>): Promise<void> {
    return respond(this, announcement, addrs, namespace, thresholds)
  }

  /** Direct entry point: returns at once, work happens in the background. */
  private async onDirectEvent (event: { from: PeerId, data: Uint8Array }): Promise<void> {
    return onDirectEvent(this, event)
  }
}
