// Signed v6-style message envelope carried over /vortex/msg/1.0.0.
//
// Wire form (one length-prefixed JSON frame per stream):
//   {v:1, from, to, text, ts, sig}
// `from` and `to` are libp2p peer id strings. `sig` is base64 of an Ed25519
// signature over DOMAIN followed by the canonical JSON of {v, from, to, text, ts}.
// The domain prefix keeps these signatures from being valid for any other
// VORTEX payload (A7 §2/§3 use a different prefix).
import { fromString } from 'uint8arrays/from-string'
import { toString } from 'uint8arrays/to-string'
import type { PeerId, PrivateKey } from '@libp2p/interface'

export const MSG_PROTOCOL = '/vortex/msg/1.0.0'
export const DOMAIN = 'vortex-v6-p2p-msg\0'
export const MAX_TEXT = 64 * 1024
export const MAX_SKEW_MS = 5 * 60 * 1000

export interface P2PMessage {
  v: 1
  from: string
  to: string
  text: string
  ts: number
  sig: string
}

function signingBytes (m: Omit<P2PMessage, 'sig'>): Uint8Array {
  // Fixed key order makes the JSON canonical for these five scalar fields.
  const body = JSON.stringify({ v: m.v, from: m.from, to: m.to, text: m.text, ts: m.ts })
  return new TextEncoder().encode(DOMAIN + body)
}

export async function signMessage (key: PrivateKey, from: PeerId, to: PeerId, text: string, ts = Date.now()): Promise<P2PMessage> {
  if (text.length > MAX_TEXT) throw new Error(`text longer than ${MAX_TEXT}`)
  const unsigned = { v: 1 as const, from: from.toString(), to: to.toString(), text, ts }
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
  for (const k of ['from', 'to', 'text', 'sig'] as const) {
    if (typeof m[k] !== 'string') throw new Error(`field ${k} missing`)
  }
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) throw new Error('field ts missing')
  const msg = m as unknown as P2PMessage
  if (msg.text.length > MAX_TEXT) throw new Error('text too long')
  if (msg.from !== remote.toString()) throw new Error('from does not match the authenticated remote peer')
  if (msg.to !== self.toString()) throw new Error('message is not addressed to this peer')
  if (Math.abs(now - msg.ts) > MAX_SKEW_MS) throw new Error('timestamp outside allowed skew')
  const pub = remote.publicKey
  if (pub == null) throw new Error('remote peer id carries no public key')
  const ok = await pub.verify(signingBytes(msg), fromString(msg.sig, 'base64pad'))
  if (!ok) throw new Error('bad signature')
  return msg
}
