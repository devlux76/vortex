// Hub storage: SQLite (bun:sqlite, WAL) under $XDG_STATE_HOME/vortex/hub.db.
// Schema per docs/v6-proposal.md §8.2 (principals, bindings, messages,
// deliveries) plus the bookkeeping tables needed to survive restarts:
// members, conversations (loop breaker), pending (per-binding queues).
// All API-visible numbers come from HubConfig defaults (§8 preamble).
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG, PRINCIPAL_RE, ROOM_RE, BINDING_RE, type HubConfig } from './config.ts'
import { ulid } from '../client/ulid.ts'
import { SCHEMA, dmPairKey, roomKey, convKeyOf, sha256Hex, utf8Count, type StoredMessage, type BatchRow, type BindingRow, type ConversationRow } from './store-schema.ts'
import * as pending from './store-pending.ts'
import * as logs from './store-log.ts'
import { rowToStoredMessage } from './store-pending.ts'

export * from './store-schema.ts'


/* Rendered-bounds checking lives in client/render.ts (fitSingle); the hub's
 * api.ts and delivery.ts import it from there, not from the store. */

export class HubStore {
  readonly db: Database
  readonly cfg: HubConfig

  constructor (dbPath: string, cfg: HubConfig = DEFAULT_CONFIG) {
    this.cfg = cfg
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * A4 schema (idempotent): conversation cooldown columns, pending.conv, and the
   * one-time conversion of legacy `paused=1` rows into cooldowns. Re-running is a
   * no-op: added columns are detected, and migrated rows no longer have paused=1.
   */
  private migrate (): void {
    this.db.transaction(() => {
      const cols = (t: string) => new Set((this.db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(c => c.name))
      const conv = cols('conversations')
      for (const [c, ddl] of [
        ['cooling_until', 'INTEGER'], ['level', 'INTEGER NOT NULL DEFAULT 0'], ['last_auto_ts', 'INTEGER'],
        ['last_cooldown_end', 'INTEGER'], ['last_drain_ts', 'INTEGER'],
      ] as const) if (!conv.has(c)) this.db.exec(`ALTER TABLE conversations ADD COLUMN ${c} ${ddl}`)
      if (!cols('pending').has('conv')) {
        this.db.exec('ALTER TABLE pending ADD COLUMN conv TEXT')
        const rows = this.db.prepare('SELECT p.rowid AS rid, m.scope, m.room, m.fromp, m.to_json FROM pending p JOIN messages m ON m.id = p.msg_id').all() as any[]
        const upd = this.db.prepare('UPDATE pending SET conv = ? WHERE rowid = ?')
        for (const r of rows) upd.run(convKeyOf({ scope: r.scope, room: r.room ?? undefined, from: r.fromp, to: JSON.parse(r.to_json) }), r.rid)
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS pending_conv ON pending(conv, kind)')
      this.db.prepare('UPDATE conversations SET cooling_until = ?, level = 1, paused = 0, notice_pending = 0 WHERE paused = 1')
        .run(Date.now() + this.cfg.cooldownBaseMs)
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', 'a4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    })()
  }

  close (): void {
    this.db.close()
  }

  // ------------------------------------------------------------------
  // principals
  // ------------------------------------------------------------------

  /** Mint a principal token (operator reserved; validated caller-side). */
  createPrincipalUnchecked (name: string): { token: string } {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const bytes = Buffer.from(raw).toString('base64').replace(/[+/=]/g, s => s === '+' ? '-' : s === '/' ? '_' : '')
    const token = `vt_${bytes}`
    const hash = sha256Hex(token)
    this.db.prepare('INSERT INTO principals (name, token_hash, created) VALUES (?, ?, ?)').run(name, hash, Date.now())
    return { token }
  }

  createPrincipal (name: string): { token: string } {
    if (name === 'operator') throw new Error('operator is reserved; hub init creates it')
    if (!PRINCIPAL_RE.test(name)) throw new Error(`invalid principal name: ${name}`)
    return this.db.transaction(() => this.createPrincipalUnchecked(name))()
  }

  /** Verify a bearer token; returns the principal name or undefined (no caching: enroll is out-of-band). */
  verifyToken (token: string): string | undefined {
    if (!token.startsWith('vt_')) return undefined
    const row = this.db.prepare('SELECT name FROM principals WHERE token_hash = ?').get(sha256Hex(token)) as { name: string } | undefined
    return row?.name
  }

  /** Exists (do not reveal). */
  principalExists (name: string): boolean {
    return this.db.prepare('SELECT 1 FROM principals WHERE name = ?').get(name) != null
  }

  operatorExists (): boolean {
    return this.principalExists('operator')
  }

  enrolledNames (...names: string[]): string[] {
    return names.filter(n => this.principalExists(n))
  }

  // ------------------------------------------------------------------
  // bindings
  // ------------------------------------------------------------------

  setBinding (principal: string, name: string, rooms: string[]): BindingRow {
    if (!BINDING_RE.test(name)) throw new Error(`invalid binding name: ${name}`)
    for (const r of rooms) if (!ROOM_RE.test(r)) throw new Error(`invalid room: ${r}`)
    // Binding subscription also joins the principal to the rooms (§8.2).
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO bindings (principal, name, rooms, expired_pending) VALUES (?, ?, ?, 0)
         ON CONFLICT(principal, name) DO UPDATE SET rooms = excluded.rooms`,
      ).run(principal, name, JSON.stringify(rooms))
      for (const r of rooms) this.addMember(r, principal)
    })()
    return this.getBinding(principal, name)!
  }

  getBinding (principal: string, name: string): BindingRow | undefined {
    const row = this.db.prepare('SELECT principal, name, rooms, expired_pending FROM bindings WHERE principal = ? AND name = ?').get(principal, name) as any
    if (!row) return undefined
    return { principal: row.principal, name: row.name, rooms: JSON.parse(row.rooms), expiredPending: row.expired_pending }
  }

  bindingsOf (principal: string): BindingRow[] {
    const rows = this.db.prepare('SELECT principal, name, rooms, expired_pending FROM bindings WHERE principal = ?').all(principal) as any[]
    return rows.map(r => ({ principal: r.principal, name: r.name, rooms: JSON.parse(r.rooms), expiredPending: r.expired_pending }))
  }

  allBindings (): BindingRow[] {
    const rows = this.db.prepare('SELECT principal, name, rooms, expired_pending FROM bindings ORDER BY principal, name').all() as any[]
    return rows.map(r => ({ principal: r.principal, name: r.name, rooms: JSON.parse(r.rooms), expiredPending: r.expired_pending }))
  }

  deliverableBindingsForRoom (room: string, senderPrincipal: string): BindingRow[] {
    const rows = this.db.prepare(
      `SELECT principal, name, rooms, expired_pending FROM bindings WHERE principal != ? ORDER BY principal, name`,
    ).all(senderPrincipal) as any[]
    return rows.map(r => ({ principal: r.principal, name: r.name, rooms: JSON.parse(r.rooms), expiredPending: r.expired_pending }))
      .filter(b => b.rooms.includes(room))
  }

  // ------------------------------------------------------------------
  // membership (rooms a principal posted to or subscribed to)
  // ------------------------------------------------------------------

  addMember (room: string, principal: string): void {
    this.db.prepare('INSERT OR IGNORE INTO members (room, principal) VALUES (?, ?)').run(room, principal)
  }

  isMember (room: string, principal: string): boolean {
    return this.db.prepare('SELECT 1 FROM members WHERE room = ? AND principal = ?').get(room, principal) != null
  }

  memberRooms (principal: string): string[] {
    return (this.db.prepare('SELECT room FROM members WHERE principal = ? ORDER BY room').all(principal) as any[]).map(r => r.room)
  }

  // ------------------------------------------------------------------
  // messages
  // ------------------------------------------------------------------

  getMessage (id: string): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any
    return row == null ? undefined : this.rowToMessage(row)
  }

  getMessagesByIds (ids: string[]): StoredMessage[] {
    const out: StoredMessage[] = []
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?')
    for (const id of ids) {
      const row = stmt.get(id) as any
      if (row != null) out.push(this.rowToMessage(row))
    }
    return out
  }

  private rowToMessage (row: any): StoredMessage {
    return rowToStoredMessage(row)
  }


  /**
   * Run `fn` in one transaction (nested store transactions become savepoints).
   * Used by the send path so insert + recipient enqueue are all-or-nothing.
   */
  atomic<T> (fn: () => T): T {
    return this.db.transaction(fn)()
  }

  /**
   * Single transaction: bump seq, insert message, join sender to a room,
   * update the conversation counts (§8.5), prune retention (§8.4).
   */
  insertMessage (m: Omit<StoredMessage, 'id' | 'seq' | 'ts' | 'human' | 'reply_author' | 'reply_ts'> & { human: boolean }): StoredMessage & { conversationKey: string; enteredCooldown: boolean; operatorReset: boolean; expiredInline: boolean; resetConvs: string[] } {
    const now = Date.now()
    const conversationKey = m.scope === 'dm' ? dmPairKey(m.from, m.to[0]) : roomKey(m.room!)
    const toJson = JSON.stringify(m.to)
    const built: StoredMessage & { conversationKey: string; enteredCooldown: boolean; operatorReset: boolean; expiredInline: boolean; resetConvs: string[] } = this.db.transaction(() => {
      const id = ulid(now)
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages').get() as any).next as number
      // Resolve reply reference for the (re author HH:MM) label.
      let reply_author: string | undefined = undefined
      let reply_ts: number | undefined = undefined
      let referenced: StoredMessage | undefined
      if (m.reply_to !== undefined) {
        referenced = this.getMessage(m.reply_to)
        reply_author = referenced?.from
        reply_ts = referenced?.ts
      }
      this.db.prepare(
        `INSERT INTO messages (id, seq, ts, scope, room, to_json, fromp, text, reply_to, human, reply_author, reply_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, seq, now, m.scope, m.room ?? null, toJson, m.from, m.text, m.reply_to ?? null, m.human ? 1 : 0, reply_author ?? null, reply_ts ?? null)
      if (m.scope === 'room') this.addMember(m.room!, m.from)
      // A4: decay is evaluated on PRIOR state here, before this message is
      // enqueued (the caller enqueues after insertMessage, in the same txn).
      const bump = this.bumpConversation(conversationKey, m.from, m.human, now)
      const resetConvs: string[] = bump.operatorReset ? [conversationKey] : []
      // §8.5 (retained by A4): an operator DM reply also resets exactly its
      // REFERENCED direct conversation; never unrelated pairs, never via a peer.
      if (m.from === 'operator' && m.scope === 'dm' && referenced !== undefined && referenced.scope === 'dm') {
        const refConv = dmPairKey(referenced.from, referenced.to[0])
        if (refConv !== conversationKey && this.operatorResetConversation(refConv, now)) resetConvs.push(refConv)
      }
      const msg: StoredMessage = { id, seq, ts: now, scope: m.scope, room: m.room, to: m.to, from: m.from, text: m.text, reply_to: m.reply_to, human: m.human, reply_author, reply_ts }
      this.pruneRetention(msg)
      return { ...msg, conversationKey, ...bump, resetConvs }
    })()
    return built
  }

  /**
   * A4 conversation bookkeeping, inside the message-insert transaction:
   * operator → immediate reset; plugin human turn → no change; automatic →
   * (1) decay on prior state, (2) count, (3) enter cooldown at T.
   */
  private bumpConversation (conv: string, from: string, human: boolean, now: number): { enteredCooldown: boolean; operatorReset: boolean; expiredInline: boolean } {
    this.db.prepare('INSERT INTO conversations (conv) VALUES (?) ON CONFLICT(conv) DO NOTHING').run(conv)
    if (from === 'operator') {
      return { enteredCooldown: false, operatorReset: this.operatorResetConversation(conv, now), expiredInline: false }
    }
    if (human) return { enteredCooldown: false, operatorReset: false, expiredInline: false } // self-reported: neither counts nor resets
    // A cooldown whose deadline passed but whose timer has not run yet expires
    // first; the caller must then release held rows on EVERY binding (afterCommit).
    const expiredInline = this.expireConversation(conv, now)
    const prior = this.conversationRow(conv)!
    // (1) Decay check on PRIOR state: genuinely quiet for D (no cooldown, no wake work).
    if (prior.level > 0 && prior.coolingUntil === null && !this.hasWakeWork(conv)) {
      const quietSince = Math.max(prior.lastAutoTs ?? 0, prior.lastCooldownEnd ?? 0, prior.lastDrainTs ?? 0)
      if (now - quietSince >= this.cfg.cooldownDecayMs) this.db.prepare('UPDATE conversations SET level = 0 WHERE conv = ?').run(conv)
    }
    // (2) Count.
    this.db.prepare('UPDATE conversations SET auto_count = auto_count + 1, last_auto_ts = ? WHERE conv = ?').run(now, conv)
    const cur = this.conversationRow(conv)!
    // (3) Threshold: level := level + 1, cooling_until = now + C(level).
    if (cur.coolingUntil === null && cur.count >= this.cfg.loopBreakerLimit) {
      const level = cur.level + 1
      const until = now + Math.min(this.cfg.cooldownBaseMs * 2 ** (level - 1), this.cfg.cooldownMaxMs)
      this.db.prepare('UPDATE conversations SET level = ?, cooling_until = ? WHERE conv = ?').run(level, until, conv)
      this.recordCooldownNotices(conv, until)
      return { enteredCooldown: true, operatorReset: false, expiredInline }
    }
    return { enteredCooldown: false, operatorReset: false, expiredInline }
  }

  /** Operator override (A4): end any cooldown, reset count/level. Returns whether it was cooling. */
  private operatorResetConversation (conv: string, now: number): boolean {
    this.db.prepare('INSERT INTO conversations (conv) VALUES (?) ON CONFLICT(conv) DO NOTHING').run(conv)
    const was = this.conversationRow(conv)!
    this.db.prepare(
      `UPDATE conversations SET auto_count = 0, level = 0, cooling_until = NULL, paused = 0,
         last_cooldown_end = CASE WHEN cooling_until IS NOT NULL THEN ? ELSE last_cooldown_end END WHERE conv = ?`,
    ).run(now, conv)
    this.db.prepare('DELETE FROM cooldown_notices WHERE conv = ?').run(conv)
    return was.coolingUntil !== null
  }

  /** One notice row per binding that receives this conversation (A4 per-binding notice). */
  recordCooldownNotices (conv: string, until: number): void {
    let targets: BindingRow[]
    if (conv.startsWith('dm:')) {
      const [a, b] = conv.slice(3).split('|')
      targets = [...this.bindingsOf(a), ...this.bindingsOf(b)]
    } else {
      targets = this.deliverableBindingsForRoom(conv.slice(5), '')
    }
    const stmt = this.db.prepare(
      `INSERT INTO cooldown_notices (conv, binding_principal, binding_name, cooling_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(conv, binding_principal, binding_name) DO UPDATE SET cooling_until = excluded.cooling_until`,
    )
    for (const t of targets) stmt.run(conv, t.principal, t.name, until)
  }

  conversationRow (conv: string): ConversationRow | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE conv = ?').get(conv) as any
    if (r == null) return undefined
    return { conv: r.conv, count: r.auto_count, level: r.level, coolingUntil: r.cooling_until, lastAutoTs: r.last_auto_ts, lastCooldownEnd: r.last_cooldown_end, lastDrainTs: r.last_drain_ts }
  }

