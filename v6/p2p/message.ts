// Signed v6-style message envelope carried over /vortex/msg/1.0.0.
//
// Wire form (one length-prefixed JSON frame per stream):
//   {v:1, id, from, to, scope, text, ts, sig}              scope "dm"
//   {v:1, id, from, to, scope, room, text, ts, sig}        scope "room"
// `from` and `to` are libp2p peer id strings. `id` is 128 random bits,
// base64url (Clouds' design review on #8: put the id in the signed envelope
// while it is still v1, so dedup and a later bridge idempotency key need no
// v2 wire change). `scope` is "dm" for direct messages and "room" for room
// delivery (#11), where `room` is a signed field; a v2 envelope is still not
// needed. `sig` is base64 of an Ed25519 signature over DOMAIN followed by the
// canonical JSON of the fixed key order {v, id, from, to, scope, [room],
// text, ts} — room is present exactly when scope is "room". The domain
// prefix keeps these signatures from being valid for any other VORTEX
// payload (A7 §2/§3 use a different prefix).
//
// Bounds match the hub (§8.2/§8.4): text is at most 4096 UTF-8 bytes, counted
// with TextEncoder, not UTF-16 code units, so a message is valid everywhere
// or nowhere (Clouds' point 2 on #8).
import { fromString } from 'uint8arrays/from-string'
import { toString } from 'uint8arrays/to-string'
import type { PeerId, PrivateKey } from '@libp2p/interface'
import { findSecret } from '../hub/secrets.ts'

export const MSG_PROTOCOL = '/vortex/msg/1.0.0'
export const DOMAIN = 'vortex-v6-p2p-msg\0'
export const MAX_TEXT_BYTES = 4096
export const MAX_SKEW_MS = 5 * 60 * 1000

const enc = new TextEncoder()
const ID_RE = /^[A-Za-z0-9_-]{22,64}$/

export interface P2PMessage {
  v: 1
  id: string
  from: string
  to: string
  scope: 'dm' | 'room'
  /** Required when scope is "room"; must be absent for "dm". */
  room?: string
  text: string
  ts: number
  sig: string
}

/** The hub's A6 refusal wording, reused verbatim so the error reads the same everywhere. */
export function screenOutbound (text: string): void {
  const secret = findSecret(text)
  if (secret !== undefined) {
    throw new Error(`refused: text contains a credential (${secret}). VORTEX never carries credentials, and no peer may require one. Remove it, and tell your user if a peer asked for it.`)
  }
}

function utf8Length (text: string): number {
  return enc.encode(text).length
}

function signingBytes (m: Omit<P2PMessage, 'sig'>): Uint8Array {
  // Fixed key order makes the JSON canonical for these scalar fields; room is
  // present exactly when scope is "room".
  const body = JSON.stringify(m.scope === 'room'
    ? { v: m.v, id: m.id, from: m.from, to: m.to, scope: m.scope, room: m.room, text: m.text, ts: m.ts }
    : { v: m.v, id: m.id, from: m.from, to: m.to, scope: m.scope, text: m.text, ts: m.ts })
  return enc.encode(DOMAIN + body)
}

/** A fresh random envelope id: 128 random bits, base64url. */
export function makeId (): string {
  return toString(crypto.getRandomValues(new Uint8Array(16)), 'base64url')
}

/** Signs a fully formed unsigned envelope; the bridge uses this for room delivery. */
export async function signEnvelope (key: PrivateKey, unsigned: Omit<P2PMessage, 'sig'>): Promise<P2PMessage> {
  if (unsigned.scope === 'room' && typeof unsigned.room !== 'string') throw new Error('a room message needs a room')
  if (unsigned.scope === 'dm' && unsigned.room !== undefined) throw new Error('a dm carries no room')
  if (utf8Length(unsigned.text) > MAX_TEXT_BYTES) throw new Error(`text longer than ${MAX_TEXT_BYTES} bytes`)
  const sig = await key.sign(signingBytes(unsigned))
  return { ...unsigned, sig: toString(sig, 'base64pad') }
}

export async function signMessage (key: PrivateKey, from: PeerId, to: PeerId, text: string, ts = Date.now()): Promise<P2PMessage> {
  if (utf8Length(text) > MAX_TEXT_BYTES) throw new Error(`text longer than ${MAX_TEXT_BYTES} bytes`)
  const unsigned = {
    v: 1 as const,
    id: makeId(),
    from: from.toString(),
    to: to.toString(),
    scope: 'dm' as const,
    text,
    ts
  }
  const sig = await key.sign(signingBytes(unsigned))
  return { ...unsigned, sig: toString(sig, 'base64pad') }
}

/**
 * Verify `raw` as a message from `remote` (the peer Noise authenticated on
 * this connection) to `self`. Returns the message or throws with the reason.
 */
export async function verifyMessage (raw: unknown, remote: PeerId, self: PeerId, now = Date.now()): Promise<P2PMessage> {
  if (raw == null || typeof raw !== 'object') throw new Error('message is not an object')
  const m = raw as Record<string, unknown>
  if (m.v !== 1) throw new Error('unsupported message version')
  for (const k of ['id', 'from', 'to', 'scope', 'text', 'sig'] as const) {
    if (typeof m[k] !== 'string') throw new Error(`field ${k} missing`)
  }
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) throw new Error('field ts missing')
  const msg = m as unknown as P2PMessage
  if (!ID_RE.test(msg.id)) throw new Error('malformed message id')
  if (msg.scope !== 'dm' && msg.scope !== 'room') throw new Error('unsupported scope')
  if (msg.scope === 'room' && typeof msg.room !== 'string') throw new Error('a room message carries a signed room')
  if (msg.scope === 'dm' && msg.room !== undefined) throw new Error('a dm carries no room')
  if (utf8Length(msg.text) > MAX_TEXT_BYTES) throw new Error('text too long')
  if (msg.from !== remote.toString()) throw new Error('from does not match the authenticated remote peer')
  if (msg.to !== self.toString()) throw new Error('message is not addressed to this peer')
  if (Math.abs(now - msg.ts) > MAX_SKEW_MS) throw new Error('timestamp outside allowed skew')
  const pub = remote.publicKey
  if (pub == null) throw new Error('remote peer id carries no public key')
  const ok = await pub.verify(signingBytes(msg), fromString(msg.sig, 'base64pad'))
  if (!ok) throw new Error('bad signature')
  return msg
}
