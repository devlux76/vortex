// A9 §12 / §8.1 check 8 acceptance tests for #67, written test-first by the
// review side of the #56 pairing (Stars), against the encoding Clouds ruled
// on #67. The implementation under test is Ronin's `v6/webhub/stamp.ts` —
// which is deliberately standalone on this branch (the record core, #96, is
// not merged), so these tests are self-contained too and re-derive the ruled
// encoding independently of it. That independence is the point: a correct
// implementation passes without sharing code with the tests.
//
// The contract, from the task text and the ruling:
//   makeStamp(recordWithoutStamp, bits, keyOrder) -> string     (the stamp)
//   verifyStamp(record, bits, keyOrder)           -> boolean
// The difficulty AND the kind's key order are explicit arguments everywhere —
// nothing relies on ambient state, and no call omits them.
//
// The ruled encoding: the stampless id is the base64url (no padding) SHA-256
// of the signing bytes of the record with both `stamp` and `sig` absent — the
// domain `vortex-webhub-v1\0` followed by the canonical JSON in the kind's key
// order with the `stamp` key omitted. The stamp is 1–22 base64url characters,
// no padding; difficulty 0 also accepts the empty string, and the encoding
// holds at every difficulty, so a stamp outside the base64url alphabet is
// refused even at 0. The ruled hash is
// SHA-256( UTF-8(stamplessId) || UTF-8(stamp) ), no separator, both hashed as
// text, leading zero bits counted from the most significant bit of the first
// digest byte. A signed field changed after stamping changes the stampless id
// and voids the stamp.
import { describe, expect, test } from 'bun:test'
import { b64pad, b64url } from '../client/b64.ts'
import { keyIdOf } from '../client/edge-sign.ts'
import { makeStamp, verifyStamp } from './stamp.ts'

const T = { timeout: 60_000 } as const
const enc = new TextEncoder()

const DOMAIN = 'vortex-webhub-v1\0'
const COMMON = ['v', 'kind', 'from', 'key', 'ts', 'exp'] as const
/** §5.2 key orders, stamp included where the kind carries one. */
const MEMBERS_ORDER = [...COMMON, 'room', 'nonce', 'epoch', 'async', 'members', 'stamp']
const REFUSE_ORDER = [...COMMON, 'room'] as unknown as string[]

async function sha256 (bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** Synchronous SHA-256 for the mining loops (verification itself stays on WebCrypto). */
function shaSync (bytes: Uint8Array): Uint8Array {
  const h = new Bun.CryptoHasher('sha256')
  h.update(bytes)
  return new Uint8Array(h.digest())
}

/** Leading zero bits, counted from the most significant bit of the first byte (the ruling). */
function leadingZeroBits (digest: Uint8Array): number {
  let bits = 0
  for (const b of digest) {
    if (b === 0) { bits += 8; continue }
    bits += Math.clz32(b) - 24
    break
  }
  return bits
}

/** The canonical JSON of a record in its kind's key order, with absent fields (e.g. a stamp) and `sig` omitted. */
function canonical (rec: Record<string, unknown>): string {
  const order = rec.kind === 'refuse' ? REFUSE_ORDER : MEMBERS_ORDER
  const out: Record<string, unknown> = {}
  for (const k of order) {
    if (rec[k] !== undefined) out[k] = rec[k]
  }
  return JSON.stringify(out)
}

/** The stampless id per the ruling: base64url SHA-256 of DOMAIN + canonical (stamp and sig absent). */
async function stamplessId (rec: Record<string, unknown>): Promise<string> {
  const copy = { ...rec }
  delete copy.stamp
  delete copy.sig
  return b64url.encode(await sha256(enc.encode(DOMAIN + canonical(copy))))
}

/** The ruled hash: SHA-256( UTF-8(stamplessId) || UTF-8(stamp) ), no separator. */
const stampDigest = async (rec: Record<string, unknown>): Promise<Uint8Array> => {
  const stamp = rec.stamp
  const id0 = await stamplessId(rec)
  return await sha256(enc.encode(id0 + String(stamp ?? '')))
}

interface Signer { privateKey: CryptoKey, publicKey: CryptoKey, from: string, key: string }
let seedCounter = 0
const signer = async (): Promise<Signer> => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, from: await keyIdOf(spki), key: b64pad.encode(spki) }
}