  isCooling (conv: string, now: number): boolean {
    const r = this.db.prepare('SELECT cooling_until FROM conversations WHERE conv = ?').get(conv) as any
    return r != null && r.cooling_until !== null && r.cooling_until > now
  }

  /** Any held, pending or outstanding wake row of the conversation (outstanding rows stay in pending until delivered). */
  hasWakeWork (conv: string): boolean {
    return this.db.prepare("SELECT 1 FROM pending WHERE conv = ? AND kind = 'wake' LIMIT 1").get(conv) != null
  }

  private expireConversation (conv: string, now: number): boolean {
    const r = this.db.prepare(
      'UPDATE conversations SET auto_count = 0, last_cooldown_end = cooling_until, cooling_until = NULL WHERE conv = ? AND cooling_until IS NOT NULL AND cooling_until <= ?',
    ).run(conv, now)
    return r.changes > 0
  }

  /** Expire every cooldown whose deadline passed; returns the expired conversations. */
  expireCooldowns (now: number): string[] {
    return this.db.transaction(() => {
      const due = (this.db.prepare('SELECT conv FROM conversations WHERE cooling_until IS NOT NULL AND cooling_until <= ?').all(now) as any[]).map(r => r.conv as string)
      for (const c of due) this.expireConversation(c, now)
      return due
    })()
  }

