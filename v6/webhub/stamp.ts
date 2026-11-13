// A9 §12 proof-of-work stamp (v7 1.02, #67), to Clouds' ruling on #67:
//
// - The stampless id is `stamplessId` from the record core (record.ts): the
//   base64url SHA-256 of the signing bytes of the record without `stamp` and
//   `sig`, from the same canonical encoder as the signature, so every
//   implementation computes the same id (Winds' change on #67).
// - `stamp` is a string of 1 to 22 base64url characters, no padding. At
//   difficulty 0 the empty string is also valid.
// - A stamp is valid when SHA-256(UTF-8(stamplessId) || UTF-8(stamp)), with no
//   separator, has at least `bits` leading zero bits, counted from the most
//   significant bit of the first digest byte.
// - Order of operations: build the record without `stamp`, `makeStamp` it,
//   insert `stamp`, then sign (the record core's `sign`). The signature covers
//   `stamp`; a signed field changed after stamping changes the stampless id and
//   voids the stamp.
import { createHash } from 'node:crypto'
import { stamplessId } from './record.ts'

const enc = new TextEncoder()
/** The longest stamp, in characters (§12, Clouds' ruling on #67). */
export const STAMP_MAX_CHARS = 22
const STAMP_RE = /^[A-Za-z0-9_-]{1,22}$/

/** The record fields a stamp is computed over: everything but `stamp` and `sig`. */
export type StampRecord = Readonly<Record<string, unknown>>

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

function checkBits (bits: number): void {
  if (!Number.isInteger(bits) || bits < 0 || bits > 256) throw new Error(`difficulty ${bits} is not an integer in 0..256`)
}

/**
 * Finds a stamp for `rec` at `bits` difficulty. Refuses a record that already
 * carries `stamp`, so a stamp is never computed for a different id by accident.
 * At difficulty 0 the minimal valid stamp is the empty string.
 */
export async function makeStamp (rec: StampRecord, bits: number): Promise<string> {
  checkBits(bits)
  if (Object.hasOwn(rec, 'stamp')) throw new Error('the record already carries a stamp')
  if (bits === 0) return ''
  const id = await stamplessId(rec)
  // The id's text is hashed once; each candidate copies that state and adds its stamp.
  const prefix = new Bun.CryptoHasher('sha256').update(enc.encode(id))
  // Candidates are 8-byte big-endian counters in base64url: 11 characters each.
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter++) {
    view.setBigUint64(0, BigInt(counter), false)
    const stamp = Buffer.from(buf).toString('base64url')
    const digest: Uint8Array = prefix.copy().update(enc.encode(stamp)).digest()
    if (leadingZeroBits(digest) >= bits) return stamp
  }
  throw new Error('no stamp found')
}

/**
 * Whether `rec.stamp` meets `bits`. A missing or malformed stamp fails (returns
 * false, never throws). At difficulty 0 the empty stamp and any well-formed
 * stamp pass.
 */
export async function verifyStamp (rec: StampRecord, bits: number): Promise<boolean> {
  if (!Number.isInteger(bits) || bits < 0 || bits > 256) return false
  const stamp = rec.stamp
  if (typeof stamp !== 'string') return false
  if (bits === 0) return stamp === '' || STAMP_RE.test(stamp)
  if (!STAMP_RE.test(stamp)) return false
  // A kind that carries no stamp (or a record the core refuses) cannot verify.
  let id: string
  try { id = await stamplessId(rec) } catch { return false }
  return leadingZeroBits(stampDigest(id, stamp)) >= bits
}
