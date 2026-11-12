// Hub message-log readers (room/DM logs, recent views, seq heads): plain
// functions over a HubStore; HubStore's methods of the same names delegate here.
import type { HubStore } from './store.ts'
import type { StoredMessage } from './store-schema.ts'
import { rowToStoredMessage } from './store-pending.ts'

export function roomLog (s: HubStore, room: string, after: number, limit: number): StoredMessage[] {
  const rows = s.db.prepare(
    `SELECT * FROM messages WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?`,
  ).all(room, after, limit) as any[]
  return rows.map(r => rowToStoredMessage(r))
}

export function dmLog (s: HubStore, principal: string, after: number, limit: number): StoredMessage[] {
  const rows = s.db.prepare(
    `SELECT * FROM messages WHERE scope = 'dm' AND (fromp = ? OR to_json = ?) AND seq > ? ORDER BY seq LIMIT ?`,
  ).all(principal, JSON.stringify([principal]), after, limit) as any[]
  return rows.map(r => rowToStoredMessage(r))
}

/** msgs visible to a principal: rooms they are a member of + their own DMs. */
export function recentFor (s: HubStore, principal: string, limit: number): StoredMessage[] {
  const rows = s.db.prepare(
    `SELECT * FROM messages
     WHERE (scope = 'room' AND room IN (SELECT room FROM members WHERE principal = ?))
        OR (scope = 'dm' AND (fromp = ? OR to_json = ?))
     ORDER BY seq DESC LIMIT ?`,
  ).all(principal, principal, JSON.stringify([principal]), limit) as any[]
  return rows.map(r => rowToStoredMessage(r))
}

/** Operator-sovereign recent: every message, newest-first (§8.2 operator). */
export function recentGlobal (s: HubStore, limit: number): StoredMessage[] {
  return (s.db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(limit) as any[])
    .map(r => rowToStoredMessage(r))
}

/** Operator-sovereign DM log across all pairs (operator-added endpoint; disclose). */
export function dmLogAll (s: HubStore, after: number, limit: number): StoredMessage[] {
  const rows = s.db.prepare(
    `SELECT * FROM messages WHERE scope = 'dm' AND seq > ? ORDER BY seq LIMIT ?`,
  ).all(after, limit) as any[]
  return rows.map(r => rowToStoredMessage(r))
}

export function roomSeqHead (s: HubStore, room: string): number {
  const row = s.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room = ?').get(room) as any
  return row.s
}

export function seqHead (s: HubStore): number {
  const row = s.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages').get() as any
  return row.s
}
