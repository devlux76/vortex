// A8 econ messages (docs/v6-amendment-a8-iou.md §6): canonical encoding, sign
// and verify for every kind.
//
// Canonical bytes follow the A7/#8 pattern (v6/p2p/message.ts): fixed key
// order per kind, compact JSON, not sorted keys. Common fields `v, kind, id,
// from, ts` lead; the per-kind fields follow in the order A8 §6.2 lists them.
// Optional fields (marked ? in A8 §6.2) are omitted when absent. The signature is
// Ed25519 over DOMAIN + canonical(body without sig), base64url, made with the
// sender's VORTEX identity key (A7 key / libp2p peer id, A8 §6.1).
//
// Integers only: token amounts, percentages and times are non-negative safe
// integers; times are Unix seconds. Unknown fields are refused, so nothing
// unsigned rides along. Every string field passes the A6 screen
// (v6/hub/secrets.ts) and the whole message fits the 4096-byte text bound.
//
// Not here: carrier skew (the carrier's rule applies), (from,id) dedupe and
// balances (v6/econ/ledger.ts), binding beacon `agent` to the carrier principal
// (the carrier knows it; here `agent` must equal the signed `from`).
import { publicKeyFromRaw } from '@libp2p/crypto/keys'
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id'
import type { PeerId, PublicKey } from '@libp2p/interface'
import { fromString } from 'uint8arrays/from-string'
import { toString } from 'uint8arrays/to-string'
import { findSecret } from '../hub/secrets.ts'

export const DOMAIN = 'vortex-iou-v1\0'
export const MAX_MESSAGE_BYTES = 4096
export const COST_HINTS = ['free', 'cheap', 'frontier'] as const

const enc = new TextEncoder()
const ID_RE = /^[A-Za-z0-9_-]{22,64}$/
const SIG_RE = /^[A-Za-z0-9_-]{86}$/ // 64 bytes, base64url, unpadded

// `str` must be non-empty; `text` may be empty; `int` is a non-negative safe integer.
type FieldType = 'str' | 'text' | 'int' | 'bool'
type FieldSpec = readonly [name: string, type: FieldType, optional?: true]

const COMMON: readonly FieldSpec[] = [['v', 'int'], ['kind', 'str'], ['id', 'str'], ['from', 'str'], ['ts', 'int'], ['key', 'str', true]]

/** A hub principal name (A7 §3): lowercase, short. A peer id never matches (52 chars, mixed case). */
const HUB_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
/** The A7 `key_id`: sha256(spki). A7 stores hex; A8 §6.1 says base64url — both shapes are accepted until #33 settles it. */
const KEY_ID_RE = /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/

/** Per-kind fields in canonical order (A8 §4, §6.2). */
export const KIND_FIELDS = {
  beacon: [['agent', 'str'], ['pool', 'str'], ['used_pct', 'int'], ['resets_at', 'int'], ['floor_pct', 'int', true],
    ['callin_pct', 'int', true], ['lending', 'bool'], ['cost_hint', 'str', true]],
  quote: [['to', 'str'], ['task', 'str'], ['est_tokens', 'int'], ['offer_face_tokens', 'int'], ['expires_at', 'int']],
  accept: [['quote', 'str'], ['reason', 'text']],
  decline: [['ref', 'str'], ['reason', 'text'], ['remaining', 'int', true]],
  receipt: [['quote', 'str'], ['spent_tokens', 'int']],
  iou: [['holder', 'str'], ['face_tokens', 'int'], ['quote', 'text'], ['issued_at', 'int'], ['expires_at', 'int']],
  redeem: [['issuer', 'str'], ['iou', 'str'], ['task', 'str'], ['est_tokens', 'int']],
  redeemed: [['issuer', 'str'], ['iou', 'str'], ['redeem', 'str'], ['credited_tokens', 'int']],
  release: [['issuer', 'str'], ['iou', 'str']],
} as const satisfies Record<string, readonly FieldSpec[]>

