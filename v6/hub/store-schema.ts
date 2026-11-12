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
  /** One-line [vx: ...] notices rendered above the messages; kept for replay. */
  notices: string[]
  created: number
}

export interface BindingRow {
  principal: string
  name: string
  rooms: string[]
  expiredPending: number
}

export const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS wake_pushes (
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  conv TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wake_pushes_binding ON wake_pushes(binding_principal, binding_name, ts);
CREATE TABLE IF NOT EXISTS cooldown_notices (
  conv TEXT NOT NULL,
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  cooling_until INTEGER NOT NULL,
  PRIMARY KEY (conv, binding_principal, binding_name)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  binding_principal TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT,
  error TEXT,
  msg_ids TEXT NOT NULL,
  notices TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL
);
`

export const dmPairKey = (a: string, b: string): string => `dm:${[a, b].sort().join('|')}`
export const roomKey = (room: string): string => `room:${room}`
/** The §8.5 conversation of a message: the room, or the unordered DM pair. */
export const convKeyOf = (m: { scope: 'room' | 'dm'; room?: string; from: string; to: string[] }): string =>
  m.scope === 'dm' ? dmPairKey(m.from, m.to[0]) : roomKey(m.room!)

export interface ConversationRow {
  conv: string
  count: number
  level: number
  coolingUntil: number | null
  lastAutoTs: number | null
  lastCooldownEnd: number | null
  lastDrainTs: number | null
}

export class DuplicateBinding extends Error { constructor () { super('binding busy'); this.name = 'DuplicateBinding' } }
export function tokenHash (token: string): string {
  return sha256Hex(token)
}

export function utf8Count (s: string): number {
  return new TextEncoder().encode(s).length
}

export function sha256Hex (s: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(s)
  return hasher.digest('hex')
}
