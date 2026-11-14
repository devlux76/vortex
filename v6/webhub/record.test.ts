// #66 (v7 1.01): record core. Acceptance: sign/verify round-trips for every
// kind; tampering, reordering and a key that doesn't hash to `from` fail;
// unknown v/kind refused; committed vectors fix signing bytes and ids.
// Regenerate the vectors with WRITE_VECTORS=1 (only when the spec changes).
import { test, expect } from 'bun:test'
import { b64pad } from '../client/b64.ts'
import {
  DOMAIN, KINDS, type Kind, canonical, decode, encode, recordId, sign, signerFromSeed, signingBytes, stamplessId, stamplessSigningBytes, verify,
} from './record.ts'

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const TS = 1794537600
const VECTORS = new URL('./vectors/records.json', import.meta.url)

/** One fixed record body per kind (A9 §5.2), without from/key/sig. */
const SAMPLES: Record<Kind, Record<string, unknown>> = {
  members: { room: 'cm9vbS1pZA', nonce: 'bm9uY2U', epoch: 3, async: true, members: [{ wrap: 'd3JhcA', id: 'a'.repeat(64), enc: 'ZW5j' }], stamp: 'c3RhbXA' },
  msg: { room: 'cm9vbS1pZA', epoch: 3, seq: 7, body: 'c2VhbGVk' },
  head: { room: 'cm9vbS1pZA', epoch: 3, seq: 8, body: 'c2VhbGVk' },
  topic: { room: 'cm9vbS1pZA', content_type: 'text/plain', text: 'Find the leak in a 512 KiB block reader — ünïcode included', stamp: 'c3RhbXA' },
  redirect: { topic: 'dG9waWMtYQ', to: 'dG9waWMtYg' },
  match: { topic: 'dG9waWMtYQ', embedder: 'embedder-v1', matches: [{ score: 0.875, id: 'dG9waWMtYg' }] },
  hub: { url: 'https://hub.example/', embedder: null, limits: { room_bytes: 1048576, per_key_rps: 2 }, load_pct: 12, stamp: 'c3RhbXA' },
  refuse: { room: 'cm9vbS1pZA' },
  seed: { content_id: 'Y29udGVudA', size: 524289, sealed: false, servers: [{ url: 'https://seed.example/p' }], stamp: 'c3RhbXA' },
}

const kinds = Object.keys(KINDS) as Kind[]
const fields = (kind: Kind) => ({ v: 1, kind, ts: TS, exp: TS + 3600, ...SAMPLES[kind] })

test('sign then verify round-trips for every kind', async () => {
  const signer = await signerFromSeed(SEED)
  for (const kind of kinds) {
    const rec = await sign(fields(kind), signer)
    const verdict = await verify(rec)
    expect(verdict).toEqual({ ok: true, id: await recordId(rec) })
    expect(decode(encode(rec))).toEqual(rec)
  }
})

test('the signing bytes are DOMAIN + canonical JSON in the fixed order, nested lists in their order', async () => {
  const rec = await sign(fields('members'), await signerFromSeed(SEED))
  const text = new TextDecoder().decode(signingBytes(rec))
  expect(text.startsWith(DOMAIN)).toBe(true)
  const keys = Object.keys(JSON.parse(text.slice(DOMAIN.length)))
  expect(keys).toEqual(['v', 'kind', 'from', 'key', 'ts', 'exp', ...KINDS.members])
  expect(text).toContain('"members":[{"id":')
  const hub = new TextDecoder().decode(signingBytes(await sign(fields('hub'), await signerFromSeed(SEED))))
  expect(hub).toContain('"limits":{"per_key_rps":2,"room_bytes":1048576}')
})

test('changing any signed field fails', async () => {
  const signer = await signerFromSeed(SEED)
  for (const kind of kinds) {
    const rec = await sign(fields(kind), signer)
    for (const k of ['ts', 'exp', ...KINDS[kind]]) {
      const v = rec[k]
      // Same shape, different bytes, so the failure is the signature, not the form.
      const changed = typeof v === 'number' ? v + 1
        : typeof v === 'string' ? v + 'x'
          : typeof v === 'boolean' ? !v
            : v === null ? 'x'
              : Array.isArray(v) ? [...v, v[0]]
                : { ...(v as object), zz: 1 }
      expect(await verify({ ...rec, [k]: changed })).toEqual({ ok: false, reason: 'bad signature' })
    }
  }
})

test('a signature over reordered keys fails, and non-canonical wire text is refused', async () => {
  const signer = await signerFromSeed(SEED)
  const rec = await sign(fields('topic'), signer)
  // Sign the same fields serialized in a different key order.
  const { sig: _sig, ...body } = rec
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(body).reverse()))
  const badSig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer.privateKey, new TextEncoder().encode(DOMAIN + reordered)))
  expect((await verify({ ...rec, sig: b64pad.encode(badSig) })).ok).toBe(false)
  const wire = encode(rec)
  const spaced = wire.replace('","', '", "')
  expect(() => decode(spaced)).toThrow(/canonical/)
  const shuffled = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(wire)).reverse()))
  expect(() => decode(shuffled)).toThrow(/canonical/)
})

