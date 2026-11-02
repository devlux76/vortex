// Delivery engine (docs/v6-proposal.md §8.4, §8.5): per-binding wake/passive
// queues, batch composition under the rendered bounds, wake pacing, stream
// ownership (4409/takeover), at-least-once replay with stable batch ids and
// evidence-bearing acknowledgments.
import type { HubStore as Store } from './store.ts'
import type { HubConfig } from './config.ts'
import type { StoredMessage, BatchRow } from './store.ts'
import { convKeyOf } from './store.ts'
import { ulid } from '../client/ulid.ts'
import { measure, PLACEHOLDER_BATCH, type Bounds } from '../client/render.ts'

export type Evidence = 'host-accepted' | 'transport-written' | 'hook-returned'

export interface BatchFrame {
  type: 'batch'
  batch: string
  wake: boolean
  messages: StoredMessage[]
  /** One-line [vx: ...] notices that render above the messages (§8.4, §8.5). */
  notices: string[]
}

export type ServerFrame = BatchFrame | { type: 'error'; reason: string; batch?: string } | { type: 'empty'; kind: 'passive' }
export interface SocketLike { send (frame: ServerFrame): void; close (code: number, reason: string): void }

interface BindingRuntime {
  principal: string
  name: string
  ws?: SocketLike
  gen: number
  coalesceTimer?: ReturnType<typeof setTimeout>
  deferTimer?: ReturnType<typeof setTimeout>
  lastError?: string
}

export class Delivery {
  readonly store: Store
  readonly cfg: HubConfig
  private runtimes = new Map<string, BindingRuntime>()
  private orderTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private genCounter = 0

  constructor (store: Store, cfg: HubConfig) {
    this.store = store
    this.cfg = cfg
  }

  static keyOf (principal: string, name: string): string { return `${principal}/${name}` }

  private runtime (principal: string, name: string): BindingRuntime {
    const key = Delivery.keyOf(principal, name)
    let r = this.runtimes.get(key)
    if (r === undefined) {
      r = { principal, name, gen: 0 }
      this.runtimes.set(key, r)
    }
    return r
  }

  private bounds (): Bounds {
    return {
      maxMessages: this.cfg.batchMaxMessages,
      maxCodePoints: this.cfg.batchMaxCodePoints,
      maxBytes: this.cfg.batchMaxBytes,
    }
  }

  // ------------------------------------------------------------------
  // routing (§8.2 recipients, §8.4/§8.5 wake vs passive)
  // ------------------------------------------------------------------

  /**
   * Route one freshly stored message to the deliverable bindings and arm wake
   * timers. Prefer `routeStored` inside the insert transaction plus
   * `armWakes` after commit (crash-atomic outbox; see Api.send).
   */
  onMessageStored (m: StoredMessage): void {
    this.armWakes(this.routeStored(m))
  }

  /**
   * Enqueue `m` for every deliverable binding (DB writes only, no timers), so
   * a caller can run it in the same transaction as the message insert.
   * Returns the bindings that received a wake-eligible row.
   */
  routeStored (m: StoredMessage): Array<{ principal: string; name: string }> {
    const wakes: Array<{ principal: string; name: string }> = []
    const targets = m.scope === 'dm'
      // §8.2: only the single recipient's bindings receive a DM; never room members.
      ? this.store.bindingsOf(m.to[0])
      : this.store.deliverableBindingsForRoom(m.room!, m.from)
    for (const b of targets) {
      if (this.enqueue(m, b.principal, b.name) === 'wake') wakes.push({ principal: b.principal, name: b.name })
    }
    return wakes
  }

  /** Arm coalesce timers for bindings that got wake rows (after commit). */
  armWakes (wakes: Array<{ principal: string; name: string }>): void {
    for (const w of wakes) this.scheduleCoalesce(w.principal, w.name)
  }

