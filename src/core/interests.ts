/**
 * The service's own open interests: announcements it has published and still
 * holds, each tied privately to one agent session, plus a bounded memory of
 * announcement ids already seen (Sections 3.2 and 4.3).
 *
 * Nothing here imports a Node built-in: the core runs in browsers. Time comes
 * from an injected clock so tests can move it.
 */
import { expiresAt } from './announcement.ts'
import type { Announcement } from './announcement.ts'

export interface OpenInterest {
  /** The announcement id. */
  id: string
  /** The local agent session that holds it. Never sent to a peer. */
  session: string
  announcement: Announcement
  /** The signed bytes that were published, kept so they can be published again unchanged. */
  bytes: Uint8Array
  /** The statement behind the vector. Always kept, published or not (Section 11.5). */
  statement: string
  /** Milliseconds since the Unix epoch: issuedAt + ttl * 1000. */
  expires: number
}

export interface OpenInterestsOptions {
  /** Most live interests one session may hold. Default 8. */
  maxPerSession?: number
  /** Most live interests in total. Default 64. */
  max?: number
  now?: () => number
}

/**
 * Holds the service's open interests in insertion order. Every method first
 * drops interests whose lifetime has passed, so callers need no timer: they
 * read `nextExpiry` and set one one-shot timer from it.
 */
export class OpenInterests {
  private interests = new Map<string, OpenInterest>()
  private maxPerSession: number
  private max: number
  private now: () => number

  constructor (options: OpenInterestsOptions = {}) {
    const maxPerSession = options.maxPerSession ?? 8
    const max = options.max ?? 64
    if (!(maxPerSession >= 1)) throw new Error('maxPerSession must be at least 1')
    if (!(max >= 1)) throw new Error('max must be at least 1')
    this.maxPerSession = maxPerSession
    this.max = max
    this.now = options.now ?? Date.now
  }

  /** Drops expired interests, oldest first, returning their ids. */
  private prune (): string[] {
    const now = this.now()
    const dropped: string[] = []
    for (const [id, interest] of this.interests) {
      if (interest.expires <= now) {
        this.interests.delete(id)
        dropped.push(id)
      }
    }
    return dropped
  }

  /**
   * Stores an interest and returns the stored record. A revised statement
   * gets a new announcement id and names the earlier interest in `replaces`,
   * which removes that one interest in the same call (Section 4.3). A failed
   * call changes nothing.
   */
  add (entry: { session: string, announcement: Announcement, bytes: Uint8Array, statement: string, replaces?: string }): OpenInterest {
    const { session, announcement, bytes, statement, replaces } = entry
    if (typeof session !== 'string' || session === '' || typeof statement !== 'string' || statement === '') {
      throw new Error('session and statement are required')
    }
    this.prune()
    const now = this.now()
    let replaced: OpenInterest | undefined
    if (replaces !== undefined) {
      replaced = this.interests.get(replaces)
      if (replaced !== undefined && replaced.session !== session) {
        throw new Error('interest belongs to another session')
      }
    }
    // A revision always has a new id, so an id already held is a duplicate even when `replaces` names it.
    if (this.interests.has(announcement.id)) throw new Error('announcement is already an open interest')
    const expires = expiresAt(announcement)
    if (expires <= now) throw new Error('announcement has expired')
    let sessionCount = 0
    for (const interest of this.interests.values()) {
      if (interest.id !== replaced?.id && interest.session === session) sessionCount++
    }
    const total = this.interests.size - (replaced === undefined ? 0 : 1)
    if (sessionCount >= this.maxPerSession) throw new Error('session holds the most open interests allowed')
    if (total >= this.max) throw new Error('service holds the most open interests allowed')
    if (replaced !== undefined) this.interests.delete(replaced.id)
    const interest: OpenInterest = { id: announcement.id, session, announcement, bytes, statement, expires }
    this.interests.set(interest.id, interest)
    return interest
  }

  /** The live interest with an id, or undefined when unknown or expired. */
  get (id: string): OpenInterest | undefined {
    this.prune()
    return this.interests.get(id)
  }

  /** Live interests oldest first; only one session's when named. A fresh array. */
  list (session?: string): OpenInterest[] {
    this.prune()
    const out: OpenInterest[] = []
    for (const interest of this.interests.values()) {
      if (session === undefined || interest.session === session) out.push(interest)
    }
    return out
  }

  /** Removes a live interest its own session holds. True only then. */
  withdraw (session: string, id: string): boolean {
    this.prune()
    const interest = this.interests.get(id)
    if (interest === undefined || interest.session !== session) return false
    this.interests.delete(id)
    return true
  }

  /** Removes every interest of a session, returning their ids oldest first. */
  endSession (session: string): string[] {
    this.prune()
    const ended: string[] = []
    for (const [id, interest] of this.interests) {
      if (interest.session === session) {
        this.interests.delete(id)
        ended.push(id)
      }
    }
    return ended
  }

  /** Removes expired interests and returns their ids oldest first. */
  sweep (): string[] {
    return this.prune()
  }

  /** The earliest expiry among live interests, or undefined when there are none. */
  nextExpiry (): number | undefined {
    this.prune()
    let earliest: number | undefined
    for (const interest of this.interests.values()) {
      if (earliest === undefined || interest.expires < earliest) earliest = interest.expires
    }
    return earliest
  }

  /** The number of live interests. */
  get size (): number {
    this.prune()
    return this.interests.size
  }
}

/**
 * A bounded memory of announcement ids already seen, so a repeated
 * announcement is handled once (Section 4.3).
 */
export class SeenAnnouncements {
  private ids = new Map<string, number>()
  private capacity: number
  private now: () => number

  constructor (options: { capacity?: number, now?: () => number } = {}) {
    const capacity = options.capacity ?? 4096
    if (!(capacity >= 1)) throw new Error('capacity must be at least 1')
    this.capacity = capacity
    this.now = options.now ?? Date.now
  }

  private prune (): void {
    const now = this.now()
    for (const [id, expires] of this.ids) {
      if (expires <= now) this.ids.delete(id)
    }
  }

  /** Records an id until `expires`. True when it was not already held. */
  add (id: string, expires: number): boolean {
    const held = this.ids.get(id)
    if (held !== undefined) {
      if (held > this.now()) return false
      this.ids.delete(id)
    }
    if (expires <= this.now()) return true
    if (this.ids.size >= this.capacity) {
      this.prune()
      if (this.ids.size >= this.capacity) {
        let oldest: string | undefined
        let earliest = Infinity
        for (const [candidate, candidateExpires] of this.ids) {
          if (candidateExpires < earliest) {
            earliest = candidateExpires
            oldest = candidate
          }
        }
        if (oldest !== undefined) this.ids.delete(oldest)
      }
    }
    this.ids.set(id, expires)
    return true
  }

  /** True while an id is held and its expiry has not passed. */
  has (id: string): boolean {
    const expires = this.ids.get(id)
    if (expires === undefined) return false
    if (expires <= this.now()) {
      this.ids.delete(id)
      return false
    }
    return true
  }

  /** The number of live ids held. */
  get size (): number {
    this.prune()
    return this.ids.size
  }
}
