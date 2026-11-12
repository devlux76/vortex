// Public keys for signed remote/edge authentication (A7 §2–§4). The hub stores
// only public keys; nothing here can sign. One principal may hold one key per
// device. `custody` is the tier the operator declared at enrollment: the hub
// cannot verify it, so an `unsealed` key is always limited to named rooms and
// a bounded lifetime, and may not send DMs or open delivery streams.
import type { HubStore } from './store.ts'
import type { KeyAlg } from '../client/edge-sign.ts'

export type Custody = 'hardware' | 'separate-user' | 'os-keystore' | 'unsealed'
export const CUSTODY: readonly Custody[] = ['hardware', 'separate-user', 'os-keystore', 'unsealed']

/** An unsealed key lives at most this long (A7 question 4, answered on #2). */
export const UNSEALED_MAX_TTL_MS = 7 * 24 * 3_600_000

export interface KeyRow {
  key_id: string
  principal: string
  alg: KeyAlg
  spki: string // base64
  custody: Custody
  rooms: string[] | null // null = no room limit (sealed tiers only)
  expires: number | null
  created: number
  revoked: number | null
}

export const KEYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS principal_keys (
  key_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  alg TEXT NOT NULL,
  spki TEXT NOT NULL,
  custody TEXT NOT NULL,
  rooms TEXT,
  expires INTEGER,
  created INTEGER NOT NULL,
  revoked INTEGER
);
CREATE INDEX IF NOT EXISTS principal_keys_principal ON principal_keys(principal);
`

function rowOf (r: any): KeyRow {
  return { ...r, rooms: r.rooms === null ? null : JSON.parse(r.rooms) }
}

export function ensureKeysSchema (s: HubStore): void {
  s.db.exec(KEYS_SCHEMA)
}

export function addKey (s: HubStore, k: Omit<KeyRow, 'created' | 'revoked'>, now = Date.now()): KeyRow {
  if (k.custody === 'unsealed') {
    if (k.rooms === null || k.rooms.length === 0) throw new Error('an unsealed key must be limited to named rooms')
    if (k.expires === null || k.expires - now > UNSEALED_MAX_TTL_MS) throw new Error('an unsealed key must expire within 7 days')
  }
  if (!CUSTODY.includes(k.custody)) throw new Error(`unknown custody: ${k.custody}`)
  ensureKeysSchema(s)
  s.db.prepare(`INSERT INTO principal_keys (key_id, principal, alg, spki, custody, rooms, expires, created, revoked)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(k.key_id, k.principal, k.alg, k.spki, k.custody, k.rooms === null ? null : JSON.stringify(k.rooms), k.expires, now)
  return getKey(s, k.key_id)!
}

export function getKey (s: HubStore, keyId: string): KeyRow | undefined {
  ensureKeysSchema(s)
  const r = s.db.prepare('SELECT * FROM principal_keys WHERE key_id = ?').get(keyId)
  return r === null || r === undefined ? undefined : rowOf(r)
}

export function listKeys (s: HubStore, principal?: string): KeyRow[] {
  ensureKeysSchema(s)
  const rows = principal === undefined
    ? s.db.prepare('SELECT * FROM principal_keys ORDER BY principal, created').all()
    : s.db.prepare('SELECT * FROM principal_keys WHERE principal = ? ORDER BY created').all(principal)
  return (rows as any[]).map(rowOf)
}

/** Revocation takes effect on the next request (A7 §4). Returns false if unknown. */
export function revokeKey (s: HubStore, keyId: string, now = Date.now()): boolean {
  ensureKeysSchema(s)
  return s.db.prepare('UPDATE principal_keys SET revoked = ? WHERE key_id = ? AND revoked IS NULL').run(now, keyId).changes === 1
}
