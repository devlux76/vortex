// Verifies signed HTTP requests (A7 §3). Order of checks: header shape, clock
// skew, hub id, key (exists, owned by the principal, not revoked, not expired),
// signature, then nonce freshness. A nonce is recorded only after its
// signature verifies, so unsigned noise cannot fill or poison the store, and
// it is persisted, so a restart does not reopen the replay window.
import { ALGS, AUTH_HEADER, KEY_ID_RE, b64url, parseAuthHeader, sha256Hex, signedBytes, signedStreamBytes } from '../client/edge-sign.ts'
import { claimNonce, getKey, type KeyRow } from './store-keys.ts'
import type { HubStore } from './store.ts'

export const MAX_SKEW_MS = 60_000
export const NONCE_TTL_MS = 10 * 60_000
export const NONCE_CAP = 100_000

export class EdgeAuthError extends Error {
  readonly status: number
  constructor (status: number, message: string) { super(message); this.status = status }
}

export interface EdgeIdentity { principal: string; key: KeyRow }

export class EdgeAuth {
  private keyCache = new Map<string, CryptoKey>()

  private readonly store: HubStore
  private readonly hubId: () => string | undefined
  /** Test seam: the nonce-store cap. */
  nonceCap = NONCE_CAP

  constructor (store: HubStore, hubId: () => string | undefined) {
    this.store = store
    this.hubId = hubId
  }

  /** Verifies `req` against its exact body bytes; throws EdgeAuthError on any failure. */
  async verify (req: Request, body: Uint8Array, now = Date.now()): Promise<EdgeIdentity> {
    const hub = this.hubId()
    // The signature binds the hub id, which is the TLS listener's certificate
    // fingerprint; without tls.listen there is no remote path to authenticate.
    if (hub === undefined) throw new EdgeAuthError(401, 'signed requests need the hub TLS listener (tls.listen)')
    const parsed = parseAuthHeader(req.headers.get(AUTH_HEADER) ?? '', hub)
    if (parsed === undefined) throw new EdgeAuthError(401, 'malformed VX-Auth header')
    const { fields: f, sig } = parsed
    if (Math.abs(now - f.ts) > MAX_SKEW_MS) throw new EdgeAuthError(401, 'request timestamp outside the 60 s window')
    const key = getKey(this.store, f.key_id)
    if (key === undefined || key.principal !== f.principal) throw new EdgeAuthError(401, 'unknown key')
    if (key.revoked !== null) throw new EdgeAuthError(401, 'key revoked')
    if (key.expires !== null && now >= key.expires) throw new EdgeAuthError(401, 'key expired')
    const url = new URL(req.url)
    const bytes = signedBytes(f, req.method, url.pathname + url.search, await sha256Hex(body))
    const ok = await crypto.subtle.verify(ALGS[key.alg].signParams, await this.publicKey(key), sig as BufferSource, bytes as BufferSource)
      .catch(() => false)
    if (!ok) throw new EdgeAuthError(401, 'bad signature')
    // Persisted (SQLite), so a restart does not reopen the replay window.
    const claim = claimNonce(this.store, f.key_id, f.nonce, now + NONCE_TTL_MS, this.nonceCap, now)
    if (claim === 'used') throw new EdgeAuthError(401, 'nonce already used')
    if (claim === 'full') throw new EdgeAuthError(429, 'too many signed requests; retry shortly')
    return { principal: f.principal, key }
  }

  /** Checks a key for use right now: exists, owned by `principal`, not revoked or expired. */
  usableKey (principal: string, keyId: string, now = Date.now()): KeyRow {
    if (!KEY_ID_RE.test(keyId)) throw new EdgeAuthError(401, 'malformed key id')
    const key = getKey(this.store, keyId)
    if (key === undefined || key.principal !== principal) throw new EdgeAuthError(401, 'unknown key')
    if (key.revoked !== null) throw new EdgeAuthError(401, 'key revoked')
    if (key.expires !== null && now >= key.expires) throw new EdgeAuthError(401, 'key expired')
    return key
  }

  /** A fresh one-time challenge nonce for a stream (A7 §3); never reused, so no store is needed. */
  challengeNonce (): string {
    return b64url(crypto.getRandomValues(new Uint8Array(32)))
  }

  /** Verifies a stream challenge answer. The key is re-checked, so a revocation during the handshake counts. */
  async verifyStream (principal: string, keyId: string, binding: string, nonce: string, answer: unknown, now = Date.now()): Promise<KeyRow> {
    const hub = this.hubId()
    if (hub === undefined) throw new EdgeAuthError(401, 'signed streams need the hub TLS listener')
    const a = answer as { type?: unknown; ts?: unknown; sig?: unknown }
    if (a?.type !== 'auth' || typeof a.ts !== 'number' || !Number.isSafeInteger(a.ts) || typeof a.sig !== 'string' || !/^[A-Za-z0-9_-]{40,200}$/.test(a.sig)) {
      throw new EdgeAuthError(401, 'expected {type:"auth", ts, sig}')
    }
    if (Math.abs(now - a.ts) > MAX_SKEW_MS) throw new EdgeAuthError(401, 'answer timestamp outside the 60 s window')
    const key = this.usableKey(principal, keyId, now)
    const bytes = signedStreamBytes({ principal, key_id: keyId, hub, nonce, ts: a.ts }, binding)
    const ok = await crypto.subtle.verify(ALGS[key.alg].signParams, await this.publicKey(key), Buffer.from(a.sig, 'base64url') as BufferSource, bytes as BufferSource)
      .catch(() => false)
    if (!ok) throw new EdgeAuthError(401, 'bad signature')
    return key
  }

  private async publicKey (k: KeyRow): Promise<CryptoKey> {
    let pk = this.keyCache.get(k.key_id)
    if (pk === undefined) {
      pk = await crypto.subtle.importKey('spki', Buffer.from(k.spki, 'base64'), ALGS[k.alg].importParams, false, ['verify'])
      this.keyCache.set(k.key_id, pk)
    }
    return pk
  }
}
