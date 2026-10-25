/**
 * The ring policy in TypeScript. The Bun service no longer uses it: there
 * the router in `backbone/` decides. It is kept, with its tests, for clients
 * that cannot reach a router, such as a browser extension.
 */
export interface RingOptions {
  /** Most ring starts per room in any rolling hour. */
  maxPerHour?: number
  /** Least time between two ring starts, across all rooms. */
  minIntervalMs?: number
  /**
   * How long owner activity holds off ringing. Without it a live session and
   * a rung one race for the same mail. Off by default.
   */
  ownerQuietMs?: number
  /** Consecutive non-zero adapter exits after which ringing stops. */
  maxFailures?: number
  now?: () => number
}

export interface RingState {
  /** The room a ring would be charged to. */
  room: string
  /** Events stored after the owner's ack, in rooms with mutual consent. */
  unread: number
  /** Clients currently blocked in `wait`. */
  waiters: number
  /** Whether a ring adapter process is alive. */
  running: boolean
}

/**
 * Decides whether the service may start the owner's wake adapter. It holds
 * no I/O: the caller spawns the process and reports what happened. Stored
 * mail never depends on this; a refusal only means nobody is woken for it.
 */
export interface RingPolicy {
  shouldRing(state: RingState): boolean
  started(room: string): void
  exited(code: number): void
  /**
   * A `read`, `ack` or delivered `wait` arrived: someone is attending to the
   * inbox, so the failure count clears and ringing holds off for
   * `ownerQuietMs`. This does not refill the hourly budget: a rung agent reads and
   * acks too.
   */
  ownerActed(): void
}

/** The part of the conversation core that ring selection reads. */
export interface RingSource {
  /** One page of events after a cursor, or after the owner's ack if omitted. */
  read(after?: number): { events: Array<{ room: string, kind?: string }>, cursor: number }
  rooms(): Record<string, { localConsent: boolean, remoteConsent: boolean }>
  waiters(): number
}

/**
 * Picks the room to ring for, if any. Only unread events in rooms with
 * mutual consent count. Every unread page is scanned, so mail is not hidden
 * behind a page of other events, and rooms are tried in order of their
 * oldest unread event, so a room that has spent its budget does not hold
 * back the rooms after it.
 */
export function nextRing (policy: RingPolicy, core: RingSource, running: boolean): { room: string, unread: number } | undefined {
  const rooms = core.rooms()
  const order: string[] = []
  let unread = 0
  const CONTROL_KINDS = new Set(['match', 'invitation', 'accepted', 'formed', 'arrival', 'departure', 'closed']);
  for (let page = core.read(); page.events.length > 0; page = core.read(page.cursor)) {
    for (const { room, kind } of page.events) {
      if (kind !== undefined && CONTROL_KINDS.has(kind)) continue;
      if (!rooms[room]?.localConsent || !rooms[room]?.remoteConsent) continue
      unread++
      if (!order.includes(room)) order.push(room)
    }
  }
  const waiters = core.waiters()
  const room = order.find(room => policy.shouldRing({ room, unread, waiters, running }))
  return room === undefined ? undefined : { room, unread }
}

const HOUR = 3_600_000

export function createRingPolicy (options: RingOptions = {}): RingPolicy {
  const maxPerHour = options.maxPerHour ?? 4
  const minIntervalMs = options.minIntervalMs ?? 30_000
  const ownerQuietMs = options.ownerQuietMs ?? 0
  const maxFailures = options.maxFailures ?? 3
  const now = options.now ?? Date.now
  const starts = new Map<string, number[]>()
  let lastStart = -Infinity
  /** Room of the most recent ring start. Only one adapter runs at a time. */
  let lastRoom: string | undefined
  let lastOwner = -Infinity
  let failures = 0

  return {
    shouldRing ({ room, unread, waiters, running }) {
      if (unread <= 0 || waiters > 0 || running || failures >= maxFailures) return false
      if (now() - lastStart < minIntervalMs || now() - lastOwner < ownerQuietMs) return false
      const recent = (starts.get(room) ?? []).filter(at => now() - at < HOUR)
      return recent.length < maxPerHour
    },
    started (room) {
      lastStart = now()
      lastRoom = room
      starts.set(room, [...(starts.get(room) ?? []).filter(at => now() - at < HOUR), lastStart])
    },
    /**
     * Exit 75 means the adapter deferred: the session was busy through its
     * deadline or had pending question/permission requests. That is neither
     * success nor a broken adapter, so the charged start is restored and the
     * consecutive-failure count is left unchanged. Minimum pacing still
     * applies, since `lastStart` is retained.
     */
    exited (code) {
      if (code === 0) { failures = 0; lastRoom = undefined; return }
      // Notification accepted but not yet acknowledged: retain its budget
      // charge without treating a slow owner turn as a broken adapter.
      if (code === 76) { lastRoom = undefined; return }
      if (code === 75) {
        if (lastRoom !== undefined) {
          const charged = (starts.get(lastRoom) ?? []).filter(at => now() - at < HOUR)
          charged.pop()
          starts.set(lastRoom, charged)
          lastRoom = undefined
        }
        return
      }
      failures += 1
      lastRoom = undefined
    },
    ownerActed () {
      failures = 0
      lastOwner = now()
    }
  }
}