  nextCoolingExpiry (): number | undefined {
    const r = this.db.prepare('SELECT MIN(cooling_until) AS t FROM conversations WHERE cooling_until IS NOT NULL').get() as any
    return r?.t ?? undefined
  }

  /** Bindings holding wake rows of a conversation (to arm coalesce on release). */
  bindingsHoldingWake (conv: string): Array<{ principal: string; name: string }> {
    return (this.db.prepare("SELECT DISTINCT binding_principal AS p, binding_name AS n FROM pending WHERE conv = ? AND kind = 'wake'").all(conv) as any[])
      .map(r => ({ principal: r.p, name: r.n }))
  }

  /** Status view (A4): cooling conversations with deadline, level and held wake rows per binding. */
  coolingConversations (now: number): Array<{ conv: string; until: number; level: number; held: Record<string, number> }> {
    const rows = this.db.prepare('SELECT conv, cooling_until, level FROM conversations WHERE cooling_until IS NOT NULL AND cooling_until > ? ORDER BY conv').all(now) as any[]
    return rows.map(r => {
      const held: Record<string, number> = {}
      for (const h of this.db.prepare("SELECT binding_principal AS p, binding_name AS n, COUNT(*) AS c FROM pending WHERE conv = ? AND kind = 'wake' GROUP BY p, n").all(r.conv) as any[]) held[`${h.p}/${h.n}`] = h.c
      return { conv: r.conv, until: r.cooling_until, level: r.level, held }
    })
  }

