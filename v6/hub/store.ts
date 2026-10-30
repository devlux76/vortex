// Hub storage: SQLite (bun:sqlite, WAL) under $XDG_STATE_HOME/vortex/hub.db.
// Schema per docs/v6-proposal.md §8.2 (principals, bindings, messages,
// deliveries) plus the bookkeeping tables needed to survive restarts:
// members, conversations (loop breaker), pending (per-binding queues).
// All API-visible numbers come from HubConfig defaults (§8 preamble).
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { DEFAULT_CONFIG, PRINCIPAL_RE, ROOM_RE, BINDING_RE, type HubConfig } from './config.ts'
import { ulid } from '../client/ulid.ts'

export interface StoredMessage {
  id: string
  seq: number
  ts: number
  scope: 'room' | 'dm'
  room?: string
  to: string[]
  from: string
  text: string
  reply_to?: string
  human: boolean
  reply_author?: string
  reply_ts?: number
}

export interface BatchRow {
  id: string
  principal: string
  binding: string
  kind: 'wake' | 'passive'
  status: 'pending' | 'failed' | 'delivered'
  error?: string
  msgIds: string[]
  created: number
}

export interface BindingRow {
  principal: string
  name: string
  rooms: string[]
  expiredPending: number
}

/* Rendered-bounds checking lives in client/render.ts (fitSingle); the hub's
 * api.ts and delivery.ts import it from there, not from the store. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bindings (
  principal TEXT NOT NULL,
  name TEXT NOT NULL,
  rooms TEXT NOT NULL,
  expired_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal, name)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  scope TEXT NOT NULL,
  room TEXT,
  to_json TEXT NOT NULL,
  fromp TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  human INTEGER NOT NULL,
  reply_author TEXT,
  reply_ts INTEGER
);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room, seq);
CREATE INDEX IF NOT EXISTS messages_dm ON messages(scope, seq);
CREATE TABLE IF NOT EXISTS members (
  room TEXT NOT NULL,
  principal TEXT NOT NULL,
  PRIMARY KEY (room, principal)
);
CREATE TABLE IF NOT EXISTS conversations (
  conv TEXT PRIMARY KEY,
  auto_count INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  notice_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pending (
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  enqueued TEXT NOT NULL,
  message_bytes INTEGER NOT NULL,
  PRIMARY KEY (binding_principal, binding_name, msg_id)
);
CREATE INDEX IF NOT EXISTS pending_order ON pending(binding_principal, binding_name, kind, enqueued);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT,
  error TEXT,
  msg_ids TEXT NOT NULL,
  created INTEGER NOT NULL
);
`

export const dmPairKey = (a: string, b: string): string => `dm:${[a, b].sort().join('|')}`
export const roomKey = (room: string): string => `room:${room}`

export class DuplicateBinding extends Error { constructor () { super('binding busy'); this.name = 'DuplicateBinding' } }
export function tokenHash (token: string): string {
  return sha256Hex(token)
}

export class HubStore {
  readonly db: Database
  readonly cfg: HubConfig

  constructor (dbPath: string, cfg: HubConfig = DEFAULT_CONFIG) {
    this.cfg = cfg
    mkdirSync(dbPath.slice(0, dbPath.lastIndexOf('/')), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
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
    return this.db.prepare('SELECT 1 FROM principals WHERE name = ?').get(name) !== undefined
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
    return this.db.prepare('SELECT 1 FROM members WHERE room = ? AND principal = ?').get(room, principal) !== undefined
  }

  memberRooms (principal: string): string[] {
    return (this.db.prepare('SELECT room FROM members WHERE principal = ? ORDER BY room').all(principal) as any[]).map(r => r.room)
  }

  // ------------------------------------------------------------------
  // messages
  // ------------------------------------------------------------------

  getMessage (id: string): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any
    return row === undefined ? undefined : this.rowToMessage(row)
  }

  getMessagesByIds (ids: string[]): StoredMessage[] {
    const out: StoredMessage[] = []
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?')
    for (const id of ids) {
      const row = stmt.get(id) as any
      if (row !== undefined) out.push(this.rowToMessage(row))
    }
    return out
  }

  private rowToMessage (row: any): StoredMessage {
    return {
      id: row.id,
      seq: row.seq,
      ts: row.ts,
      scope: row.scope,
      room: row.room === null ? undefined : row.room,
      to: JSON.parse(row.to_json),
      from: row.fromp,
      text: row.text,
      reply_to: row.reply_to === null ? undefined : row.reply_to,
      human: row.human === 1,
      reply_author: row.reply_author === null ? undefined : row.reply_author,
      reply_ts: row.reply_ts === null ? undefined : row.reply_ts,
    }
  }

  /**
   * Single transaction: bump seq, insert message, join sender to a room,
   * update the conversation counts (§8.5), prune retention (§8.4).
   */
  insertMessage (m: Omit<StoredMessage, 'id' | 'seq' | 'ts' | 'human' | 'reply_author' | 'reply_ts'> & { human: boolean }): StoredMessage & { conversationKey: string; pausedNotice: boolean } {
    const now = Date.now()
    const conversationKey = m.scope === 'dm' ? dmPairKey(m.from, m.to[0]) : roomKey(m.room!)
    const toJson = JSON.stringify(m.to)
    const built: StoredMessage & { conversationKey: string; pausedNotice: boolean } = this.db.transaction(() => {
      const id = ulid(now)
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages').get() as any).next as number
      // Resolve reply reference for the (re author HH:MM) label.
      let reply_author: string | undefined = undefined
      let reply_ts: number | undefined = undefined
      if (m.reply_to !== undefined) {
        const r = this.getMessage(m.reply_to)
        reply_author = r?.from
        reply_ts = r?.ts
      }
      this.db.prepare(
        `INSERT INTO messages (id, seq, ts, scope, room, to_json, fromp, text, reply_to, human, reply_author, reply_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, seq, now, m.scope, m.room ?? null, toJson, m.from, m.text, m.reply_to ?? null, m.human ? 1 : 0, reply_author ?? null, reply_ts ?? null)
      if (m.scope === 'room') this.addMember(m.room!, m.from)
      const pausedNotice = this.bumpConversation(conversationKey, m.from, m.human)
      const msg: StoredMessage = { id, seq, ts: now, scope: m.scope, room: m.room, to: m.to, from: m.from, text: m.text, reply_to: m.reply_to, human: m.human, reply_author, reply_ts }
      this.pruneRetention(msg)
      return { ...msg, conversationKey, pausedNotice }
    })()
    return built
  }

  private bumpConversation (conv: string, from: string, human: boolean): boolean {
    if (from === 'operator') {
      // Operator message resets the count and lifts the pause (§8.5).
      this.db.prepare(
        `INSERT INTO conversations (conv, auto_count, paused, notice_pending) VALUES (?, 0, 0, 0)
         ON CONFLICT(conv) DO UPDATE SET auto_count = 0, paused = 0`,
      ).run(conv)
      return false
    }
    if (human) {
      // A plugin-reported human turn neither increments nor resets (§8.5).
      this.db.prepare('INSERT INTO conversations (conv) VALUES (?) ON CONFLICT(conv) DO NOTHING').run(conv)
      return false
    }
    const row = this.db.prepare('SELECT auto_count, paused FROM conversations WHERE conv = ?').get(conv) as any
    const prevCount = row?.auto_count ?? 0
    const prevPaused = row?.paused === 1
    const count = prevCount + 1
    this.db.prepare(
      `INSERT INTO conversations (conv, auto_count, paused, notice_pending) VALUES (?, ?, 0, 0)
       ON CONFLICT(conv) DO UPDATE SET auto_count = excluded.auto_count`,
    ).run(conv, count)
    if (!prevPaused && count >= this.cfg.loopBreakerLimit) {
      this.db.prepare('UPDATE conversations SET paused = 1, notice_pending = 1 WHERE conv = ?').run(conv)
      return true
    }
    return false
  }

  conversationState (conv: string): { autoCount: number; paused: boolean; noticePending: boolean } {
    const row = this.db.prepare('SELECT auto_count, paused, notice_pending FROM conversations WHERE conv = ?').get(conv) as any
    return { autoCount: row?.auto_count ?? 0, paused: row?.paused === 1, noticePending: row?.notice_pending === 1 }
  }

  pausedConversations (): Array<{ conv: string; autoCount: number; noticePending: boolean }> {
    return (this.db.prepare('SELECT conv, auto_count, notice_pending FROM conversations WHERE paused = 1 ORDER BY conv').all() as any[])
      .map(r => ({ conv: r.conv, autoCount: r.auto_count, noticePending: r.notice_pending === 1 }))
  }

  /** Take a paused-notice marker for render-time addition, once per conversation. */
  takeConversationNotice (conv: string): string | undefined {
    const row = this.db.prepare('SELECT notice_pending FROM conversations WHERE conv = ?').get(conv) as any
    if (row === undefined || row.notice_pending !== 1) return undefined
    this.db.prepare('UPDATE conversations SET notice_pending = 0 WHERE conv = ?').run(conv)
    return `[vx: conversation paused after ${this.cfg.loopBreakerLimit} automatic messages; operator message resumes]`
  }

  // Retention (§8.4): pending rows are never pruned; only delivered/free msgs.
  private pruneRetention (m: { scope: 'room' | 'dm'; room?: string; from: string; to: string[]; text: string }): void {
    if (m.scope === 'room') {
      // keep last roomMaxMessages (§8.4)
      this.db.prepare(
        `DELETE FROM messages WHERE room = ? AND id NOT IN (SELECT msg_id FROM pending) AND seq <=
           (SELECT COALESCE(MIN(seq), 0) - 1 FROM (SELECT seq FROM messages WHERE room = ? ORDER BY seq DESC LIMIT 1 OFFSET ?))`,
      ).run(m.room!, m.room!, this.cfg.roomMaxMessages)
      const cutoff = Date.now() - this.cfg.roomMaxDays * 86_400_000
      this.db.prepare(
        `DELETE FROM messages WHERE room = ? AND id NOT IN (SELECT msg_id FROM pending) AND ts < ?`,
      ).run(m.room!, cutoff)
    } else {
      this.db.prepare(
        `DELETE FROM messages WHERE scope = 'dm' AND id NOT IN (SELECT msg_id FROM pending) AND seq <=
           (SELECT COALESCE(MIN(seq), 0) - 1 FROM (SELECT seq FROM messages WHERE scope = 'dm' AND (fromp = ? OR to_json = ?) ORDER BY seq DESC LIMIT 1 OFFSET ?))`,
      ).run(m.from, JSON.stringify(m.to), this.cfg.dmMaxMessages)
      const cutoff = Date.now() - this.cfg.dmMaxDays * 86_400_000
      this.db.prepare(
        `DELETE FROM messages WHERE scope = 'dm' AND id NOT IN (SELECT msg_id FROM pending) AND ts < ? AND (fromp = ? OR to_json = ?)`,
      ).run(cutoff, m.from, JSON.stringify(m.to))
    }
  }

  roomLog (room: string, after: number, limit: number): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(room, after, limit) as any[]
    return rows.map(r => this.rowToMessage(r))
  }

  dmLog (principal: string, after: number, limit: number): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE scope = 'dm' AND (fromp = ? OR to_json = ?) AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(principal, JSON.stringify([principal]), after, limit) as any[]
    return rows.map(r => this.rowToMessage(r))
  }

  /** msgs visible to a principal: rooms they are a member of + their own DMs. */
  recentFor (principal: string, limit: number): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE (scope = 'room' AND room IN (SELECT room FROM members WHERE principal = ?))
          OR (scope = 'dm' AND (fromp = ? OR to_json = ?))
       ORDER BY seq DESC LIMIT ?`,
    ).all(principal, principal, JSON.stringify([principal]), limit) as any[]
    return rows.map(r => this.rowToMessage(r))
  }

  /** Operator-sovereign recent: every message, newest-first (§8.2 operator). */
  recentGlobal (limit: number): StoredMessage[] {
    return (this.db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(limit) as any[])
      .map(r => this.rowToMessage(r))
  }

  /** Operator-sovereign DM log across all pairs (operator-added endpoint; disclose). */
  dmLogAll (after: number, limit: number): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE scope = 'dm' AND seq > ? ORDER BY seq LIMIT ?`,
    ).all(after, limit) as any[]
    return rows.map(r => this.rowToMessage(r))
  }

  roomSeqHead (room: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room = ?').get(room) as any
    return row.s
  }

  seqHead (): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages').get() as any
    return row.s
  }

  // ------------------------------------------------------------------
  // pending queues (per binding, wake and passive; §8.4)
  // ------------------------------------------------------------------

  enqueuePending (principal: string, binding: string, m: StoredMessage, kind: 'wake' | 'passive'):
    { overflowDropped: number; nowOverBoundary: boolean } {
    let dropped = 0
    let nowOverBoundary = false
    const bytes = utf8Count(m.text)
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO pending (binding_principal, binding_name, msg_id, kind, enqueued, message_bytes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(principal, binding, m.id, kind, ulid(Date.now()), bytes)
      const stats = this.pendingStats(principal, binding)
      while (stats.count > this.cfg.pendingMaxMessages || stats.bytes > this.cfg.pendingMaxBytes) {
        const oldest = this.db.prepare(
          `SELECT msg_id FROM pending WHERE binding_principal = ? AND binding_name = ? ORDER BY enqueued LIMIT 1`,
        ).get(principal, binding) as any
        if (oldest === undefined) break
        this.db.prepare('DELETE FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id = ?').run(principal, binding, oldest.msg_id)
        const row = this.pendingStats(principal, binding)
        stats.count = row.count
        stats.bytes = row.bytes
        dropped++
      }
      if (dropped > 0) {
        // Expire notice rides the next batch for this binding (§8.4), persisted.
        this.db.prepare('UPDATE bindings SET expired_pending = expired_pending + ? WHERE principal = ? AND name = ?').run(dropped, principal, binding)
        nowOverBoundary = true
      }
    })()
    return { overflowDropped: dropped, nowOverBoundary }
  }

  pendingStats (principal: string, binding: string): { count: number; bytes: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(message_bytes), 0) AS b FROM pending WHERE binding_principal = ? AND binding_name = ?`,
    ).get(principal, binding) as any
    return { count: row.c, bytes: row.b }
  }

  pendingCountByKind (principal: string, binding: string): { wake: number; passive: number } {
    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) AS c FROM pending WHERE binding_principal = ? AND binding_name = ? GROUP BY kind`,
    ).all(principal, binding) as any[]
    const out = { wake: 0, passive: 0 }
    for (const r of rows) (out as any)[r.kind] = r.c
    return out
  }

  pendingMessages (principal: string, binding: string, kind: 'wake' | 'passive'): StoredMessage[] {
    const rows = this.db.prepare(
      `SELECT m.* FROM pending p JOIN messages m ON m.id = p.msg_id
       WHERE p.binding_principal = ? AND p.binding_name = ? AND p.kind = ?
       ORDER BY p.enqueued`,
    ).all(principal, binding, kind) as any[]
    return rows.map(r => this.rowToMessage(r))
  }

  deletePending (ids: string[]): void {
    for (const id of ids) this.db.prepare('DELETE FROM pending WHERE msg_id = ?').run(id)
  }

  consumeExpiredNotice (principal: string, binding: string): number {
    const b = this.getBinding(principal, binding)
    if (b === undefined) return 0
    const n = b.expiredPending
    if (n > 0) this.db.prepare('UPDATE bindings SET expired_pending = 0 WHERE principal = ? AND name = ?').run(principal, binding)
    return n
  }

  // ------------------------------------------------------------------
  // deliveries (batch records; id stable across retries §8.4)
  // ------------------------------------------------------------------

  insertBatchRow (b: { id: string; principal: string; binding: string; kind: 'wake' | 'passive'; msgIds: string[] }): void {
    this.db.prepare(
      `INSERT INTO deliveries (id, binding_principal, binding_name, kind, status, msg_ids, created)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(b.id, b.principal, b.binding, b.kind, JSON.stringify(b.msgIds), Date.now())
  }

  getBatch (id: string): BatchRow | undefined {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as any
    if (row === undefined) return undefined
    return {
      id: row.id, principal: row.binding_principal, binding: row.binding_name,
      kind: row.kind, status: row.status, error: row.error === null ? undefined : row.error,
      msgIds: JSON.parse(row.msg_ids), created: row.created,
    }
  }

  outstandingBatch (principal: string, binding: string, kind: 'wake' | 'passive'): BatchRow | undefined {
    // At most one outstanding batch of each kind (§8.4): newest pending/failed row.
    const row = this.db.prepare(
      `SELECT * FROM deliveries WHERE binding_principal = ? AND binding_name = ? AND kind = ? AND status IN ('pending','failed')
       ORDER BY created DESC, id DESC LIMIT 1`,
    ).get(principal, binding, kind) as any
    if (!row) return undefined
    return { id: row.id, principal: row.binding_principal, binding: row.binding_name, kind: row.kind, status: row.status, error: row.error === null ? undefined : row.error, msgIds: JSON.parse(row.msg_ids), created: row.created }
  }

  outstandingBatchesOf (principal: string, binding: string): BatchRow[] {
    const wake = this.outstandingBatch(principal, binding, 'wake')
    const passive = this.outstandingBatch(principal, binding, 'passive')
    return [wake, passive].filter((x): x is BatchRow => x !== undefined)
  }

  deliverBatch (id: string, evidence: string): void {
    this.db.transaction(() => {
      const row = this.getBatch(id)
      if (row !== undefined) {
        this.deletePending(row.msgIds)
        this.db.prepare(
          `UPDATE deliveries SET status = 'delivered', evidence = ? WHERE id = ?`,
        ).run(evidence, id)
        // Keep the newest delivered row per binding for status display; prune the rest.
        this.db.prepare(
          `DELETE FROM deliveries
           WHERE binding_principal = ? AND binding_name = ? AND status = 'delivered' AND id != ?`,
        ).run(row.principal, row.binding, id)
      }
    })()
  }

  markBatchFailed (id: string, error: string): void {
    this.db.prepare(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`).run(error, id)
  }

  keepBatchPending (id: string): void {
    this.db.prepare(`UPDATE deliveries SET status = 'pending', error = NULL WHERE id = ?`).run(id)
  }

  deleteBatchRow (id: string): void {
    this.db.prepare('DELETE FROM deliveries WHERE id = ?').run(id)
  }
}

export function utf8Count (s: string): number {
  return new TextEncoder().encode(s).length
}

export function sha256Hex (s: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(s)
  return hasher.digest('hex')
}
