// A9 §5.1, §5.2, §15: the webhub record core.
//
// A record is a signed JSON object of a known kind. Its signing bytes are the
// UTF-8 string DOMAIN followed by the canonical JSON of the record without
// `sig`, in the fixed key order of its kind. Its id is the base64url SHA-256
// of those signing bytes, the deduplication key everywhere. Canonical form is
// enforced on input too (`decode`), so one record has exactly one encoding and
// one id: a reordered or re-spaced copy is refused, not re-serialized.
//
// Encodings: `from` is the A7 key id (lowercase hex SHA-256 of the SPKI,
// `keyIdOf`); `key` and `sig` are standard padded base64 (A9 §5.1 says
// "base64"); the record id is base64url without padding.
//
// The canonical text is built here, key by key, and never by JSON.stringify over
// a caller's object: JavaScript enumerates integer-like keys first, so an object
// alone cannot carry the UTF-16 order the spec states.

import { keyIdOf } from '../client/edge-sign.ts'
import { b64pad, b64url } from '../client/b64.ts'

export const DOMAIN = 'vortex-webhub-v1\0'
export const VERSION = 1

/** Common fields, in signing order; the kind's own fields follow, then `sig`. */
export const COMMON = ['v', 'kind', 'from', 'key', 'ts', 'exp'] as const

/** A9 §5.2: kind fields in signing order (frozen at v1, §15 item 5). */
export const KINDS = {
  members: ['room', 'nonce', 'epoch', 'async', 'members', 'stamp'],
  msg: ['room', 'epoch', 'seq', 'body'],
  head: ['room', 'epoch', 'seq', 'body'],
  topic: ['room', 'content_type', 'text', 'stamp'],
  redirect: ['topic', 'to'],
  match: ['topic', 'embedder', 'matches'],
  hub: ['url', 'embedder', 'limits', 'load_pct', 'stamp'],
  refuse: ['room'],
  seed: ['content_id', 'size', 'sealed', 'servers', 'stamp'],
} as const satisfies Record<string, readonly string[]>

export type Kind = keyof typeof KINDS

/** A9 §5.2 maximum life per kind, in seconds. `null`: bounded by another record (the topic). */
export const MAX_LIFE: Record<Kind, number | null> = {
  members: 7 * 86400,
  msg: 86400,
  head: 86400,
  topic: 72 * 3600,
  redirect: null,
  match: null,
  hub: 86400,
  refuse: 7 * 86400,
  seed: 7 * 86400,
}

/** Fixed key order for the nested objects §5.2 names. Others are sorted (see `canonText`). */
const NESTED: Record<string, readonly string[]> = {
  members: ['id', 'enc', 'wrap'],
  matches: ['id', 'score'],
  servers: ['url'],
}

export type Record_ = { v: number, kind: Kind, from: string, key: string, ts: number, exp: number, sig?: string, [field: string]: unknown }

export class RecordError extends Error {}

const enc = new TextEncoder()
const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.hasOwn(KINDS, k)

/**
 * Canonical JSON text of a value. Arrays keep their order; an object inside a
 * named list (`members`, `matches`, `servers`) takes that list's fixed order; any
 * other object (e.g. `hub.limits`) has its keys sorted by UTF-16 code unit. Keys
 * are written from those lists, never from the object's own enumeration order.
 * Only JSON values are accepted: undefined, functions, symbols, bigints and
 * non-finite numbers are refused rather than silently dropped or coerced.
 */
function canonText (value: unknown, listName?: string): string {
  if (value === undefined) throw new RecordError('non-JSON value: undefined')
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RecordError(`non-JSON value: ${typeof value}`)
  }
  if (Array.isArray(value)) return '[' + value.map(item => canonText(item, listName)).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const fixed = listName !== undefined ? NESTED[listName] : undefined
    if (fixed !== undefined) {
      const extra = Object.keys(obj).filter(k => !fixed.includes(k))
      if (extra.length > 0) throw new RecordError(`unknown field in ${listName}: ${extra.join(', ')}`)
    }
    const keys = fixed ?? Object.keys(obj).sort()
    const parts = keys.map(k => {
      if (!Object.hasOwn(obj, k)) throw new RecordError(`missing field in ${listName ?? 'object'}: ${k}`)
      return JSON.stringify(k) + ':' + canonText(obj[k])
    })
    return '{' + parts.join(',') + '}'
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RecordError('non-finite number')
  return JSON.stringify(value)
}

/**
 * Canonical JSON text of the record's fields in signing order (no `sig`), after
 * form checks. Keys in `omit` are left out on purpose (the stampless path).
 */
function bodyText (rec: Record<string, unknown>, omit: ReadonlySet<string> = new Set()): string {
  if (rec.v !== VERSION) throw new RecordError(`unknown v: ${String(rec.v)}`)
  if (!isKind(rec.kind)) throw new RecordError(`unknown kind: ${String(rec.kind)}`)
  const order = [...COMMON, ...KINDS[rec.kind]].filter(k => !omit.has(k))
  const allowed = new Set<string>([...order, ...omit, 'sig'])
  const extra = Object.keys(rec).filter(k => !allowed.has(k))
  if (extra.length > 0) throw new RecordError(`unknown field: ${extra.join(', ')}`)
  for (const k of order) {
    if (!Object.hasOwn(rec, k)) throw new RecordError(`missing field: ${k}`)
    if (rec[k] === undefined) throw new RecordError(`missing field: ${k} is undefined`)
  }
  for (const k of ['ts', 'exp'] as const) {
    if (!Number.isSafeInteger(rec[k])) throw new RecordError(`${k} must be an integer`)
  }
  if (typeof rec.from !== 'string' || typeof rec.key !== 'string') throw new RecordError('from and key must be strings')
  const parts = order.map(k => JSON.stringify(k) + ':' + canonText(rec[k], Object.hasOwn(NESTED, k) ? k : undefined))
  return '{' + parts.join(',') + '}'
}

