// Signed HTTP requests for remote and edge peers (docs/v6-amendment-a7-remote-keys.md §3).
// Shared by the hub (verify) and the edge client (sign), so both build the
// exact same bytes. No bearer secret crosses the wire: each request carries a
// signature over its method, path, body hash, a fresh nonce and a timestamp,
// bound to one hub's id, so a captured header authorizes nothing else.

export const AUTH_DOMAIN = 'vortex-v6-auth\0'
export const AUTH_HEADER = 'vx-auth'

export type KeyAlg = 'ed25519' | 'p256'

export const ALGS: Record<KeyAlg, { importParams: any; signParams: any; generate: any }> = {
  ed25519: { importParams: { name: 'Ed25519' }, signParams: { name: 'Ed25519' }, generate: { name: 'Ed25519' } },
  p256: {
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
    signParams: { name: 'ECDSA', hash: 'SHA-256' },
    generate: { name: 'ECDSA', namedCurve: 'P-256' },
  },
}

export interface AuthFields {
  principal: string
  key_id: string
  hub: string
  nonce: string
  ts: number
}

export const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/
export const KEY_ID_RE = /^[0-9a-f]{64}$/

const enc = new TextEncoder()

export function b64url (bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64url')
}

export function hex (bytes: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(bytes)).toString('hex')
}

export async function sha256Hex (bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** The key id is the SHA-256 of the SubjectPublicKeyInfo DER (A7 §4). */
export async function keyIdOf (spki: Uint8Array): Promise<string> {
  return sha256Hex(spki)
}

/** The exact bytes that are signed. Key order is fixed; nothing is optional. */
export function signedBytes (f: AuthFields, method: string, path: string, bodySha256: string): Uint8Array {
  const payload = JSON.stringify({
    v: 1, kind: 'http', principal: f.principal, key_id: f.key_id, hub: f.hub,
    nonce: f.nonce, ts: f.ts, method: method.toUpperCase(), path, body: bodySha256,
  })
  return enc.encode(AUTH_DOMAIN + payload)
}

/** `VX-Auth: <principal> <key_id> <ts> <nonce> <sig>`, all URL-safe tokens. */
export function formatAuthHeader (f: AuthFields, sig: Uint8Array | ArrayBuffer): string {
  return `${f.principal} ${f.key_id} ${f.ts} ${f.nonce} ${b64url(sig)}`
}

export function parseAuthHeader (value: string, hub: string): { fields: AuthFields; sig: Uint8Array } | undefined {
  const parts = value.trim().split(' ')
  if (parts.length !== 5) return undefined
  const [principal, key_id, tsRaw, nonce, sigRaw] = parts
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(principal) || !KEY_ID_RE.test(key_id) || !NONCE_RE.test(nonce)) return undefined
  if (!/^[0-9]{1,16}$/.test(tsRaw) || !/^[A-Za-z0-9_-]{40,200}$/.test(sigRaw)) return undefined
  const ts = Number(tsRaw)
  if (!Number.isSafeInteger(ts)) return undefined
  return { fields: { principal, key_id, hub, nonce, ts }, sig: new Uint8Array(Buffer.from(sigRaw, 'base64url')) }
}

/** Signs one request. `key` may be (and for sealed tiers must be) non-extractable. */
export async function signRequest (
  key: CryptoKey, alg: KeyAlg, ids: { principal: string; key_id: string; hub: string },
  method: string, path: string, body: Uint8Array, now = Date.now(),
): Promise<string> {
  const f: AuthFields = { ...ids, nonce: b64url(crypto.getRandomValues(new Uint8Array(24))), ts: now }
  const sig = await crypto.subtle.sign(ALGS[alg].signParams, key, signedBytes(f, method, path, await sha256Hex(body)) as BufferSource)
  return formatAuthHeader(f, sig)
}

export const STREAM_AUTH_HEADER = 'vx-stream-auth'

/** Signed bytes answering a stream challenge (A7 §3): bound to the binding and the hub's one-time nonce. */
export function signedStreamBytes (f: AuthFields, binding: string): Uint8Array {
  const payload = JSON.stringify({
    v: 1, kind: 'stream', principal: f.principal, key_id: f.key_id, hub: f.hub,
    nonce: f.nonce, ts: f.ts, binding,
  })
  return enc.encode(AUTH_DOMAIN + payload)
}

/** The client's answer frame to `{type:"challenge", nonce, hub}`. */
export async function answerChallenge (
  key: CryptoKey, alg: KeyAlg, ids: { principal: string; key_id: string; hub: string },
  binding: string, nonce: string, now = Date.now(),
): Promise<{ type: 'auth'; ts: number; sig: string }> {
  const f: AuthFields = { ...ids, nonce, ts: now }
  const sig = await crypto.subtle.sign(ALGS[alg].signParams, key, signedStreamBytes(f, binding) as BufferSource)
  return { type: 'auth', ts: now, sig: b64url(sig) }
}