export type EconKind = keyof typeof KIND_FIELDS
export const ECON_KINDS = Object.keys(KIND_FIELDS) as EconKind[]

interface Common { v: 1; id: string; from: string; ts: number; key?: string; sig: string }
export interface Beacon extends Common {
  kind: 'beacon'; agent: string; pool: string; used_pct: number; resets_at: number
  floor_pct?: number; callin_pct?: number; lending: boolean; cost_hint?: typeof COST_HINTS[number]
}
export interface Quote extends Common { kind: 'quote'; to: string; task: string; est_tokens: number; offer_face_tokens: number; expires_at: number }
export interface Accept extends Common { kind: 'accept'; quote: string; reason: string }
/** `ref` is the quote or redeem id declined; `remaining` is the IOU balance when declining a redeem. */
export interface Decline extends Common { kind: 'decline'; ref: string; reason: string; remaining?: number }
export interface Receipt extends Common { kind: 'receipt'; quote: string; spent_tokens: number }
export interface Iou extends Common { kind: 'iou'; holder: string; face_tokens: number; quote: string; issued_at: number; expires_at: number }
export interface Redeem extends Common { kind: 'redeem'; issuer: string; iou: string; task: string; est_tokens: number }
export interface Redeemed extends Common { kind: 'redeemed'; issuer: string; iou: string; redeem: string; credited_tokens: number }
export interface Release extends Common { kind: 'release'; issuer: string; iou: string }
export type EconMessage = Beacon | Quote | Accept | Decline | Receipt | Iou | Redeem | Redeemed | Release

/** What a caller passes to sign: the body without v and sig; id and ts are filled in when absent. */
export type EconInput<M extends EconMessage = EconMessage> =
  M extends EconMessage ? Omit<M, 'v' | 'sig' | 'id' | 'ts'> & { id?: string; ts?: number } : never
export type Unsigned<M extends EconMessage = EconMessage> = M extends EconMessage ? Omit<M, 'sig'> : never

/** Anything that signs bytes with Ed25519: a libp2p PrivateKey, or a signer client (A7 §2). */
export interface EconSigner { sign (data: Uint8Array): Uint8Array | Promise<Uint8Array> }
/**
 * A verify key: a libp2p PublicKey or PeerId, a raw 32-byte Ed25519 public key
 * (A7 edge keys), or a WebCrypto ECDSA/P-256 public key (ES256, for principals
 * whose A7 key is P-256 — hardware tiers; A8 §6.1).
 */
export type VerifyKey = PublicKey | PeerId | Uint8Array | CryptoKey

export class EconError extends Error {}

/** 128 random bits, base64url. */
export function newId (): string {
  return toString(crypto.getRandomValues(new Uint8Array(16)), 'base64url')
}

function fieldsOf (kind: EconKind): readonly FieldSpec[] {
  return [...COMMON, ...KIND_FIELDS[kind]]
}

function checkField (name: string, type: FieldType, value: unknown): void {
  switch (type) {
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new EconError(`field ${name} must be a non-negative integer`)
      }
      return
    case 'bool':
      if (typeof value !== 'boolean') throw new EconError(`field ${name} must be a boolean`)
      return
    case 'str':
    case 'text':
      if (typeof value !== 'string') throw new EconError(`field ${name} must be a string`)
      if (type === 'str' && value.length === 0) throw new EconError(`field ${name} must not be empty`)
      const secret = findSecret(value)
      if (secret !== undefined) {
        throw new EconError(`refused: field ${name} contains a credential (${secret}). VORTEX never carries credentials, and no peer may require one (A6, A8 §9).`)
      }
  }
}

function checkKind (kind: unknown): EconKind {
  if (typeof kind !== 'string' || !Object.hasOwn(KIND_FIELDS, kind)) throw new EconError('unknown message kind')
  return kind as EconKind
}

