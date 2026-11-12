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
CREATE TABLE IF NOT EXISTS edge_nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX IF NOT EXISTS edge_nonces_expires ON edge_nonces(expires);
`

function rowOf (r: any): KeyRow {
  return { ...r, rooms: r.rooms === null ? null : JSON.parse(r.rooms) }
}

const ready = new WeakSet<HubStore>()

export function ensureKeysSchema (s: HubStore): void {
  if (ready.has(s)) return
  s.db.exec(KEYS_SCHEMA)
  ready.add(s)
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

/**
 * Records a nonce as used until `expires`; false if it was already used. The
 * table survives restarts, so a signed request cannot be replayed after the
 * hub restarts within its skew window (Sun's QA finding 1 on #7).
 */
export function claimNonce (s: HubStore, keyId: string, nonce: string, expires: number, now = Date.now()): boolean {
  ensureKeysSchema(s)
  s.db.prepare('DELETE FROM edge_nonces WHERE expires <= ?').run(now)
  return s.db.prepare('INSERT OR IGNORE INTO edge_nonces (key_id, nonce, expires) VALUES (?, ?, ?)').run(keyId, nonce, expires).changes === 1
}

export function nonceCount (s: HubStore): number {
  ensureKeysSchema(s)
  return (s.db.prepare('SELECT COUNT(*) AS n FROM edge_nonces').get() as { n: number }).n
}

/** Revocation takes effect on the next request (A7 §4). Returns false if unknown. */
export function revokeKey (s: HubStore, keyId: string, now = Date.now()): boolean {
  ensureKeysSchema(s)
  return s.db.prepare('UPDATE principal_keys SET revoked = ? WHERE key_id = ? AND revoked IS NULL').run(now, keyId).changes === 1
}