/** Signs the fields over the full canonical form (stamp included), giving a complete record. */
const sign = async (fields: Record<string, unknown>, s: Signer): Promise<Record<string, unknown>> => {
  const full = { ...fields, from: s.from, key: s.key }
  const bytes = enc.encode(DOMAIN + canonical(full))
  const sig = b64pad.encode(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, s.privateKey, bytes as BufferSource)))
  return { ...full, sig }
}

/** The stampless form of a members record: from/key filled, no `stamp`, no `sig`. */
const stampless = async (): Promise<{ rec: Record<string, unknown>, fields: Record<string, unknown>, s: Signer }> => {
  const s = await signer()
  const fields = {
    v: 1, kind: 'members', ts: 1794537600, exp: 1794537600 + 7 * 86400,
    room: 'a'.repeat(64), nonce: 'B'.repeat(16), epoch: 1, async: false,
    members: [{ id: 'c'.repeat(64), enc: 'D'.repeat(43), wrap: 'E'.repeat(86) }],
  }
  return { rec: { ...fields, from: s.from, key: s.key }, fields, s }
}

const stamped = async (fields: Record<string, unknown>, stamp: string, s: Signer): Promise<Record<string, unknown>> =>
  await sign({ ...fields, stamp }, s)

/** Mines a stamp whose digest has between min (inclusive) and max (exclusive) zero bits. */
const mine = async (rec: Record<string, unknown>, min: number, max: number): Promise<string> => {
  const id0 = await stamplessId(rec)
  for (let i = 0; ; i++) {
    const stamp = b64url.encode(enc.encode(String(i)))
    const bits = leadingZeroBits(shaSync(enc.encode(id0 + stamp)))
    if (bits >= min && bits < max) return stamp
  }
}

