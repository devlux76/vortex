// Outbound credential screen (docs/v6-amendment-a6-secrets.md §1). The hub
// refuses a message whose text contains a credential-shaped string, so a peer
// that asks for a key as the price of help cannot receive one through VORTEX.
// Patterns are high-precision shapes of real credential formats, not a general
// secret detector: ordinary prose and code must pass. The matched text is never
// echoed, logged or stored; only the kind name is reported.

// `ok` vets each regex match; when it rejects one, later matches in the same
// text are still tried.
interface Shape { kind: string; re: RegExp; ok?: (m: RegExpExecArray) => boolean }

// A random token tail holds a digit and is not only lowercase words joined by
// `-` or `/` (`sk-learn-preprocessing-…`, `Bearer authentication/…`). Applied
// where the literal prefix is too short or too common to carry the match alone.
const randomTail = (t: string): boolean => /[0-9]/.test(t) && !/^[a-z]+(?:[-/][a-z]+)*$/.test(t)

// A marshalled libp2p PrivateKey protobuf: field 1 (key type, varint 0-3) then
// field 2 (key bytes, length-delimited). The key bytes must have the shape of a
// private key of that type, so a marshalled public key (same framing) passes.
function libp2pPrivateKey (b64: string): boolean {
  const b = Buffer.from(b64, 'base64')
  if (b.length < 36 || b[0] !== 0x08 || b[1] > 3 || b[2] !== 0x12) return false
  let len = 0
  let i = 3
  for (let shift = 0; ; shift += 7, i++) {
    if (i >= 6 || i >= b.length) return false
    len |= (b[i] & 0x7f) << shift
    if (!(b[i] & 0x80)) { i++; break }
  }
  const key = b.subarray(i)
  if (key.length < len) return false
  if (b[1] === 1) return len === 64 // Ed25519 seed + public half; a public key is 32
  if (b[1] === 2) return len === 32 // secp256k1 scalar; a public key is 33
  // RSA (PKCS#1, version 0) or ECDSA (SEC1, version 1): a DER SEQUENCE whose
  // first item is the version INTEGER. Public keys (PKIX) open with a SEQUENCE.
  if (key[0] !== 0x30) return false
  const h = key[1] < 0x80 ? 2 : 2 + (key[1] & 0x7f)
  return key[h] === 0x02 && key[h + 1] === 0x01 && key[h + 2] === (b[1] === 0 ? 0x00 : 0x01)
}

// Every pattern requires the issuer's literal prefix plus a long random tail,
// so placeholders such as `Bearer <token>` or `sk-...` do not match.
const SHAPES: readonly Shape[] = [
  { kind: 'vortex-token', re: /(?<![A-Za-z0-9])vt_[A-Za-z0-9_-]{40,}/g },
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'aws-access-key', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g },
  { kind: 'github-token', re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g },
  { kind: 'anthropic-key', re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{32,})/g, ok: m => randomTail(m[1]) },
  { kind: 'slack-token', re: /(?<![A-Za-z0-9])xox[abposr]-([A-Za-z0-9-]{10,})/g, ok: m => randomTail(m[1]) },
  { kind: 'google-api-key', re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe-key', re: /(?<![A-Za-z0-9])[rs]k_live_[A-Za-z0-9]{20,}/g },
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'libp2p-key', re: /(?<![A-Za-z0-9+/_-])CA[AEIM]S[A-Za-z0-9+/_-]{44,}={0,2}/g, ok: m => libp2pPrivateKey(m[0]) },
  // A JWK private key (an A7 unsealed edge key file, or any exported key): one
  // JSON object holding both "kty" and a long private "d" member, either order.
  { kind: 'jwk-private-key', re: /\{[^{}]*"kty"\s*:[^{}]*"d"\s*:\s*"[A-Za-z0-9_-]{40,}"[^{}]*\}|\{[^{}]*"d"\s*:\s*"[A-Za-z0-9_-]{40,}"[^{}]*"kty"\s*:[^{}]*\}/g },
  { kind: 'bearer-credential', re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,})=*/gi, ok: m => randomTail(m[1]) },
]

/** Kind names, in check order (for tests and documentation). */
export const SECRET_KINDS: readonly string[] = SHAPES.map(s => s.kind)

/** Returns the kind of the first credential-shaped string in `text`, or undefined. */
export function findSecret (text: string): string | undefined {
  for (const s of SHAPES) {
    for (const m of text.matchAll(s.re)) if (s.ok === undefined || s.ok(m)) return s.kind
  }
  return undefined
}

export interface RefusalRecord { principal: string; count: number; lastAt: number; lastKind: string }

/**
 * In-memory tally of refused sends per principal since hub start, shown in
 * `/v1/status` so the operator learns of an attempt even when the agent does
 * not report it (A6 §2). Holds no message text.
 */
export class SecretRefusals {
  private byPrincipal = new Map<string, RefusalRecord>()

  record (principal: string, kind: string, now = Date.now()): void {
    const prev = this.byPrincipal.get(principal)
    this.byPrincipal.set(principal, { principal, count: (prev?.count ?? 0) + 1, lastAt: now, lastKind: kind })
  }

  list (): RefusalRecord[] {
    return [...this.byPrincipal.values()].sort((a, b) => a.principal.localeCompare(b.principal))
  }
}
