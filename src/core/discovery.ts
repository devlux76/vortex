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

/** A record another service holds that matches one of this service's open interests. */
interface MatchCommon {
  /** This service's announcement id that was answered. */
  interest: string
  /** The local agent session holding that interest. */
  session: string
  /** The responder. Equal to the record's origin or host. */
  peer: PeerId
  /** Where the responder can be dialed, from the record's contact. */
  addrs: string[]
  /** Recomputed here from the record's vector; the responder's claim is not used. */
  tier: Tier
  /** Cosine similarity at the profile's full length, computed here. */
  fullScore: number
}

export type MatchFound = MatchCommon & (
  | { kind: 'interest', record: Announcement }
  | { kind: 'conference', record: ConferenceDescriptor }
)

type MatchRecord = { kind: 'interest', record: Announcement } | { kind: 'conference', record: ConferenceDescriptor }

function recordVector (match: MatchRecord): Float32Array {
  return match.kind === 'interest' ? match.record.vector : match.record.topicVector
}

function recordExpiry (match: MatchRecord): number {
  return match.kind === 'interest' ? expiresAt(match.record) : match.record.expiresAt
}

export interface DiscoveryOptions {
  transport: Transport
  embedder: Embedder
  /** Called once for each match newly retained. */
  onMatch: (match: MatchFound) => void
  /** Local thresholds laid over the profile's defaults (resolveThresholds). */
  thresholds?: Record<number, number>
  /** Disclosure policy hook: throws to refuse a statement. Default allows everything. */
  checkOutbound?: (statement: string) => void | Promise<void>
  now?: () => number
  /** Seconds. Default 300. */
  defaultTtl?: number
  /** Most records this service returns for one announcement. Default 3. */
  maxResultsPerAnnouncement?: number
  /** Most matches kept for one of its own interests. Default 8. */
  maxMatchesPerInterest?: number
  /** Most announcements accepted from one origin in any 60 seconds. Default 6. */
  announcementsPerOriginPerMinute?: number
  /**
   * Milliseconds to collect newly retained matches before notifying, so a
   * stronger arrival can displace a weaker one before any callback. Integer
   * 0 to 60000, default 500. Zero keeps immediate callbacks.
   */
  matchWindowMs?: number
  /** Already signed public metadata for locally hosted conferences. */
  conferences?: () => { descriptor: ConferenceDescriptor, bytes: Uint8Array }[]
  interests?: OpenInterestsOptions
}