function checkBeacon (m: Record<string, unknown>): void {
  if (m.agent !== m.from) throw new EconError('beacon agent must equal from')
  const used = m.used_pct as number
  if (used > 100) throw new EconError('used_pct must be in 0..100')
  const floor = m.floor_pct as number | undefined
  const callin = m.callin_pct as number | undefined
  if (floor !== undefined && floor > 100) throw new EconError('floor_pct must be in 0..100')
  if (callin !== undefined && callin > 100) throw new EconError('callin_pct must be in 0..100')
  if (floor !== undefined && callin !== undefined && floor > callin) throw new EconError('floor_pct must not exceed callin_pct')
  if (m.cost_hint !== undefined && !(COST_HINTS as readonly string[]).includes(m.cost_hint as string)) {
    throw new EconError(`cost_hint must be one of ${COST_HINTS.join('|')}`)
  }
}

/**
 * Validate an unsigned body (field set, types, ranges, A6 screen) and return
 * it rebuilt in canonical key order.
 */
export function validateBody (raw: unknown): Unsigned {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new EconError('message is not an object')
  const m = raw as Record<string, unknown>
  const kind = checkKind(m.kind)
  if (m.v !== 1) throw new EconError('unsupported message version')
  const specs = fieldsOf(kind)
  const known = new Set(specs.map(s => s[0]))
  for (const k of Object.keys(m)) {
    if (k !== 'sig' && !known.has(k)) throw new EconError(`unknown field ${k}`)
  }
  const out: Record<string, unknown> = {}
  for (const [name, type, optional] of specs) {
    const value = m[name]
    if (value === undefined) {
      if (optional === true) continue
      throw new EconError(`field ${name} missing`)
    }
    checkField(name, type, value)
    out[name] = value
  }
  if (!ID_RE.test(out.id as string)) throw new EconError('malformed message id')
  // A8 §6.1: a hub-principal sender names its A7 key (the `key` field, after
  // `ts`) so verifiers resolve the exact key and revocation applies per key.
  // A p2p sender omits it (the peer id embeds the Ed25519 key).
  if (out.key !== undefined) {
    if (!KEY_ID_RE.test(out.key as string)) throw new EconError('field key must be an A7 key_id (64-char hex or 43-char base64url)')
  } else if (HUB_NAME_RE.test(out.from as string)) {
    throw new EconError('a hub principal sender carries its key id (A8 §6.1)')
  }
  if (kind === 'beacon') checkBeacon(out)
  return out as Unsigned
}

/** Compact JSON of `body` (without sig) in the fixed key order for its kind. */
export function canonical (body: Unsigned): string {
  const v = validateBody(body)
  // validateBody inserted keys in canonical order; JSON.stringify keeps insertion order.
  return JSON.stringify(v)
}

/** The bytes a signature covers: DOMAIN followed by canonical(body). */
export function signingBytes (body: Unsigned): Uint8Array {
  return enc.encode(DOMAIN + canonical(body))
}

/** Encode a signed message for the `text` of a VORTEX message (scope "econ"). */
export function encode (m: EconMessage): string {
  const { sig, ...body } = m
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) throw new EconError('malformed signature')
  const text = canonical(body as Unsigned).slice(0, -1) + `,"sig":${JSON.stringify(sig)}}`
  if (enc.encode(text).length > MAX_MESSAGE_BYTES) throw new EconError(`message longer than ${MAX_MESSAGE_BYTES} bytes`)
  return text
}

/** Build, validate and sign a message. `id` defaults to a fresh one and `ts` to now (Unix seconds). */
export async function sign<M extends EconMessage> (signer: EconSigner, input: EconInput<M>): Promise<M> {
  const body = validateBody({ v: 1, ...input, id: input.id ?? newId(), ts: input.ts ?? Math.floor(Date.now() / 1000) })
  const sig = toString(await signer.sign(signingBytes(body)), 'base64url')
  const m = { ...body, sig } as M
  encode(m) // size bound
  return m
}

