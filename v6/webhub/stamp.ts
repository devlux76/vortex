// A9 §12 proof-of-work stamp (v7 1.02, #67), to Clouds' ruling on #67:
//
// - The stampless id is the base64url (no padding) SHA-256 of the signing bytes
//   of the record without `stamp` and `sig`: the domain `vortex-webhub-v1\0`
//   followed by the canonical JSON in the kind's key order with `stamp` omitted.
// - `stamp` is a string of 1 to 22 base64url characters, no padding. At
//   difficulty 0 the empty string is also valid, and any stamp is accepted.
// - A stamp is valid when SHA-256(UTF-8(stamplessId) || UTF-8(stamp)), with no
//   separator, has at least `bits` leading zero bits, counted from the most
//   significant bit of the first digest byte.
// - Order of operations: build the record without `stamp` and `sig`, compute the
//   stampless id, find a stamp, insert `stamp` at its place in the key order,
//   then sign. The signature covers `stamp`; a signed field changed after
//   stamping changes the stampless id and voids the stamp.
import { createHash } from 'node:crypto'
import { b64url } from '../client/b64.ts'

const DOMAIN = 'vortex-webhub-v1\0'
const enc = new TextEncoder()
/** The longest stamp, in characters (§12, Clouds' ruling on #67). */
export const STAMP_MAX_CHARS = 22
const STAMP_RE = /^[A-Za-z0-9_-]{1,22}$/

export type RecordBody = Readonly<Record<string, unknown>>

/**
 * The stampless id of a record: base64url SHA-256 of DOMAIN plus the canonical
 * JSON of the record's fields in `keyOrder`, with `stamp` and `sig` omitted.
 * A field the key order does not name is refused, so a key cannot be left out
 * of the id by accident.
 */
export function stamplessId (record: RecordBody, keyOrder: readonly string[]): string {
  for (const k of Object.keys(record)) {
    if (k === 'stamp' || k === 'sig') continue
    if (!keyOrder.includes(k)) throw new Error(`field ${k} is not in the key order`)
  }
  const body: Record<string, unknown> = {}
  for (const k of keyOrder) {
    if (k === 'stamp' || k === 'sig') continue
    if (record[k] !== undefined) body[k] = record[k]
  }
  return b64url.encode(new Uint8Array(createHash('sha256').update(enc.encode(DOMAIN + JSON.stringify(body))).digest()))
}

/** SHA-256 of the stampless id's text followed by the stamp's text. */
function stampDigest (id: string, stamp: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(enc.encode(id)).update(enc.encode(stamp)).digest())
}

/** Leading zero bits of a digest, from its most significant bit. */
export function leadingZeroBits (digest: Uint8Array): number {
  let n = 0
  for (const byte of digest) {
    if (byte === 0) { n += 8; continue }
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) return n
      n++
    }
    return n
  }
  return n
}

/** Finds a stamp for `record` at `bits` difficulty (0 gives the empty stamp). */
export function makeStamp (record: RecordBody, bits: number, keyOrder: readonly string[]): string {
  if (!Number.isInteger(bits) || bits < 0 || bits > 256) throw new Error(`difficulty ${bits} is not an integer in 0..256`)
  if (bits === 0) return ''
  const id = stamplessId(record, keyOrder)
  // Candidates are 8-byte big-endian counters in base64url: 11 characters each.
  for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter++) {
    const buf = new Uint8Array(8)
    new DataView(buf.buffer).setBigUint64(0, BigInt(counter), false)
    const stamp = b64url.encode(buf)
    if (leadingZeroBits(stampDigest(id, stamp)) >= bits) return stamp
  }
  throw new Error('no stamp found')
}

/**
 * Whether `record.stamp` meets `bits`. A missing or malformed stamp fails;
 * at difficulty 0 the empty string and any well-formed stamp pass.
 */
export function verifyStamp (record: RecordBody, bits: number, keyOrder: readonly string[]): boolean {
  if (!Number.isInteger(bits) || bits < 0 || bits > 256) return false
  const stamp = record.stamp
  if (typeof stamp !== 'string') return false
  if (bits === 0) return stamp === '' || STAMP_RE.test(stamp)
  if (!STAMP_RE.test(stamp)) return false
  return leadingZeroBits(stampDigest(stamplessId(record, keyOrder), stamp)) >= bits
}

/** The record with `stamp` inserted at its place in `keyOrder`, ready to sign. */
export function stampRecord (record: RecordBody, bits: number, keyOrder: readonly string[]): Record<string, unknown> {
  const stamp = makeStamp(record, bits, keyOrder)
  const out: Record<string, unknown> = {}
  for (const k of keyOrder) {
    if (k === 'stamp') out.stamp = stamp
    else if (record[k] !== undefined) out[k] = record[k]
  }
  if (!keyOrder.includes('stamp')) out.stamp = stamp
  return out
}
