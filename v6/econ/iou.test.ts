// A8 §6 encoding, sign and verify: table-driven over every kind.
import { describe, expect, test } from 'bun:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { toString } from 'uint8arrays/to-string'
import {
  canonical, COST_HINTS, DOMAIN, ECON_KINDS, EconError, encode, KIND_FIELDS, newId, sign, signingBytes, validateBody, verify,
  type EconInput, type EconKind, type EconMessage, type Unsigned
} from './iou.ts'

const alice = await generateKeyPair('Ed25519')
const bob = await generateKeyPair('Ed25519')
const A = peerIdFromPrivateKey(alice).toString()
const B = peerIdFromPrivateKey(bob).toString()
const TS = 1794537600
const REF = newId()

// One valid input per kind; the first int field of each is the "amount" used below.
const CASES: Record<EconKind, Record<string, unknown>> = {
  beacon: { agent: A, pool: 'claude-5h', used_pct: 62, resets_at: TS + 3600, floor_pct: 20, callin_pct: 80, lending: true, cost_hint: 'frontier' },
  quote: { to: B, task: 'QA PR #12', est_tokens: 20000, offer_face_tokens: 50000, expires_at: TS + 600 },
  accept: { quote: REF, reason: '' },
  decline: { ref: REF, reason: 'redeem over the remaining balance', remaining: 32000 },
  receipt: { quote: REF, spent_tokens: 18000 },
  iou: { holder: B, face_tokens: 50000, quote: REF, issued_at: TS, expires_at: 0 },
  redeem: { issuer: A, iou: REF, task: 'docs cleanup', est_tokens: 20000 },
  redeemed: { issuer: A, iou: REF, redeem: REF, credited_tokens: 18000 },
  release: { issuer: A, iou: REF },
}

const input = (kind: EconKind, extra: Record<string, unknown> = {}): EconInput =>
  ({ kind, from: A, ts: TS, ...CASES[kind], ...extra }) as unknown as EconInput

function firstInt (kind: EconKind): string | undefined {
  return (KIND_FIELDS[kind] as readonly (readonly string[])[]).find(f => f[1] === 'int')?.[0]
}

function shuffled (o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).reverse())
}

describe('every kind', () => {
  test('covers the nine A8 kinds', () => {
    expect(ECON_KINDS.sort()).toEqual(['accept', 'beacon', 'decline', 'iou', 'quote', 'receipt', 'redeem', 'redeemed', 'release'])
  })

  for (const kind of Object.keys(CASES) as EconKind[]) {
    describe(kind, () => {
      test('round trip: sign, encode, verify by peer id', async () => {
        const m = await sign(alice, input(kind))
        expect(m.v).toBe(1)
        expect(m.kind).toBe(kind)
        const text = encode(m)
        const back = await verify(text)
        expect(back).toEqual(m)
        expect(encode(back)).toBe(text)
        // verify also takes the key, the peer id, or the raw 32-byte public key
        await verify(m, alice.publicKey)
        await verify(m, peerIdFromPrivateKey(alice))
        await verify(m, alice.publicKey.raw)
      })

      test('canonical key order regardless of input order', async () => {
        const m = await sign(alice, input(kind))
        const { sig, ...body } = m
        const want = ['v', 'kind', 'id', 'from', 'ts', ...KIND_FIELDS[kind].map(f => f[0])]
          .filter(k => (body as Record<string, unknown>)[k] !== undefined)
        expect(Object.keys(JSON.parse(canonical(shuffled(body) as Unsigned)))).toEqual(want)
        expect(canonical(shuffled(body) as Unsigned)).toBe(canonical(body as Unsigned))
        expect(await verify(shuffled({ ...m }))).toEqual(m)
        expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/)
      })

      test('tampered field fails', async () => {
        const m = await sign(alice, input(kind)) as unknown as Record<string, unknown>
        const amount = firstInt(kind)
        const t = amount !== undefined ? { ...m, [amount]: (m[amount] as number) + 1 } : { ...m, ts: TS + 1 }
        await expect(verify(t)).rejects.toThrow('bad signature')
        const other = kind === 'beacon' ? { from: B, agent: B } : { from: B }
        await expect(verify({ ...m, ...other })).rejects.toThrow('bad signature')
      })

      test('wrong signer fails', async () => {
        const m = await sign(bob, input(kind)) // claims from: A
        await expect(verify(m)).rejects.toThrow('bad signature')
      })

      test('wrong domain fails', async () => {
        const m = await sign(alice, input(kind))
        const { sig: _sig, ...body } = m
        const bytes = new TextEncoder().encode('vortex-v6-p2p-msg\0' + canonical(body as Unsigned))
        const forged = { ...body, sig: toString(await alice.sign(bytes), 'base64url') }
        await expect(verify(forged)).rejects.toThrow('bad signature')
        // and the right domain over the same body verifies
        const good = { ...body, sig: toString(await alice.sign(signingBytes(body as Unsigned)), 'base64url') }
        expect(await verify(good)).toEqual(m)
      })

      const amount = firstInt(kind)
      if (amount !== undefined) {
        test(`non-integer and negative ${amount} rejected`, async () => {
          for (const bad of [1.5, -1, '10', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
            await expect(sign(alice, input(kind, { [amount]: bad }))).rejects.toThrow(EconError)
          }
          const m = await sign(alice, input(kind)) as unknown as Record<string, unknown>
          await expect(verify({ ...m, [amount]: 0.5 })).rejects.toThrow('non-negative integer')
        })
      }

      test('A6 screen refuses a credential in any string field', async () => {
        const key = 'ghp_' + 'a1B2c3D4e5'.repeat(4)
        const strings = (KIND_FIELDS[kind] as readonly (readonly string[])[]).filter(f => f[1] === 'str' || f[1] === 'text').map(f => f[0])
        for (const f of strings) {
          await expect(sign(alice, input(kind, { [f]: `pay with ${key}` }))).rejects.toThrow(`refused: field ${f} contains a credential (github-token)`)
        }
        const m = await sign(alice, input(kind))
        await expect(verify({ ...m, id: newId(), from: `x ${key}` })).rejects.toThrow('credential')
      })

      test('missing field and unknown field rejected', async () => {
        const name = KIND_FIELDS[kind].find(f => f.length === 2)![0]
        const { [name]: _drop, ...rest } = CASES[kind]
        await expect(sign(alice, { kind, from: A, ts: TS, ...rest } as unknown as EconInput)).rejects.toThrow(`field ${name} missing`)
        const m = await sign(alice, input(kind))
        await expect(verify({ ...m, extra: 1 })).rejects.toThrow('unknown field extra')
      })
    })
  }
})

