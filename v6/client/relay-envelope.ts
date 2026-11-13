// Verified relay envelopes (mesh→hub, #20), with NO external dependencies:
// the hub's source chain must resolve without node_modules (the plugin
// standalone build check runs the hub sources alone), so this module uses
// only WebCrypto and node builtins. The p2p module re-exports it, and the
// hub's relay route verifies against it.
//
// What it does: verify a signed /vortex/msg envelope against the key
// EMBEDDED IN `from` alone (no transport check — the direct-delivery check
// `from == Noise peer` lives in v6/p2p/message.ts), and derive the A7 key
// material from the peer id: an Ed25519 peer id is a base58btc identity
// multihash `[0x00, 0x24, 08 01 12 20, <32 raw key bytes>]`, so
// sha256(spki(peer id)) is the A7 `key_id` enrolled in principal_keys.

export const ED25519_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const MAX_TEXT_BYTES = 4096
const MAX_SKEW_MS = 5 * 60 * 1000
const DOMAIN = 'vortex-v6-p2p-msg\0'
const ID_RE = /^[A-Za-z0-9_-]{22,64}$/

function b58decode (s: string): Uint8Array {
  const bytes: number[] = [0]
  for (const ch of s) {
    const carry0 = B58.indexOf(ch)
    if (carry0 < 0) throw new Error('not base58')
    let carry = carry0
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  for (const ch of s) { if (ch !== '1') break; bytes.push(0) }
  return new Uint8Array(bytes.reverse())
}

/** The SPKI DER of the Ed25519 key a peer id embeds; throws for other ids. */
export function spkiFromPeerId (peerId: string): Uint8Array {
  const mh = b58decode(peerId)
  if (mh.length !== 38 || mh[0] !== 0x00 || mh[1] !== 0x24 ||
    mh[2] !== 0x08 || mh[3] !== 0x01 || mh[4] !== 0x12 || mh[5] !== 0x20) {
    throw new Error('not an Ed25519 identity peer id')
  }
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32)
  spki.set(ED25519_SPKI_PREFIX)
  spki.set(mh.subarray(6), ED25519_SPKI_PREFIX.length)
  return spki
}

export interface RelayEnvelope {
  v: number
  id: string
  from: string
  to: string
  scope: string
  room?: string
  text: string
  ts: number
  sig: string
}

function signingBytes (m: RelayEnvelope): Uint8Array {
  // Fixed key order; room is present exactly when scope is "room". Must stay
  // byte-identical with v6/p2p/message.ts's signingBytes.
  const body = JSON.stringify(m.scope === 'room'
    ? { v: m.v, id: m.id, from: m.from, to: m.to, scope: m.scope, room: m.room, text: m.text, ts: m.ts }
    : { v: m.v, id: m.id, from: m.from, to: m.to, scope: m.scope, text: m.text, ts: m.ts })
  return new TextEncoder().encode(DOMAIN + body)
}

/**
 * Verify an envelope against the key in `from`. Returns the envelope. This
 * is the store-and-forward half of the verify split (Clouds' point 5 on #8);
 * direct delivery keeps `verifyMessage` (v6/p2p/message.ts), which adds
 * from == Noise peer and to == self on top of these same checks.
 */
export async function verifyRelayEnvelope (raw: unknown, now = Date.now()): Promise<RelayEnvelope> {
  if (raw == null || typeof raw !== 'object') throw new Error('message is not an object')
  const m = raw as Record<string, unknown>
  if (m.v !== 1) throw new Error('unsupported message version')
  for (const k of ['id', 'from', 'to', 'scope', 'text', 'sig'] as const) {
    if (typeof m[k] !== 'string') throw new Error(`field ${k} missing`)
  }
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) throw new Error('field ts missing')
  const msg = m as unknown as RelayEnvelope
  if (!ID_RE.test(msg.id)) throw new Error('malformed message id')
  if (msg.scope !== 'dm' && msg.scope !== 'room') throw new Error('unsupported scope')
  if (msg.scope === 'room' && typeof msg.room !== 'string') throw new Error('a room message carries a signed room')
  if (msg.scope === 'dm' && msg.room !== undefined) throw new Error('a dm carries no room')
  if (new TextEncoder().encode(msg.text).length > MAX_TEXT_BYTES) throw new Error('text too long')
  if (Math.abs(now - msg.ts) > MAX_SKEW_MS) throw new Error('timestamp outside allowed skew')
  const spki = spkiFromPeerId(msg.from)
  const pub = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify'])
  const sig = Buffer.from(msg.sig, 'base64')
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, signingBytes(msg) as BufferSource).catch(() => false)
  if (!ok) throw new Error('bad signature')
  return msg
}