test('a key that does not hash to from fails, and a foreign key fails', async () => {
  const rec = await sign(fields('msg'), await signerFromSeed(SEED))
  expect(await verify({ ...rec, from: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'key does not hash to from' })
  const other = await sign(fields('msg'), await signerFromSeed(OTHER_SEED))
  expect((await verify({ ...rec, key: other.key })).ok).toBe(false)
  expect((await verify({ ...rec, sig: other.sig })).ok).toBe(false)
})

test('unknown v, unknown kind, unknown or missing fields are refused', async () => {
  const rec = await sign(fields('refuse'), await signerFromSeed(SEED))
  expect(await verify({ ...rec, v: 2 })).toEqual({ ok: false, reason: 'unknown v: 2' })
  expect(await verify({ ...rec, kind: 'chat' })).toEqual({ ok: false, reason: 'unknown kind: chat' })
  expect((await verify({ ...rec, extra: 1 })).ok).toBe(false)
  const { room: _room, ...missing } = rec
  expect((await verify(missing)).ok).toBe(false)
  expect((await verify({ ...rec, key: rec.key.replace(/=+$/, '') })).ok).toBe(false)
  expect(() => canonical({ ...rec, ts: 1.5 })).toThrow(/integer/)
})

test('stampless bytes use the canonical encoder with stamp omitted (A9 §12, #67 ruling)', async () => {
  const dec = new TextDecoder()
  for (const kind of ['members', 'topic', 'hub', 'seed'] as const) {
    const rec = await sign(fields(kind), await signerFromSeed(SEED))
    const stampless = dec.decode(stamplessSigningBytes(rec))
    // Same as the signing bytes with only the "stamp" member removed.
    const full = JSON.parse(dec.decode(signingBytes(rec)).slice(DOMAIN.length))
    delete full.stamp
    expect(stampless).toBe(DOMAIN + JSON.stringify(full))
    // Independent of whether stamp is present, and of input key order (members wrap-first, limits unsorted).
    const { stamp: _s, sig: _g, ...noStamp } = rec
    expect(dec.decode(stamplessSigningBytes(noStamp))).toBe(stampless)
    expect(await stamplessId(rec)).toBe(await stamplessId({ ...rec, stamp: 'different' }))
  }
  expect(dec.decode(stamplessSigningBytes(await sign(fields('members'), await signerFromSeed(SEED))))).toContain('"members":[{"id":')
  expect(() => stamplessSigningBytes(fields('msg'))).toThrow(/no stamp/)
})

test('committed vectors fix the signing bytes, id and signature for one record of each kind', async () => {
  const signer = await signerFromSeed(SEED)
  const built = []
  for (const kind of kinds) {
    const rec = await sign(fields(kind), signer)
    built.push({ kind, wire: encode(rec), signing_bytes_b64: b64pad.encode(signingBytes(rec)), id: await recordId(rec) })
  }
  const doc = { spec: 'A9 §5.1, §5.2 (#66)', domain: 'vortex-webhub-v1\\0', seed_hex: Buffer.from(SEED).toString('hex'), records: built }
  if (process.env.WRITE_VECTORS === '1') await Bun.write(VECTORS, JSON.stringify(doc, null, 2) + '\n')
  const committed = await Bun.file(VECTORS).json()
  expect(committed).toEqual(doc)
  for (const v of committed.records) {
    const rec = decode(v.wire)
    expect(await verify(rec)).toEqual({ ok: true, id: v.id })
  }
})

// #96 review defects (Sun, on 924c6d5). Each test fails on the previous encoder.

test('a nested own __proto__ member is signed, and changing it breaks the signature', async () => {
  const signer = await signerFromSeed(SEED)
  const limits = JSON.parse('{"__proto__":1,"a":2}') as Record<string, unknown>
  const rec = await sign({ ...fields('hub'), limits }, signer)
  expect(new TextDecoder().decode(signingBytes(rec))).toContain('"limits":{"__proto__":1,"a":2}')
  expect((await verify(rec)).ok).toBe(true)
  const tampered = { ...rec, limits: JSON.parse('{"__proto__":9,"a":2}') }
  expect(await verify(tampered)).toEqual({ ok: false, reason: 'bad signature' })
})

test('full signing and verification refuse an explicitly undefined required stamp', async () => {
  const signer = await signerFromSeed(SEED)
  await expect(sign({ ...fields('members'), stamp: undefined }, signer)).rejects.toThrow(/stamp/)
  const rec = await sign(fields('members'), signer)
  const verdict = await verify({ ...rec, stamp: undefined })
  expect(verdict.ok).toBe(false)
  // Intentional omission still works on the stampless path, with or without the key present.
  const { stamp: _s, sig: _g, ...noStamp } = rec
  expect(stamplessSigningBytes(noStamp)).toEqual(stamplessSigningBytes({ ...rec, stamp: undefined }))
})

test('non-JSON values are refused in nested fields too', async () => {
  const signer = await signerFromSeed(SEED)
  await expect(sign({ ...fields('hub'), limits: { a: undefined } }, signer)).rejects.toThrow(/undefined/)
  await expect(sign({ ...fields('hub'), limits: { a: () => 1 } }, signer)).rejects.toThrow(/function/)
  await expect(sign({ ...fields('hub'), limits: { a: 10n } }, signer)).rejects.toThrow(/bigint/)
})

test('integer-like nested keys are signed in UTF-16 code-unit order, not enumeration order', async () => {
  const signer = await signerFromSeed(SEED)
  const limits = JSON.parse('{"2":1,"10":2,"a":3}') as Record<string, unknown>
  const rec = await sign({ ...fields('hub'), limits }, signer)
  expect(new TextDecoder().decode(signingBytes(rec))).toContain('"limits":{"10":2,"2":1,"a":3}')
  expect(decode(encode(rec))).toEqual(rec)
  expect((await verify(rec)).ok).toBe(true)
})