describe('common fields', () => {
  test('id is 128 random bits, base64url', () => {
    const id = newId()
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newId()).not.toBe(id)
  })

  test('sign fills id and ts (Unix seconds)', async () => {
    const m = await sign(alice, { kind: 'release', from: A, issuer: A, iou: REF })
    expect(m.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Math.abs(m.ts - Date.now() / 1000)).toBeLessThan(5)
  })

  test('bad version, kind, id and signature shapes rejected', async () => {
    const m = await sign(alice, input('release')) as EconMessage
    await expect(verify({ ...m, v: 2 })).rejects.toThrow('unsupported message version')
    await expect(verify({ ...m, kind: 'pledge' })).rejects.toThrow('unknown message kind')
    await expect(verify({ ...m, id: 'short' })).rejects.toThrow('malformed message id')
    await expect(verify({ ...m, sig: 'AAAA' })).rejects.toThrow('malformed signature')
    await expect(verify('{not json')).rejects.toThrow('not JSON')
    await expect(verify([])).rejects.toThrow('not an object')
  })

  test('a hub-principal sender carries its key id; verify binds from to the expected sender', async () => {
    await expect(sign(alice, input('release', { from: 'winds' }))).rejects.toThrow('carries its key id')
    const m = await sign(alice, input('release', { from: 'winds', key: 'a'.repeat(64) }))
    await expect(verify(m)).rejects.toThrow('not a peer id')
    expect((await verify(m, alice.publicKey.raw, 'winds')).from).toBe('winds')
    await expect(verify(m, alice.publicKey.raw, 'clouds')).rejects.toThrow('does not match the expected sender')
    await expect(verify(m, new Uint8Array(31))).rejects.toThrow('32 bytes')
  })

  test('4096-byte bound', async () => {
    await expect(sign(alice, input('redeem', { task: 'x'.repeat(4096) }))).rejects.toThrow('longer than 4096')
    expect(DOMAIN).toBe('vortex-iou-v1\0')
  })
})

describe('beacon ranges', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['used over 100', { used_pct: 101 }, 'used_pct'],
    ['floor over callin', { floor_pct: 90, callin_pct: 80 }, 'floor_pct must not exceed'],
    ['callin over 100', { floor_pct: undefined, callin_pct: 101 }, 'callin_pct'],
    ['floor over 100', { callin_pct: undefined, floor_pct: 101 }, 'floor_pct'],
    ['cost_hint outside the classes', { cost_hint: 'metered' }, 'cost_hint'],
    ['lending not boolean', { lending: 'yes' }, 'lending'],
    ['agent is not the signer', { agent: B }, 'beacon agent must equal from'],
  ]
  for (const [name, extra, msg] of bad) {
    test(name, async () => {
      await expect(sign(alice, input('beacon', extra))).rejects.toThrow(msg)
    })
  }

  test('optional fields may be absent; floor 0 and equal bounds allowed', async () => {
    const m = await sign(alice, input('beacon', { floor_pct: undefined, callin_pct: undefined, cost_hint: undefined }))
    expect(Object.keys(m)).not.toContain('floor_pct')
    await verify(encode(m))
    await sign(alice, input('beacon', { floor_pct: 0, callin_pct: 0 }))
    await sign(alice, input('beacon', { floor_pct: 100, callin_pct: 100, used_pct: 100 }))
    for (const c of COST_HINTS) await sign(alice, input('beacon', { cost_hint: c }))
  })
})