/** Canonical JSON of the record without `sig`. */
export function canonical (rec: Record<string, unknown>): string {
  return bodyText(rec)
}

/** DOMAIN + canonical JSON, as UTF-8. */
export function signingBytes (rec: Record<string, unknown>): Uint8Array {
  return enc.encode(DOMAIN + canonical(rec))
}

async function sha256 (bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** A9 §5.1: base64url SHA-256 of the signing bytes. */
export async function recordId (rec: Record<string, unknown>): Promise<string> {
  return b64url.encode(await sha256(signingBytes(rec)))
}

const NO_STAMP: ReadonlySet<string> = new Set(['stamp'])

/**
 * A9 §12 (Clouds' ruling on #67): the signing bytes of a record with `stamp`
 * (and `sig`) omitted, from the same canonical encoder as the signature, so a
 * stamp computed by any implementation agrees with this one. Only for kinds
 * that carry a stamp; the key order comes from the kind, never the caller.
 */
export function stamplessSigningBytes (rec: Record<string, unknown>): Uint8Array {
  if (!isKind(rec.kind) || !(KINDS[rec.kind] as readonly string[]).includes('stamp')) {
    throw new RecordError(`kind ${String(rec.kind)} carries no stamp`)
  }
  return enc.encode(DOMAIN + bodyText(rec, NO_STAMP))
}

/** The stampless id: base64url SHA-256 of `stamplessSigningBytes`. */
export async function stamplessId (rec: Record<string, unknown>): Promise<string> {
  return b64url.encode(await sha256(stamplessSigningBytes(rec)))
}

/** The full wire form: canonical fields, then `sig`. */
export function encode (rec: Record<string, unknown>): string {
  if (typeof rec.sig !== 'string') throw new RecordError('missing sig')
  const body = bodyText(rec)
  return body.slice(0, -1) + ',"sig":' + JSON.stringify(rec.sig) + '}'
}

/** Parse wire text, refusing anything but the one canonical encoding. */
export function decode (text: string): Record_ {
  let rec: unknown
  try { rec = JSON.parse(text) } catch { throw new RecordError('not JSON') }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw new RecordError('not an object')
  if (encode(rec as Record<string, unknown>) !== text) throw new RecordError('not in canonical form')
  return rec as Record_
}

/** Standard padded base64, accepted only in its one canonical spelling. */
function strictB64 (s: string, what: string): Uint8Array {
  let bytes: Uint8Array
  try { bytes = b64pad.decode(s) } catch { throw new RecordError(`${what} is not base64`) }
  if (b64pad.encode(bytes) !== s) throw new RecordError(`${what} is not canonical base64`)
  return bytes
}

/** An Ed25519 key pair whose public half is exportable as SPKI. */
export interface Signer { privateKey: CryptoKey, publicKey: CryptoKey }

/**
 * Sign a record's fields. `from` and `key` are filled from the signer, so the
 * caller passes the kind fields plus `v`, `kind`, `ts` and `exp`.
 */
export async function sign (fields: Record<string, unknown>, signer: Signer): Promise<Record_> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', signer.publicKey))
  const rec: Record<string, unknown> = { ...fields, from: await keyIdOf(spki), key: b64pad.encode(spki) }
  delete rec.sig
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer.privateKey, signingBytes(rec) as BufferSource))
  return JSON.parse(encode({ ...rec, sig: b64pad.encode(sig) })) as Record_
}

export type Verdict = { ok: true, id: string } | { ok: false, reason: string }

/**
 * Verify form, that `key` hashes to `from`, and the signature. Does not apply
 * ingest policy (clock skew, life bounds, membership, stamps): those are §8.1.
 */
export async function verify (rec: Record<string, unknown>): Promise<Verdict> {
  try {
    const bytes = signingBytes(rec)
    if (typeof rec.sig !== 'string') return { ok: false, reason: 'missing sig' }
    const spki = strictB64(rec.key as string, 'key')
    if (await keyIdOf(spki) !== rec.from) return { ok: false, reason: 'key does not hash to from' }
    const sig = strictB64(rec.sig, 'sig')
    let pub: CryptoKey
    try {
      pub = await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    } catch { return { ok: false, reason: 'key is not an Ed25519 SPKI' } }
    const good = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig as BufferSource, bytes as BufferSource)
    if (!good) return { ok: false, reason: 'bad signature' }
    return { ok: true, id: b64url.encode(await sha256(bytes)) }
  } catch (err) {
    if (err instanceof RecordError) return { ok: false, reason: err.message }
    throw err
  }
}

/** Ed25519 PKCS#8 prefix for a raw 32-byte seed (RFC 8410), for fixed test keys. */
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])

/** A deterministic signer from a 32-byte seed: test vectors only, never a live key. */
export async function signerFromSeed (seed: Uint8Array): Promise<Signer> {
  if (seed.length !== 32) throw new RecordError('seed must be 32 bytes')
  const pkcs8 = new Uint8Array(48)
  pkcs8.set(PKCS8_ED25519); pkcs8.set(seed, 16)
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'Ed25519' }, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, true, ['verify'])
  return { privateKey, publicKey }
}