describe('§12 stamp, acceptance', () => {
  test('a stamp made at 20 bits verifies at 20 (and the ruled formula reproduces it independently)', T, async () => {
    const { rec, fields, s } = await stampless()
    const stamp = makeStamp(rec, 20, MEMBERS_ORDER)
    expect(stamp.length).toBeGreaterThanOrEqual(1)
    expect(leadingZeroBits(await stampDigest({ ...rec, stamp }))).toBeGreaterThanOrEqual(20)
    const full = await stamped(fields, stamp, s)
    expect(verifyStamp(full, 20, MEMBERS_ORDER)).toBe(true)
    // a 20-bit-deep stamp below 24 bits does not verify at 24
    const shallowStamp = await mine(rec, 20, 24)
    const shallow = await stamped(fields, shallowStamp, s)
    expect(leadingZeroBits(await stampDigest(shallow))).toBeLessThan(24)
    expect(verifyStamp(shallow, 20, MEMBERS_ORDER)).toBe(true)
    expect(verifyStamp(shallow, 24, MEMBERS_ORDER)).toBe(false)
  })

  test('a 21-bit stamp verifies at 21 and fails at 22 and 24 (deterministic, no mining flake)', T, async () => {
    const { rec, fields, s } = await stampless()
    const stamp = await mine(rec, 21, 22)
    const full = await stamped(fields, stamp, s)
    expect(leadingZeroBits(await stampDigest(full))).toBe(21)
    expect(verifyStamp(full, 21, MEMBERS_ORDER)).toBe(true)
    expect(verifyStamp(full, 22, MEMBERS_ORDER)).toBe(false)
    expect(verifyStamp(full, 24, MEMBERS_ORDER)).toBe(false)
  })

  test('a stamp copied onto a different record fails', T, async () => {
    const { rec, fields, s } = await stampless()
    const stamp = makeStamp(rec, 20, MEMBERS_ORDER)
    const other = { ...fields, room: 'f'.repeat(64) }
    const bogus = await stamped(other, stamp, s)
    expect(verifyStamp(bogus, 20, MEMBERS_ORDER)).toBe(false)
  })

  test('a signed field mutated after stamping voids the stamp (the stampless id changes)', T, async () => {
    const { rec, fields, s } = await stampless()
    const stamp = makeStamp(rec, 20, MEMBERS_ORDER)
    const mutated = await stamped({ ...fields, epoch: 2 }, stamp, s)
    expect(verifyStamp(mutated, 20, MEMBERS_ORDER)).toBe(false)
    // and so does a record whose members list changed after stamping
    const tampered = { ...(await stamped(fields, stamp, s)) }
    ;(tampered.members as Array<{ id: string }>)[0]!.id = 'd'.repeat(64)
    expect(verifyStamp(tampered, 20, MEMBERS_ORDER)).toBe(false)
  })

  test('difficulty 0 accepts the empty string and any well-formed stamp; makeStamp returns the empty string', T, async () => {
    const { rec, fields, s } = await stampless()
    expect(makeStamp(rec, 0, MEMBERS_ORDER)).toBe('')
    const empty = await stamped(fields, '', s)
    expect(verifyStamp(empty, 0, MEMBERS_ORDER)).toBe(true)
    const real = await stamped(fields, 'A2_-z9', s)
    expect(verifyStamp(real, 0, MEMBERS_ORDER)).toBe(true)
    // the ruling keeps the encoding at every difficulty: outside the alphabet is refused even at 0
    const odd = await stamped(fields, '@@@', s)
    expect(verifyStamp(odd, 0, MEMBERS_ORDER)).toBe(false)
    // and a record with no `stamp` field carries no stamp at all
    const bare = await sign({ v: 1, kind: 'refuse', ts: 1794537600, exp: 1794537600 + 7 * 86400, room: 'a'.repeat(64) }, await signer())
    expect(verifyStamp(bare, 0, REFUSE_ORDER)).toBe(false)
  })

  test('an empty or absent stamp is refused when the difficulty is above zero', T, async () => {
    const { fields, s } = await stampless()
    const empty = await stamped(fields, '', s)
    expect(verifyStamp(empty, 1, MEMBERS_ORDER)).toBe(false)
    expect(verifyStamp(empty, 20, MEMBERS_ORDER)).toBe(false)
    // a kind whose order has no stamp can never carry one
    const bare = await sign({ v: 1, kind: 'refuse', ts: 1794537600, exp: 1794537600 + 7 * 86400, room: 'a'.repeat(64) }, await signer())
    expect(verifyStamp(bare, 20, REFUSE_ORDER)).toBe(false)
  })

  test('the stamp is at most 22 base64url characters with no padding, whatever its digest', T, async () => {
    const { rec, fields, s } = await stampless()
    const id0 = await stamplessId(rec)
    let deep = ''
    for (let i = 0; ; i++) {
      // a 23-character candidate, still base64url, with a varying prefix
      const candidate = (b64url.encode(enc.encode(String(i))) + 'x'.repeat(23)).slice(0, 23)
      if (leadingZeroBits(shaSync(enc.encode(id0 + candidate))) >= 20) { deep = candidate; break }
    }
    expect(deep.length).toBe(23)
    expect(leadingZeroBits(await stampDigest({ ...rec, stamp: deep }))).toBeGreaterThanOrEqual(20)
    const overstayed = await stamped(fields, deep, s)
    expect(verifyStamp(overstayed, 20, MEMBERS_ORDER)).toBe(false)
    // padding characters are outside the base64url stamp alphabet
    const padded = await stamped(fields, 'AA==', s)
    expect(verifyStamp(padded, 20, MEMBERS_ORDER)).toBe(false)
  })

  test('makeStamp ignores an existing stamp and sig: the result is the stampless id\'s stamp', T, async () => {
    const { fields, s } = await stampless()
    const already = await stamped(fields, 'AAAA', s)
    const restamped = makeStamp(already, 20, MEMBERS_ORDER)
    expect(restamped).not.toBe('AAAA')
    // inserted on the stampless form, it verifies
    const fresh = await stamped(fields, restamped, s)
    expect(verifyStamp(fresh, 20, MEMBERS_ORDER)).toBe(true)
  })

  test('making a 20-bit stamp finishes within a few seconds on CI', T, async () => {
    const { rec } = await stampless()
    const t0 = Date.now()
    makeStamp(rec, 20, MEMBERS_ORDER)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
})