function toPublicKey (key: Exclude<VerifyKey, CryptoKey> | undefined, from: string): PublicKey {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new EconError('raw Ed25519 public key must be 32 bytes')
    return publicKeyFromRaw(key)
  }
  if (key !== undefined && 'verify' in key) return key
  let pid: PeerId
  try {
    pid = key ?? peerIdFromString(from)
  } catch {
    throw new EconError('from is not a peer id; pass the sender key')
  }
  if (pid.publicKey === undefined) throw new EconError('peer id carries no public key')
  return pid.publicKey
}

const isWebCryptoKey = (k: unknown): k is CryptoKey =>
  typeof CryptoKey !== 'undefined' && k instanceof CryptoKey

/**
 * With an explicit key, `from` must be the authenticated sender. A trusted
 * `sender` (a peer id or hub principal the caller resolved from that key) must
 * equal `from`. Without one, a peer-id `from` must be the id derived from the
 * key. A WebCrypto key (ES256) has no derivable peer id, so `sender` is
 * required. Anything else is refused.
 */
function checkSender (from: string, key: VerifyKey | undefined, pub: PublicKey | CryptoKey, sender: string | undefined): void {
  if (key === undefined) return // from is a peer id; its embedded key verified the signature
  if (isWebCryptoKey(key)) {
    if (sender === undefined) throw new EconError('pass the expected sender for an ES256 key')
    if (sender !== from) throw new EconError('from does not match the expected sender')
    return
  }
  if (sender !== undefined) {
    if (sender !== from) throw new EconError('from does not match the expected sender')
    return
  }
  const derived = key instanceof Uint8Array || 'verify' in key
    ? peerIdFromPublicKey(pub as PublicKey).toString()
    : key.toString()
  if (derived !== from) throw new EconError('from does not match the key; pass the expected sender')
}

/**
 * Parse (JSON text or object), validate and verify a message. With no `key`,
 * `from` must be a libp2p peer id that embeds its Ed25519 key. With a `key`,
 * `from` must match `sender` (when given) or the peer id derived from the key;
 * a WebCrypto ECDSA/P-256 key verifies as ES256 and requires `sender`. The
 * canonical signed bytes are bounded for both text and object input.
 * Returns the message in canonical key order, or throws EconError with the reason.
 */
export async function verify (raw: unknown, key?: VerifyKey, sender?: string): Promise<EconMessage> {
  let obj = raw
  if (typeof raw === 'string') {
    if (enc.encode(raw).length > MAX_MESSAGE_BYTES) throw new EconError(`message longer than ${MAX_MESSAGE_BYTES} bytes`)
    try { obj = JSON.parse(raw) } catch { throw new EconError('message is not JSON') }
  }
  const body = validateBody(obj)
  const sig = (obj as Record<string, unknown>).sig
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) throw new EconError('malformed signature')
  encode({ ...body, sig } as EconMessage) // size bound on the canonical bytes, for object input too
  const bytes = signingBytes(body)
  if (key !== undefined && isWebCryptoKey(key)) {
    // ES256: the A7 key resolved to a P-256 WebCrypto key (hardware tiers).
    checkSender(body.from, key, key, sender)
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromString(sig, 'base64url') as BufferSource, bytes as BufferSource)
      .catch(() => false)
    if (!ok) throw new EconError('bad signature')
    return { ...body, sig } as EconMessage
  }
  const pub = toPublicKey(key as Exclude<VerifyKey, CryptoKey> | undefined, body.from)
  if (pub.type !== 'Ed25519') throw new EconError('econ messages are signed with Ed25519')
  checkSender(body.from, key, pub, sender)
  const ok = await pub.verify(signingBytes(body), fromString(sig, 'base64url'))
  if (!ok) throw new EconError('bad signature')
  return { ...body, sig } as EconMessage
}