/** Hex of bytes, lowercase (Section 4.2). */
function hex (bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Raw bytes of 32 hex characters. Throws on bad input. */
function unhex (text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('not lowercase hexadecimal')
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

export class Discovery {
  private transport: Transport
  private embedder: Embedder
  private onMatch: (match: MatchFound) => void
  private localThresholds: Record<number, number>
  private checkOutbound: (statement: string) => void | Promise<void>
  private now: () => number
  private defaultTtl: number
  private maxResultsPerAnnouncement: number
  private maxMatchesPerInterest: number
  private announcementsPerOriginPerMinute: number
  private matchWindowMs: number
  private windowTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Fixed flush deadlines (wall clock) for open windows, alongside the timers. */
  private windowDeadlines = new Map<string, number>()
  /** Record ids already notified per interest, so batches notify once each. */
  private announced = new Map<string, Set<string>>()
  /**
   * Suspended windows of interests replaced mid-announcement: timer and told
   * set stashed with the original fixed deadline, restored only if the
   * replacement publish fails while the old run still holds.
   */
  private suspendedWindows = new Map<string, { deadline?: number, told: Set<string>, session?: string }>()
  private conferences: NonNullable<DiscoveryOptions['conferences']>
  private registry: OpenInterests
  private seen = new SeenAnnouncements()
  private matchesByInterest = new Map<string, MatchFound[]>()
  private originTimes = new Map<string, number[]>()
  private topic: string | undefined
  private removeDirect: (() => void) | undefined
  private announcing = new Set<{ session: string, cancelled: boolean }>()
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  /** Bumped on every start, so work begun under an old run never lands after a restart. */
  private generation = 0

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
    if (this.running) throw new Error('discovery already started')
    this.generation++
    const profile = this.embedder.profile()
    // Throws when local thresholds do not fit the profile (Section 5.2).
    resolveThresholds(profile, this.localThresholds)
    const topic = announceTopic(profile.id)
    await this.transport.subscribe(topic, event => this.onGossip(event))
    this.topic = topic
    this.removeDirect = this.transport.onDirect(event => {
      this.onDirectEvent(event).catch(() => {})
    })
    this.running = true
  }

  async stop (): Promise<void> {
    if (!this.running) return
    this.running = false
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    for (const timer of this.windowTimers.values()) clearTimeout(timer)
    this.windowTimers.clear()
    this.windowDeadlines.clear()
    this.announced.clear()
    this.suspendedWindows.clear()
    const topic = this.topic
    this.topic = undefined
    const remove = this.removeDirect
    this.removeDirect = undefined
    if (remove !== undefined) remove()
    for (const interest of this.registry.list()) this.registry.withdraw(interest.session, interest.id)
    this.matchesByInterest.clear()
    if (topic !== undefined) await this.transport.unsubscribe(topic)
  }

  async announce (request: { session: string, statement: string, ttl?: number, publishStatement?: boolean, replaces?: string }): Promise<string> {
    request = { ...request }
    const generation = this.generation
    const pending = { session: request.session, cancelled: false }
    const checkCurrent = (): void => {
      if (!this.running || generation !== this.generation) throw new Error('discovery stopped during announcement')
      if (pending.cancelled) throw new Error('announcement session ended')
    }
    checkCurrent()
    this.announcing.add(pending)
    try {
      await this.checkOutbound(request.statement)
      checkCurrent()
      const profile = this.embedder.profile()
      const vector = await this.embedder.embed(request.statement)
      checkCurrent()
      const info = this.transport.info()
      const contact = encodeContact(info.addrs)
      const { announcement, bytes } = await createAnnouncement({
        profile,
        vector,
        origin: info.peerId,
        contact,
        ttl: request.ttl ?? this.defaultTtl,
        statement: request.publishStatement === true ? request.statement : undefined,
        sign: data => this.transport.sign(data),
        now: this.now()
      })
      checkCurrent()
      const replaces = request.replaces
      const replaced = replaces === undefined ? undefined : this.registry.get(replaces)
      const replacedMatches = replaces === undefined ? undefined : this.matchesByInterest.get(replaces)
      this.registry.add({ session: request.session, announcement, bytes, statement: request.statement, replaces })
      // Only the transaction that actually captured a live original owns its
      // old window: a concurrent announce naming an already-replaced id is a
      // fresh announce and must not suspend or steal the holder's state.
      if (replaced !== undefined) this.suspendWindow(replaces as string, request.session)
      this.scheduleExpiry()
      try {
        await this.transport.publish(announceTopic(profile.id), bytes)
        checkCurrent()
        if (this.registry.get(announcement.id) === undefined) throw new Error('announcement no longer held')
      } catch (error) {
        // Restore a failed replacement only while its run and session still hold it.
        const stillHeld = this.registry.get(announcement.id) !== undefined
        this.registry.withdraw(request.session, announcement.id)
        this.matchesByInterest.delete(announcement.id)
        this.clearWindow(announcement.id)
        if (stillHeld && !pending.cancelled && this.running && generation === this.generation && replaced !== undefined && replaced.session === request.session) {
          try {
            this.registry.add({ session: replaced.session, announcement: replaced.announcement, bytes: replaced.bytes, statement: replaced.statement })
            if (replacedMatches !== undefined) this.matchesByInterest.set(replaced.id, replacedMatches)
          } catch { /* It expired in the meantime. */ }
          if (replaced !== undefined) this.resumeWindow(replaces as string, generation)
        } else if (replaced !== undefined) {
          this.suspendedWindows.delete(replaces as string)
        }
        this.scheduleExpiry()
        throw error
      }
      // Only the captor of a live original clears its old matches and window;
      // a fresh announce that named an absent id leaves them to their owner.
      if (replaced !== undefined) {
        this.matchesByInterest.delete(replaces as string)
        this.clearWindow(replaces as string)
        this.suspendedWindows.delete(replaces as string)
      }
      this.scheduleExpiry()
      return announcement.id
    } finally {
      this.announcing.delete(pending)
    }
  }

  /**
   * Notify for a newly retained match: at once with a zero window, otherwise
   * open a fixed collection window for the interest. Later arrivals never
   * extend the deadline, so stronger latecomers displace weaker ones before
   * any callback, and a second batch opens only after the first flushes.
   */
  private notifyOrBuffer (id: string, match: MatchFound, generation: number): void {
    if (this.matchWindowMs <= 0) {
      try {
        this.onMatch(match)
      } catch {
        // A throwing onMatch is caught and ignored.
      }
      return
    }
    if (this.windowTimers.has(id)) return
    const deadline = Date.now() + this.matchWindowMs
    const timer = setTimeout(() => {
      this.windowTimers.delete(id)
      this.windowDeadlines.delete(id)
      this.flushWindow(id, generation)
    }, this.matchWindowMs)
    // Node/Bun must not stay alive for a pending batch; browsers return a numeric handle.
    if (typeof timer === 'object') timer.unref()
    this.windowTimers.set(id, timer)
    this.windowDeadlines.set(id, deadline)
  }

  /**
   * Emit one callback per still-retained, never-notified handle, in current
   * ranked order and with current metadata. Lifecycle is rechecked before
   * every callback, so reentrant withdrawal, session end or stop drops the
   * rest silently; callback errors stay isolated as on the immediate path.
   */
  private flushWindow (id: string, generation: number): void {
    if (!this.running || generation !== this.generation) return
    if (this.registry.get(id) === undefined) {
      this.announced.delete(id)
      return
    }
    const now = this.now()
    const kept = (this.matchesByInterest.get(id) ?? []).filter(match => recordExpiry(match) > now)
    let told = this.announced.get(id)
    if (told === undefined) {
      told = new Set<string>()
      this.announced.set(id, told)
    }
    for (const match of kept) {
      if (!this.running || generation !== this.generation) return
      if (this.registry.get(id) === undefined) {
        this.announced.delete(id)
        return
      }
      const current = (this.matchesByInterest.get(id) ?? []).find(candidate => candidate.record.id === match.record.id)
      if (current === undefined || told.has(match.record.id)) continue
      told.add(match.record.id)
      try {
        this.onMatch(current)
      } catch {
        // A throwing onMatch is caught and ignored.
      }
    }
    for (const toldId of [...told]) {
      if (!kept.some(match => match.record.id === toldId)) told.delete(toldId)
    }
    if (told.size === 0) this.announced.delete(id)
  }
  private clearWindow (id: string): void {
    const timer = this.windowTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.windowTimers.delete(id)
    }
    this.windowDeadlines.delete(id)
    this.announced.delete(id)
    this.suspendedWindows.delete(id)
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
    if (this.suspendedWindows.has(id)) return
    const timer = this.windowTimers.get(id)
    const told = this.announced.get(id)
    if (timer === undefined && (told === undefined || told.size === 0)) return
    let deadline: number | undefined
    if (timer !== undefined) {
      clearTimeout(timer)
      this.windowTimers.delete(id)
      deadline = this.windowDeadlines.get(id) ?? Date.now()
      this.windowDeadlines.delete(id)
    }
    this.announced.delete(id)
    if (deadline === undefined) this.suspendedWindows.set(id, { told: told ?? new Set<string>(), session })
    else this.suspendedWindows.set(id, { deadline, told: told ?? new Set<string>(), session })
  }

  /**
   * Resume a suspended window after an eligible rollback: the old told set
   * returns pruned to still-live handles, and the original fixed deadline
   * resumes only when a timer was actually open, flushing promptly when it
   * already elapsed. Skipped when the interest is gone, withdrawn, expired
   * or from another run.
   */
  private resumeWindow (id: string, generation: number): void {
    const suspended = this.suspendedWindows.get(id)
    if (suspended === undefined) return
    this.suspendedWindows.delete(id)
    if (!this.running || generation !== this.generation) return
    const live = this.registry.get(id)
    if (live === undefined || live.expires <= this.now()) return
    const liveIds = new Set((this.matchesByInterest.get(id) ?? []).map(match => match.record.id))
    for (const toldId of [...suspended.told]) {
      if (!liveIds.has(toldId)) suspended.told.delete(toldId)
    }
    if (suspended.told.size > 0) this.announced.set(id, suspended.told)
    if (suspended.deadline === undefined) return
    const timer = setTimeout(() => {
      this.windowTimers.delete(id)
      this.windowDeadlines.delete(id)
      this.flushWindow(id, generation)
    }, Math.max(0, suspended.deadline - Date.now()))
    if (typeof timer === 'object') timer.unref()
    this.windowTimers.set(id, timer)
    this.windowDeadlines.set(id, suspended.deadline)
  }

  /** Forgets the matches of interests that are no longer live, so expired interests leave nothing behind. */
  private dropDeadMatches (): void {
    const now = this.now()
    for (const [id, matches] of this.matchesByInterest) {
      if (this.registry.get(id) === undefined) {
        // A suspended replacement window owns this id until its transaction
        // resolves; the success and failure paths handle it from there.
        if (this.suspendedWindows.has(id)) continue
        this.matchesByInterest.delete(id)
        this.clearWindow(id)
      }
      else {
        const live = matches.filter(match => recordExpiry(match) > now)
        if (live.length === 0) this.matchesByInterest.delete(id)
        else if (live.length !== matches.length) this.matchesByInterest.set(id, live)
        const told = this.announced.get(id)
        if (told !== undefined) {
          for (const toldId of [...told]) {
            if (!live.some(match => match.record.id === toldId)) told.delete(toldId)
          }
          if (told.size === 0) this.announced.delete(id)
        }
      }
    }
  }

  /** One timer releases idle interests and results at their earliest expiry. */
  private scheduleExpiry (): void {
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    if (!this.running) return
    this.registry.sweep()
    this.dropDeadMatches()
    let next = this.registry.nextExpiry()
    for (const [id, matches] of this.matchesByInterest) {
      // A suspended replacement window is owned by its transaction until
      // rollback or flush revalidates expiry; scheduling its past deadline
      // would spin zero-delay callbacks while publication is blocked.
      if (this.suspendedWindows.has(id)) continue
      for (const match of matches) next = Math.min(next ?? Infinity, recordExpiry(match))
    }
    if (next === undefined) return
    this.expiryTimer = setTimeout(() => this.scheduleExpiry(), Math.max(0, next - this.now()))
    // Node/Bun must not stay alive for an interest; browsers return a numeric handle.
    if (typeof this.expiryTimer === 'object') this.expiryTimer.unref()
  }

  withdraw (session: string, id: string): boolean {
    const removed = this.registry.withdraw(session, id)
    if (removed) {
      this.matchesByInterest.delete(id)
      this.clearWindow(id)
    }
    this.scheduleExpiry()
    return removed
  }

  endSession (session: string): string[] {
    for (const pending of this.announcing) {
      if (pending.session === session) pending.cancelled = true
    }
    const ended = this.registry.endSession(session)
    for (const id of ended) {
      this.matchesByInterest.delete(id)
      this.clearWindow(id)
    }
    // An in-flight replacement already removed its original interest from
    // the registry, so it is not in `ended`: release its dormant suspended
    // state now instead of leaving a timer/record leak while publish stays
    // blocked. The later rollback stays guarded and cleans anything missed.
    for (const [id, suspended] of [...this.suspendedWindows]) {
      const owner = suspended.session ?? this.matchesByInterest.get(id)?.[0]?.session
      if (owner !== session) continue
      this.suspendedWindows.delete(id)
      this.matchesByInterest.delete(id)
      this.announced.delete(id)
      const timer = this.windowTimers.get(id)
      if (timer !== undefined) {
        clearTimeout(timer)
        this.windowTimers.delete(id)
      }
      this.windowDeadlines.delete(id)
    }
    this.scheduleExpiry()
    return ended
  }

  interests (session?: string): OpenInterest[] {
    return this.registry.list(session)
  }

  /** Matches kept for one of this service's interests, best first. Empty for an unknown or expired id. */
  matches (id: string): MatchFound[] {
    const interest = this.registry.get(id)
    if (interest === undefined) {
      this.matchesByInterest.delete(id)
      return []
    }
    const kept = this.matchesByInterest.get(id) ?? []
    const now = this.now()
    const live = kept.filter(match => recordExpiry(match) > now)
    if (live.length !== kept.length) {
      if (live.length === 0) this.matchesByInterest.delete(id)
      else this.matchesByInterest.set(id, live)
    }
    return [...live]
  }

  /** Topic validator and delivery point (Section 2.2). */
  private async onGossip (event: GossipEvent): Promise<'accept' | 'reject' | 'ignore'> {
    if (!this.running) return 'ignore'
    const gen = this.generation
    const profile = this.embedder.profile()
    let thresholds: Record<number, number>
    try {
      thresholds = resolveThresholds(profile, this.localThresholds)
    } catch {
      return 'reject'
    }
    const now = this.now()
    let announcement: Announcement
    try {
      announcement = await openAnnouncement(event.data, {
        profile: ns => ns === profile.id ? profile : undefined,
        verify: (peer, data, sig) => this.transport.verify(peer, data, sig),
        now
      })
    } catch (error) {
      if (error instanceof AnnouncementError && (error.fault === 'unknown_namespace' || error.fault === 'expired')) return 'ignore'
      return 'reject'
    }
    // A stop, or a stop and start, during the await leaves no state behind (Section 2.2).
    if (!this.running || gen !== this.generation) return 'ignore'
    // The transport authenticated event.origin as the publisher (Section 10.1).
    if (announcement.origin !== event.origin) return 'reject'
    const addrs = openContact(announcement.contact, announcement.origin)
    if (addrs === undefined) return 'reject'
    // Own announcements are seen but never matched (Section 4.3).
    if (announcement.origin === this.transport.info().peerId) return 'accept'
    if (this.seen.has(announcement.id)) return 'ignore'
    if (!this.countAccept(announcement.origin, now)) return 'ignore'
    this.seen.add(announcement.id, expiresAt(announcement))
    // Answer without holding the validator (Section 11.2).
    void this.respond(announcement, addrs, profile.id, thresholds).catch(() => {})
    return 'accept'
  }

  /**
   * Count one accepted announcement from an origin for the rate limit.
   * False when the origin is already at its limit (Section 2.2).
   */
  private countAccept (origin: PeerId, now: number): boolean {
    const windowStart = now - 60000
    const kept = (this.originTimes.get(origin) ?? []).filter(t => t > windowStart)
    if (kept.length >= this.announcementsPerOriginPerMinute) {
      if (kept.length === 0) this.originTimes.delete(origin)
      else this.originTimes.set(origin, kept)
      return false
    }
    kept.push(now)
    // Forgetting timestamps older than 60 s keeps entries bounded (Section 10.7).
    for (const [peer, times] of this.originTimes) {
      if (peer === origin) continue
      const live = times.filter(t => t > windowStart)
      if (live.length === 0) this.originTimes.delete(peer)
      else if (live.length !== times.length) this.originTimes.set(peer, live)
    }
    if (!this.originTimes.has(origin) && this.originTimes.size >= 1024) {
      let oldestPeer: string | undefined
      let oldestTime = Infinity
      for (const [peer, times] of this.originTimes) {
        const last = times[times.length - 1] ?? -Infinity
        if (last < oldestTime) {
          oldestTime = last
          oldestPeer = peer
        }
      }
      if (oldestPeer !== undefined) this.originTimes.delete(oldestPeer)
    }
    this.originTimes.set(origin, kept)
    return true
  }

  /** Answer an accepted announcement with the best local open interests (Section 11.2). */
  private async respond (announcement: Announcement, addrs: string[], namespace: string, thresholds: Record<number, number>): Promise<void> {
    if (!this.running) return
    const profile = this.embedder.profile()
    const rooms = this.conferences().filter(room => room.descriptor.namespace === namespace && room.descriptor.expiresAt > this.now())
    const hostedIds = new Set(rooms.map(room => room.descriptor.id))
    const candidates: (MatchRecord & { bytes: Uint8Array })[] = [
      ...this.registry.list().filter(interest => interest.announcement.namespace === namespace && !hostedIds.has(interest.id))
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
    const best = ranked.slice(0, this.maxResultsPerAnnouncement)
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
    if (!this.running) return
    try {
      await this.transport.send(announcement.origin, packet, addrs)
    } catch {
      // A send failure is swallowed (Section 11.2).
    }
  }

  /** Direct entry point: returns at once, work happens in the background. */
  private async onDirectEvent (event: { from: PeerId, data: Uint8Array }): Promise<void> {
    if (!this.running) return
    const gen = this.generation
    const data = event.data
    if (data.length === 0 || data[0] !== 0) return
    const profile = this.embedder.profile()
    let thresholds: Record<number, number>
    try {
      thresholds = resolveThresholds(profile, this.localThresholds)
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
    if (results.length === 0 || results.length > this.maxResultsPerAnnouncement) return
    const selfId = this.transport.info().peerId
    const now = this.now()
    for (const result of results) {
      try {
        if (result.announcementId.length !== 16) continue
        const interest = this.registry.get(hex(result.announcementId))
        if (interest === undefined) continue
        if ((result.record.length > 0) === (result.conference.length > 0)) continue
        const options = {
          profile: (ns: string) => ns === profile.id ? profile : undefined,
          verify: (peer: PeerId, signed: Uint8Array, sig: Uint8Array) => this.transport.verify(peer, signed, sig),
          now
        }
        const candidate: MatchRecord = result.conference.length > 0
          ? { kind: 'conference', record: await openDescriptor(result.conference, options) }
          : { kind: 'interest', record: await openAnnouncement(result.record, options) }
        const record = candidate.record
        // A stop, or a stop and start, during the await stores nothing.
        if (!this.running || gen !== this.generation) return
        const peer = candidate.kind === 'interest' ? candidate.record.origin : candidate.record.host
        // Only the authenticated origin or host may answer for this record (Section 10.6).
        if (peer !== event.from || peer === selfId) continue
        if (record.namespace !== interest.announcement.namespace) continue
        const addrs = candidate.kind === 'interest' ? openContact(candidate.record.contact, peer) : candidate.record.addrs
        if (addrs === undefined) continue
        const tier = matchTier(interest.announcement.vector, recordVector(candidate), profile, thresholds)
        if (tier === null) continue
        const fullScore = similarity(interest.announcement.vector, recordVector(candidate), profile.dims[0])
        if (!this.running) return
        // The interest may have been withdrawn or expired while the record was being verified.
        if (this.registry.get(interest.id) !== interest) continue
        // Stale kept matches hold no slot: prune them before the duplicate check and caps (Section 5.3).
        const pruneNow = this.now()
        const held = this.matchesByInterest.get(interest.id) ?? []
        const kept = held.filter(match => recordExpiry(match) > pruneNow)
        if (kept.length !== held.length) {
          if (kept.length === 0) this.matchesByInterest.delete(interest.id)
          else this.matchesByInterest.set(interest.id, kept)
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
          .sort((a, b) => compareCandidates(a, b)).slice(0, this.maxResultsPerAnnouncement)
        const rest = withNew.filter(m => m.peer !== peer)
        const next = [...rest, ...peerBest]
          .sort((a, b) => compareCandidates(a, b)).slice(0, this.maxMatchesPerInterest)
        this.matchesByInterest.set(interest.id, next)
        this.scheduleExpiry()
        if (next.includes(match) && previous === undefined) {
          this.notifyOrBuffer(interest.id, match, gen)
        }
      } catch {
        // One bad result never stops the rest: peer content is untrusted (Section 10.5).
        continue
      }
    }
  }
}