describe('decline', () => {
  test('remaining is optional (absent when declining a quote)', async () => {
    const m = await sign(alice, input('decline', { remaining: undefined, reason: 'over max_owed_by_peer' }))
    expect(Object.keys(m)).not.toContain('remaining')
    expect(encode(m)).not.toContain('remaining')
    await verify(encode(m))
  })
})

describe('verify: size bound and authenticated sender (Sun QA on #34)', () => {
  test('object input is bounded like text input (5000-byte task, validly signed)', async () => {
    const body = validateBody({ v: 1, kind: 'redeem', from: A, id: newId(), ts: TS, issuer: A, iou: REF, task: 'x'.repeat(5000), est_tokens: 20000 })
    const sig = toString(await alice.sign(signingBytes(body)), 'base64url')
    const obj = { ...body, sig }
    await expect(verify(obj, alice.publicKey)).rejects.toThrow(/longer than/)
    await expect(verify(JSON.stringify(obj), alice.publicKey)).rejects.toThrow(/longer than/)
  })

  test('key A signing as peer B is refused (explicit peer ids and derived keys)', async () => {
    const m = await sign(alice, input('redeem', { from: B }))
    await expect(verify(m, alice.publicKey)).rejects.toThrow(/does not match the key/)
    await expect(verify(m, peerIdFromPrivateKey(alice))).rejects.toThrow(/does not match the key/)
    await expect(verify(m, alice.publicKey, A)).rejects.toThrow(/does not match the expected sender/)
  })

  test('a hub-name sender carries its key id and needs the expected name; a key alone cannot authenticate it', async () => {
    await expect(sign(alice, input('redeem', { from: 'winds' }))).rejects.toThrow(/carries its key id/)
    const m = await sign(alice, input('redeem', { from: 'winds', key: 'a'.repeat(64) }))
    await expect(verify(m, alice.publicKey)).rejects.toThrow(/pass the expected sender/)
    await expect(verify(m, alice.publicKey, 'clouds')).rejects.toThrow(/does not match the expected sender/)
    expect((await verify(m, alice.publicKey, 'winds')).from).toBe('winds')
    // A malformed key id is refused at validation.
    await expect(sign(alice, input('redeem', { from: 'winds', key: 'short' }))).rejects.toThrow(/key_id/)
  })
})

describe('A8 §6.1 wire contract (#33 at 86f7f70, Sun QA on #34)', () => {
  test('settlement kinds carry a signed issuer in canonical order', async () => {
    const redeem = await sign(alice, input('redeem'))
    const keys = Object.keys(JSON.parse(encode(redeem)))
    expect(keys).toEqual(['v', 'kind', 'id', 'from', 'ts', 'issuer', 'iou', 'task', 'est_tokens', 'sig'])
    const redeemed = await sign(alice, input('redeemed'))
    expect(Object.keys(JSON.parse(encode(redeemed)))).toEqual(['v', 'kind', 'id', 'from', 'ts', 'issuer', 'iou', 'redeem', 'credited_tokens', 'sig'])
    const release = await sign(alice, input('release'))
    expect(Object.keys(JSON.parse(encode(release)))).toEqual(['v', 'kind', 'id', 'from', 'ts', 'issuer', 'iou', 'sig'])
    // The common `key` field sits after `ts` when present.
    const hub = await sign(alice, input('redeem', { from: 'winds', key: 'a'.repeat(64) }))
    expect(Object.keys(JSON.parse(encode(hub)))).toEqual(['v', 'kind', 'id', 'from', 'ts', 'key', 'issuer', 'iou', 'task', 'est_tokens', 'sig'])
  })

  test('ES256: a P-256 A7 key verifies when resolved, bound to the expected sender', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const signer = { sign: async (data: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data as BufferSource)) }
    const m = await sign(signer, input('redeem', { from: 'sun', key: 'b'.repeat(64) }))
    await verify(m, pair.publicKey, 'sun')
    await expect(verify(m, pair.publicKey, 'winds')).rejects.toThrow('does not match the expected sender')
    await expect(verify(m, pair.publicKey)).rejects.toThrow('pass the expected sender')
    await expect(verify({ ...m, est_tokens: ((m as unknown as Record<string, number>).est_tokens) + 1 }, pair.publicKey, 'sun')).rejects.toThrow('bad signature')
  })
})