  /**
   * A4: addressed mail is always a WAKE row, even while its conversation cools;
   * cooling only holds it at selection time (never converted to passive).
   */
  private enqueue (m: StoredMessage, principal: string, name: string): 'wake' | 'passive' {
    const namesMe = m.to.includes(principal)
    const operatorNoTarget = m.from === 'operator' && m.to.length === 0
    const wakeEligible = namesMe || operatorNoTarget
    const kind: 'wake' | 'passive' = wakeEligible ? 'wake' : 'passive'
    this.store.enqueuePending(principal, name, m, kind)
    return kind
  }

  // ------------------------------------------------------------------
  // A4 cooldown timers: one timer for the earliest cooling_until
  // ------------------------------------------------------------------

  private coolingTimer?: ReturnType<typeof setTimeout>
  private coolingAt?: number

  /** Startup (A4 §4): expire cooldowns that passed while down, then arm the next expiry. */
  start (): void {
    this.onCoolingDue()
  }

  /** After a send commits: arm the expiry timer for a new cooldown; release at once on operator reset. */
  afterCommit (info: { conversationKey: string; enteredCooldown: boolean; operatorReset: boolean }): void {
    if (info.enteredCooldown) this.armCoolingTimer()
    if (info.operatorReset) {
      for (const b of this.store.bindingsHoldingWake(info.conversationKey)) this.scheduleCoalesce(b.principal, b.name)
      this.armCoolingTimer()
    }
  }

