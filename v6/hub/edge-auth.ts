// Verifies signed HTTP requests (A7 §3). Order of checks: header shape, clock
// skew, hub id, key (exists, owned by the principal, not revoked, not expired),
// signature, then nonce freshness. A nonce is recorded only after its
// signature verifies, so unsigned noise cannot fill or poison the cache.
import { ALGS, AUTH_HEADER, parseAuthHeader, sha256Hex, signedBytes } from '../client/edge-sign.ts'
import { getKey, type KeyRow } from './store-keys.ts'
import type { HubStore } from './store.ts'

export const MAX_SKEW_MS = 60_000
export const NONCE_TTL_MS = 10 * 60_000
const NONCE_CAP = 100_000

export class EdgeAuthError extends Error {
  readonly status: number
  constructor (status: number, message: string) { super(message); this.status = status }
}

export interface EdgeIdentity { principal: string; key: KeyRow }

export class EdgeAuth {
  private nonces = new Map<string, number>()
  private keyCache = new Map<string, CryptoKey>()

  private readonly store: HubStore
  private readonly hubId: () => string | undefined

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
    this.prune(now)
    const seen = `${f.key_id}:${f.nonce}`
    if (this.nonces.has(seen)) throw new EdgeAuthError(401, 'nonce already used')
    if (this.nonces.size >= NONCE_CAP) throw new EdgeAuthError(429, 'too many signed requests; retry shortly')
    this.nonces.set(seen, now + NONCE_TTL_MS)
    return { principal: f.principal, key }
  }

  private async publicKey (k: KeyRow): Promise<CryptoKey> {
    let pk = this.keyCache.get(k.key_id)
    if (pk === undefined) {
      pk = await crypto.subtle.importKey('spki', Buffer.from(k.spki, 'base64'), ALGS[k.alg].importParams, false, ['verify'])
      this.keyCache.set(k.key_id, pk)
    }
    return pk
  }

  private prune (now: number): void {
    // Map iteration follows insertion order, which is expiry order.
    for (const [n, exp] of this.nonces) {
      if (exp > now) break
      this.nonces.delete(n)
    }
  }
}
