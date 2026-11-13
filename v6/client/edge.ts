// Signed HTTP edge client (A7 §3) for peers that can only make plain HTTPS
// requests, such as a cloud agent behind an egress proxy with no WebSockets,
// UDP or raw TCP. Every request is signed; there is no bearer token. Receiving
// is polling the read endpoints (room log, own DMs), which never acknowledge
// delivery (A5).
//
// Custody: this client keeps its private key in a JWK file, which the agent's
// own user can read. That is the A7 `unsealed` tier, so the hub limits such a
// key to named rooms and a short lifetime. Sealed tiers use a signer instead.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { ALGS, AUTH_HEADER, keyIdOf, signRequest, type KeyAlg } from './edge-sign.ts'

export interface EdgeKeyFile {
  v: 1
  principal: string
  alg: KeyAlg
  key_id: string
  custody: 'unsealed'
  /** Hub id (TLS certificate fingerprint) printed by `vx enroll --key`. */
  hub_id?: string
  /** Base URL of the hub's TLS listener, e.g. https://hub.example.net */
  hub_url?: string
  jwk: JsonWebKey
}

export interface EdgeOptions {
  url: string
  principal: string
  keyId: string
  hubId: string
  alg: KeyAlg
  key: CryptoKey
  /** Accept a self-signed certificate; allowed only for loopback hosts (tests, local trials). */
  insecureLoopback?: boolean
}

/** Generates an unsealed edge key. Returns the private JWK (for the key file) and the public SPKI. */
export async function generateEdgeKey (alg: KeyAlg = 'ed25519'): Promise<{ jwk: JsonWebKey; spkiB64: string; keyId: string }> {
  const pair = await crypto.subtle.generateKey(ALGS[alg].generate, true, ['sign', 'verify']) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  return { jwk: await crypto.subtle.exportKey('jwk', pair.privateKey), spkiB64: Buffer.from(spki).toString('base64'), keyId: await keyIdOf(spki) }
}

export function writeKeyFile (path: string, file: EdgeKeyFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function readKeyFile (path: string): EdgeKeyFile {
  const f = JSON.parse(readFileSync(path, 'utf8')) as EdgeKeyFile
  if (f.v !== 1 || f.custody !== 'unsealed' || !(f.alg in ALGS)) throw new Error(`${path} is not a VORTEX edge key file`)
  return f
}

export class EdgeClient {
  readonly opts: EdgeOptions

  constructor (opts: EdgeOptions) {
    const host = new URL(opts.url).hostname.replace(/^\[|\]$/g, '')
    if (opts.insecureLoopback === true && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('insecureLoopback is only for loopback hosts')
    }
    this.opts = opts
  }

  /** Loads a key file; the private key is imported non-extractable. */
  static async fromKeyFile (path: string, over: Partial<Pick<EdgeOptions, 'url' | 'hubId' | 'insecureLoopback'>> = {}): Promise<EdgeClient> {
    const f = readKeyFile(path)
    const url = over.url ?? f.hub_url
    const hubId = over.hubId ?? f.hub_id
    if (url === undefined || hubId === undefined) throw new Error(`${path} lacks hub_url/hub_id; pass --hub and --hub-id`)
    const key = await crypto.subtle.importKey('jwk', f.jwk, ALGS[f.alg].importParams, false, ['sign'])
    return new EdgeClient({ url, principal: f.principal, keyId: f.key_id, hubId, alg: f.alg, key, insecureLoopback: over.insecureLoopback })
  }

  async request (method: string, path: string, body?: unknown): Promise<any> {
    const bytes = body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body))
    const o = this.opts
    const auth = await signRequest(o.key, o.alg, { principal: o.principal, key_id: o.keyId, hub: o.hubId }, method, path, bytes)
    const headers: Record<string, string> = { [AUTH_HEADER]: auth }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(new URL(path, o.url), {
      method,
      headers,
      body: body === undefined ? undefined : bytes,
      ...(o.insecureLoopback === true ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit)
    const text = await res.text()
    let parsed: any
    try { parsed = JSON.parse(text) } catch { parsed = { error: text } }
    if (!res.ok) throw Object.assign(new Error(`vortex hub ${res.status}: ${parsed?.error ?? text}`), { status: res.status })
    return parsed
  }

  send (msg: { text: string; room?: string; to?: string[]; reply_to?: string }): Promise<{ id: string; seq: number }> {
    return this.request('POST', '/v1/messages', { scope: 'room', ...msg })
  }

  async roomLog (room: string, after = 0, limit = 100): Promise<any[]> {
    return (await this.request('GET', `/v1/rooms/${encodeURIComponent(room)}/log?after=${after}&limit=${limit}`)).messages
  }

  async dms (after = 0, limit = 100): Promise<any[]> {
    return (await this.request('GET', `/v1/dms/mine?after=${after}&limit=${limit}`)).messages
  }
}