  private armCoolingTimer (): void {
    const next = this.store.nextCoolingExpiry()
    if (next === undefined) {
      if (this.coolingTimer !== undefined) clearTimeout(this.coolingTimer)
      this.coolingTimer = undefined; this.coolingAt = undefined
      return
    }
    if (this.coolingTimer !== undefined && this.coolingAt === next) return
    if (this.coolingTimer !== undefined) clearTimeout(this.coolingTimer)
    this.coolingAt = next
    this.coolingTimer = setTimeout(() => { this.coolingTimer = undefined; this.coolingAt = undefined; this.onCoolingDue() }, Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)))
  }

  private onCoolingDue (): void {
    const expired = this.store.expireCooldowns(Date.now())
    for (const conv of expired) for (const b of this.store.bindingsHoldingWake(conv)) this.scheduleCoalesce(b.principal, b.name)
    this.armCoolingTimer()
  }

  // ------------------------------------------------------------------
  // wake pacing (§8.4, A4 §3): coalesce; min interval; persistent rolling budget
  // ------------------------------------------------------------------

  private coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  scheduleCoalesce (principal: string, name: string): void {
    const r = this.runtime(principal, name)
    if (r.coalesceTimer !== undefined) return
    const fireIn = Math.max(0, this.cfg.wakeCoalesceMs)
    const key = Delivery.keyOf(principal, name)
    const timer = setTimeout(() => {
      this.coalesceTimers.delete(key)
      r.coalesceTimer = undefined
      this.attemptWakePush(principal, name)
    }, fireIn)
    this.coalesceTimers.set(key, timer)
    r.coalesceTimer = timer
  }

  /** Earliest instant a NEW wake push is permitted for this binding (persistent, A4 §3). */
  eligibleAt (principal: string, name: string, now = Date.now()): number {
    let at = now
    const last = this.store.lastWakePush(principal, name)
    if (last !== 0) at = Math.max(at, last + this.cfg.wakeMinIntervalMs)
    const times = this.store.wakePushTimes(principal, name, now)
    if (times.length >= this.cfg.wakeHourlyLimit) at = Math.max(at, times[times.length - this.cfg.wakeHourlyLimit] + this.cfg.wakeWindowMs + 1)
    return at
  }

  private deferWakeUntilBudget (principal: string, name: string, at: number): void {
    const r = this.runtime(principal, name)
    if (r.deferTimer !== undefined) return
    r.deferTimer = setTimeout(() => {
      r.deferTimer = undefined
      this.attemptWakePush(principal, name)
    }, Math.max(0, Math.min(at - Date.now(), 60_000)))
  }

  /** Try to push one wake batch for the binding (respects the outstanding slot + budget). */
  attemptWakePush (principal: string, name: string): void {
    const r = this.runtime(principal, name)
    if (r.ws === undefined) return
    if (this.store.outstandingBatch(principal, name, 'wake') !== undefined) return
    const now = Date.now()
    const at = this.eligibleAt(principal, name, now)
    if (at > now) {
      if (this.selectableWake(principal, name, now).length > 0) this.deferWakeUntilBudget(principal, name, at)
      return
    }
    this.composeAndPush(principal, name, 'wake', true)
  }

  /** Wake rows not in an outstanding batch and not held by a cooling conversation, in queue order. */
  private selectableWake (principal: string, name: string, now: number): StoredMessage[] {
    const excludes = new Set<string>()
    for (const b of this.store.outstandingBatchesOf(principal, name)) for (const id of b.msgIds) excludes.add(id)
    const cooling = new Map<string, boolean>()
    return this.store.pendingMessages(principal, name, 'wake').filter(m => {
      if (excludes.has(m.id)) return false
      const c = convKeyOf(m)
      let held = cooling.get(c)
      if (held === undefined) { held = this.store.isCooling(c, now); cooling.set(c, held) }
      return !held
    })
  }

  // ------------------------------------------------------------------
  // batch composition under the §8.4 rendered bounds
  // ------------------------------------------------------------------

  private scopeKeyOf (m: StoredMessage): string {
    return convKeyOf(m)
  }

  private composeAndPush (principal: string, name: string, kind: 'wake' | 'passive', wake: boolean): BatchRow | undefined {
    const r = this.runtime(principal, name)
    const hosted = r.ws
    if (hosted === undefined) return undefined
    const outstanding = this.store.outstandingBatch(principal, name, kind)
    if (outstanding !== undefined && kind === 'passive' && wake === false) {
      // pull with an in-flight passive batch → resend the same batch (§8.4)
      return this.resend(outstanding)
    }
    if (outstanding !== undefined) return undefined
    const now = Date.now()
    let candidates: StoredMessage[]
    if (kind === 'wake') {
      candidates = this.selectableWake(principal, name, now)
    } else {
      const excludes = new Set<string>()
      for (const b of this.store.outstandingBatchesOf(principal, name)) for (const id of b.msgIds) excludes.add(id)
      candidates = this.store.pendingMessages(principal, name, kind).filter(m => !excludes.has(m.id))
    }
    if (candidates.length === 0) return undefined
    // A4 §2: LRS chooses the conversation (wake); FIFO chooses rows inside it.
    let key = this.scopeKeyOf(candidates[0])
    if (kind === 'wake') {
      const served = this.store.lastServed(principal, name)
      let best = Infinity
      const seen = new Set<string>()
      for (const m of candidates) {
        const c = this.scopeKeyOf(m)
        if (seen.has(c)) continue
        seen.add(c)
        const t = served.get(c) ?? -Infinity
        if (t < best) { best = t; key = c } // first appearance wins ties (oldest head row)
      }
    }
    const scoped = candidates.filter(m => this.scopeKeyOf(m) === key)
    const isRoom = key.startsWith('room:')
    // Notices are peeked, not consumed, until a batch is actually built, so a
    // message that cannot fit beside them never loses a notice (§8.4/§8.5).
    const expired = this.store.getBinding(principal, name)?.expiredPending ?? 0
    const allNotices: string[] = []
    if (expired > 0) {
      const roomHint = isRoom ? `vx log ${key.slice(5)}` : 'vx log --dm'
      allNotices.push(`[vx: ${expired} older messages expired; ${roomHint}]`)
    }
    const cooldownNotice = this.store.peekCooldownNotice(key, principal, name)
    if (cooldownNotice !== undefined) allNotices.push(cooldownNotice)
    const pick = (notices: string[]): StoredMessage[] => {
      const out: StoredMessage[] = []
      for (const m of scoped) {
        if (out.length >= this.bounds().maxMessages) break
        const candidate = {
          batch: PLACEHOLDER_BATCH,
          scope: (isRoom ? 'room' : 'dm') as 'room' | 'dm',
          room: isRoom ? scoped[0].room : undefined,
          notices,
          messages: [...out, m],
        }
        if (!measure(candidate, this.bounds()).fits) break
        out.push(m)
      }
      return out
    }
    let notices = allNotices
    let picked = pick(notices)
    if (picked.length === 0 && notices.length > 0) { notices = []; picked = pick(notices) }
    if (picked.length === 0) return undefined
    // Real id replaces the constant-length placeholder: sizing holds (all ULIDs
    // are exactly 26 chars, so the wrapper length is id-content-invariant).
    const id = ulid()
    const batch: BatchRow = { id, principal, binding: name, kind, status: 'pending', msgIds: picked.map(m => m.id), notices, created: now }
    // One transaction: batch row, consumed notices and (wake) the permit record.
    this.store.atomic(() => {
      if (notices.length > 0) {
        if (expired > 0) this.store.consumeExpiredNotice(principal, name)
        if (cooldownNotice !== undefined) this.store.takeCooldownNotice(key, principal, name)
      }
      this.store.insertBatchRow(batch)
      if (kind === 'wake') this.store.recordWakePush(principal, name, key, id, now)
    })
    const frame: BatchFrame = { type: 'batch', batch: id, wake, messages: picked, notices }
    hosted.send(frame)
    this.startRetryTimer(batch)
    return batch
  }

  private startRetryTimer (batch: BatchRow): void {
    const key = batch.id
    const old = this.retryTimers.get(key)
    if (old !== undefined) clearTimeout(old)
    const timer = setTimeout(() => {
      this.retryTimers.delete(key)
      const row = this.store.getBatch(batch.id)
      if (row === undefined || row.status === 'delivered') return
      const r = this.runtime(batch.principal, batch.binding)
      if (r.ws !== undefined) this.resend(row)
      this.startRetryTimer(row)
    }, this.cfg.batchRetryMs)
    this.retryTimers.set(key, timer)
  }

  private resend (batch: BatchRow): BatchRow | undefined {
    const r = this.runtime(batch.principal, batch.binding)
    if (r.ws === undefined) return undefined
    const messages = this.store.getMessagesByIds(batch.msgIds)
    if (messages.length === 0) { this.store.deleteBatchRow(batch.id); return undefined }
    r.ws.send({ type: 'batch', batch: batch.id, wake: batch.kind === 'wake', messages, notices: batch.notices })
    return batch
  }

  // ------------------------------------------------------------------
  // streams, takeover, acks (§8.3/§8.4)
  // ------------------------------------------------------------------

  /** Attach a socket; returns false and closes with 4409 when already owned. */
  attach (socket: SocketLike, principal: string, name: string): boolean {
    const key = Delivery.keyOf(principal, name)
    const r = this.runtimes.get(key)
    if (r?.ws !== undefined && r.ws !== socket) {
      socket.close(4409, 'binding busy')
      return false
    }
    const rt = this.runtime(principal, name)
    rt.ws = socket
    rt.gen = ++this.genCounter
    // Reconnect replay: unacknowledged batches re-sent with the same id (§8.4),
    // wake first (§8.4: prioritize wake submissions).
    const outstanding = this.store.outstandingBatchesOf(principal, name)
    outstanding.sort((a, b) => (a.kind === 'wake' ? 0 : 1) - (b.kind === 'wake' ? 0 : 1))
    for (const b of outstanding) this.resend(b)
    // Wake mail that accumulated while no socket existed goes out now.
    this.attemptWakePush(principal, name)
    return true
  }

  detach (socket: SocketLike, principal: string, name: string): void {
    const r = this.runtimes.get(Delivery.keyOf(principal, name))
    if (r !== undefined && r.ws === socket) {
      r.ws = undefined
      r.gen = ++this.genCounter // late acks from a closing socket never consume
    }
  }

  /** Operator release (§8.3): the only takeover; invalidates the open connection. */
  release (principal: string, name: string): void {
    const r = this.runtimes.get(Delivery.keyOf(principal, name))
    if (r?.ws !== undefined) {
      const ws = r.ws
      r.ws = undefined
      r.gen = ++this.genCounter
      ws.close(4409, 'binding released')
    }
  }

  isStale (principal: string, name: string, socket: SocketLike): boolean {
    const r = this.runtimes.get(Delivery.keyOf(principal, name))
    return r === undefined || r.ws !== socket
  }

  /** The binding's current generation across restarts of ownership. */
  generationOf (principal: string, name: string): number {
    return this.runtime(principal, name).gen
  }

  handleDelivered (socket: SocketLike, principal: string, name: string, batchId: string, evidence: Evidence): boolean {
    if (this.isStale(principal, name, socket)) {
      socket.send({ type: 'error', reason: 'stale-generation: acknowledgment rejected after takeover or reconnect loss', batch: batchId })
      socket.close(4409, 'binding ownership changed')
      return false
    }
    const batch = this.store.getBatch(batchId)
    if (batch === undefined || batch.principal !== principal || batch.binding !== name || batch.status === 'delivered') {
      socket.send({ type: 'error', reason: 'unknown or already delivered batch', batch: batchId })
      return false
    }
    this.store.deliverBatch(batchId, evidence)
    const r = this.runtime(principal, name)
    r.lastError = undefined
    void batch
    // Slot freed: try the next wake batch immediately (budget still gates it).
    this.attemptWakePush(principal, name)
    return true
  }

  handleFailed (socket: SocketLike, principal: string, name: string, batchId: string, reason: string): void {
    const batch = this.store.getBatch(batchId)
    if (batch === undefined || batch.principal !== principal || batch.binding !== name) {
      socket.send({ type: 'error', reason: 'unknown batch', batch: batchId })
      return
    }
    this.store.markBatchFailed(batchId, reason)
    const r = this.runtime(principal, name)
    r.lastError = reason
    // The batch stays retryable with the same id; the retry timer was armed at push.
  }

  handlePull (socket: SocketLike, principal: string, name: string): void {
    if (this.isStale(principal, name, socket)) return
    const r = this.runtime(principal, name)
    const outstanding = this.store.outstandingBatch(principal, name, 'passive')
    if (outstanding !== undefined) { this.resend(outstanding); return }
    // A2 (§8.14): nothing pending answers at once so the hook never waits.
    if (this.composeAndPush(principal, name, 'passive', false) === undefined) socket.send({ type: 'empty', kind: 'passive' })
    void r
  }

  /** A2: a plugin-reported fault with no batch (e.g. a pull timeout) surfaces in `vx status` as lastError. */
  handleFault (socket: SocketLike, principal: string, name: string, reason: string): void {
    if (this.isStale(principal, name, socket)) return
    this.runtime(principal, name).lastError = reason
  }

  lastError (principal: string, name: string): string | undefined {
    return this.runtime(principal, name).lastError
  }

  openStreams (): Array<{ principal: string; name: string; gen: number }> {
    const out: Array<{ principal: string; name: string; gen: number }> = []
    for (const r of this.runtimes.values()) if (r.ws !== undefined) out.push({ principal: r.principal, name: r.name, gen: r.gen })
    return out
  }

  /** Waiting (over-budget wake) info for status: wake-eligible pendings beyond the slot. */
  waitingWake (principal: string, name: string): number {
    const outstanding = this.store.outstandingBatch(principal, name, 'wake')
    const all = this.store.pendingMessages(principal, name, 'wake')
    const excludes = new Set(outstanding?.msgIds ?? [])
    return all.filter(m => !excludes.has(m.id)).length
  }

  stop (): void {
    for (const t of this.orderTimers.values()) clearTimeout(t)
    for (const t of this.coalesceTimers.values()) clearTimeout(t)
    for (const t of this.retryTimers.values()) clearTimeout(t)
    for (const r of this.runtimes.values()) if (r.deferTimer !== undefined) clearTimeout(r.deferTimer)
    if (this.coolingTimer !== undefined) clearTimeout(this.coolingTimer)
    this.orderTimers.clear(); this.coalesceTimers.clear(); this.retryTimers.clear()
  }
}