  peekCooldownNotice (conv: string, principal: string, binding: string): string | undefined {
    const r = this.db.prepare('SELECT cooling_until FROM cooldown_notices WHERE conv = ? AND binding_principal = ? AND binding_name = ?').get(conv, principal, binding) as any
    if (r == null) return undefined
    const d = new Date(r.cooling_until)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return `[vx: conversation cooled down after ${this.cfg.loopBreakerLimit} automatic messages until ${hhmm}]`
  }

  takeCooldownNotice (conv: string, principal: string, binding: string): void {
    this.db.prepare('DELETE FROM cooldown_notices WHERE conv = ? AND binding_principal = ? AND binding_name = ?').run(conv, principal, binding)
  }

  // ---- persistent rolling wake budget (A4 §3) ----

  recordWakePush (principal: string, binding: string, conv: string, batchId: string, ts: number): void {
    this.db.prepare('INSERT INTO wake_pushes (binding_principal, binding_name, conv, batch_id, ts) VALUES (?, ?, ?, ?, ?)').run(principal, binding, conv, batchId, ts)
    this.db.prepare('DELETE FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? AND ts <= ?').run(principal, binding, ts - this.cfg.wakeWindowMs)
  }

  /** Wake push timestamps in the rolling window ending at `now`, ascending. */
  wakePushTimes (principal: string, binding: string, now: number): number[] {
    return (this.db.prepare('SELECT ts FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? AND ts > ? ORDER BY ts').all(principal, binding, now - this.cfg.wakeWindowMs) as any[]).map(r => r.ts)
  }

  wakePushCount (principal: string, binding: string, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? AND ts > ?').get(principal, binding, since) as any).c
  }

  lastWakePush (principal: string, binding: string): number {
    return (this.db.prepare('SELECT MAX(ts) AS t FROM wake_pushes WHERE binding_principal = ? AND binding_name = ?').get(principal, binding) as any)?.t ?? 0
  }

  /** LRS: last wake push time per conversation for this binding (within retained history). */
  lastServed (principal: string, binding: string): Map<string, number> {
    const rows = this.db.prepare('SELECT conv, MAX(ts) AS t FROM wake_pushes WHERE binding_principal = ? AND binding_name = ? GROUP BY conv').all(principal, binding) as any[]
    return new Map(rows.map(r => [r.conv as string, r.t as number]))
  }

  // Retention (§8.4): per conversation (a room, or one unordered DM pair, the
  // same unit as §8.5), keep the newest N and nothing older than the age limit.
  // Pending rows are never pruned. `seq < (Nth newest seq)` keeps exactly N; a
  // conversation with fewer than N rows yields NULL and deletes nothing.
  private pruneRetention (m: { scope: 'room' | 'dm'; room?: string; from: string; to: string[]; text: string }): void {
    let where: string
    let params: Array<string | number>
    let max: number
    let days: number
    if (m.scope === 'room') {
      where = 'room = ?'
      params = [m.room!]
      max = this.cfg.roomMaxMessages
      days = this.cfg.roomMaxDays
    } else {
      const [a, b] = [m.from, m.to[0]]
      where = "scope = 'dm' AND ((fromp = ? AND to_json = ?) OR (fromp = ? AND to_json = ?))"
      params = [a, JSON.stringify([b]), b, JSON.stringify([a])]
      max = this.cfg.dmMaxMessages
      days = this.cfg.dmMaxDays
    }
    this.db.prepare(
      `DELETE FROM messages WHERE ${where} AND id NOT IN (SELECT msg_id FROM pending) AND seq <
         (SELECT seq FROM messages WHERE ${where} ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
    ).run(...params, ...params, Math.max(0, max - 1))
    this.db.prepare(
      `DELETE FROM messages WHERE ${where} AND id NOT IN (SELECT msg_id FROM pending) AND ts < ?`,
    ).run(...params, Date.now() - days * 86_400_000)
  }

  roomLog (room: string, after: number, limit: number): StoredMessage[] {
    return logs.roomLog(this, room, after, limit)
  }

  dmLog (principal: string, after: number, limit: number): StoredMessage[] {
    return logs.dmLog(this, principal, after, limit)
  }

  recentFor (principal: string, limit: number): StoredMessage[] {
    return logs.recentFor(this, principal, limit)
  }

  recentGlobal (limit: number): StoredMessage[] {
    return logs.recentGlobal(this, limit)
  }

  dmLogAll (after: number, limit: number): StoredMessage[] {
    return logs.dmLogAll(this, after, limit)
  }

  roomSeqHead (room: string): number {
    return logs.roomSeqHead(this, room)
  }

  seqHead (): number {
    return logs.seqHead(this)
  }

  // ------------------------------------------------------------------
  // pending queues and deliveries: delegates to store-pending.ts
  // ------------------------------------------------------------------

  enqueuePending (principal: string, binding: string, m: StoredMessage, kind: 'wake' | 'passive'):
    { overflowDropped: number; nowOverBoundary: boolean } {
    return pending.enqueuePending(this, principal, binding, m, kind)
  }
  pendingStats (principal: string, binding: string): { count: number; bytes: number } {
    return pending.pendingStats(this, principal, binding)
  }
  pendingCountByKind (principal: string, binding: string): { wake: number; passive: number } {
    return pending.pendingCountByKind(this, principal, binding)
  }
  pendingMessages (principal: string, binding: string, kind: 'wake' | 'passive'): StoredMessage[] {
    return pending.pendingMessages(this, principal, binding, kind)
  }
  deletePending (principal: string, binding: string, ids: string[]): void {
    return pending.deletePending(this, principal, binding, ids)
  }
  consumeExpiredNotice (principal: string, binding: string): number {
    return pending.consumeExpiredNotice(this, principal, binding)
  }
  insertBatchRow (b: { id: string; principal: string; binding: string; kind: 'wake' | 'passive'; msgIds: string[]; notices: string[] }): void {
    return pending.insertBatchRow(this, b)
  }
  getBatch (id: string): BatchRow | undefined {
    return pending.getBatch(this, id)
  }
  outstandingBatch (principal: string, binding: string, kind: 'wake' | 'passive'): BatchRow | undefined {
    return pending.outstandingBatch(this, principal, binding, kind)
  }
  outstandingBatchesOf (principal: string, binding: string): BatchRow[] {
    return pending.outstandingBatchesOf(this, principal, binding)
  }
  deliverBatch (id: string, evidence: string): void {
    return pending.deliverBatch(this, id, evidence)
  }
  markBatchFailed (id: string, error: string): void {
    return pending.markBatchFailed(this, id, error)
  }
  keepBatchPending (id: string): void {
    return pending.keepBatchPending(this, id)
  }
  deleteBatchRow (id: string): void {
    return pending.deleteBatchRow(this, id)
  }
}
