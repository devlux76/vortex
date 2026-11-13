// A8 §12 item 2a: the pure ledger and its §8 policy checks.
import { describe, expect, test } from 'bun:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import { sign, verify, type EconInput, type EconMessage, type Iou, type Quote, type Redeem } from './iou.ts'
import { Ledger, LedgerError } from './ledger.ts'
import { checkIssue, checkQuote, checkRedeem, declineRedeem, type EconPolicy } from './policy.ts'

const keys = { sun: await generateKeyPair('Ed25519'), winds: await generateKeyPair('Ed25519'), moon: await generateKeyPair('Ed25519') }
const id = (k: PrivateKey): string => peerIdFromPrivateKey(k).toString()
const SUN = id(keys.sun)
const WINDS = id(keys.winds)
const MOON = id(keys.moon)
const T = 1794537600

// Sign, then verify from the wire text: the ledger only ever sees verified messages.
async function msg<M extends EconMessage> (k: PrivateKey, body: Record<string, unknown>): Promise<M> {
  const m = await sign(k, { from: id(k), ts: T, ...body } as unknown as EconInput)
  return await verify(JSON.stringify(m)) as M
}
const iou = (k: PrivateKey, holder: string, face: number, extra: Record<string, unknown> = {}): Promise<Iou> =>
  msg<Iou>(k, { kind: 'iou', holder, face_tokens: face, quote: '', issued_at: T, expires_at: 0, ...extra })
const redeem = (k: PrivateKey, iouId: string, est: number): Promise<Redeem> =>
  msg<Redeem>(k, { kind: 'redeem', iou: iouId, task: 'QA PR #12', est_tokens: est })
const redeemed = (k: PrivateKey, iouId: string, redeemId: string, credited: number): Promise<EconMessage> =>
  msg(k, { kind: 'redeemed', iou: iouId, redeem: redeemId, credited_tokens: credited })

// Sun owes Winds 50,000 (A8 §7). `sun` is Sun's ledger (issuer side), `winds` is Winds' (holder side).
async function setup (face = 50000, extra: Record<string, unknown> = {}) {
  const sun = new Ledger(SUN)
  const winds = new Ledger(WINDS)
  const debt = await iou(keys.sun, WINDS, face, extra)
  sun.ingest(debt, T)
  winds.ingest(debt, T)
  const both = (m: EconMessage, now = T) => { sun.ingest(m, now); winds.ingest(m, now) }
  return { sun, winds, debt, both }
}

describe('lifecycle', () => {
  test('A8 §7: issue, partial redemptions, paid off at zero', async () => {
    const { sun, winds, debt, both } = await setup()
    expect(winds.owedBy(SUN, T)).toBe(50000)
    expect(sun.owedTo(WINDS, T)).toBe(50000)

    const r1 = await redeem(keys.winds, debt.id, 20000)
    both(r1)
    expect(sun.balance(debt, T)).toBe(50000) // a redeem alone credits nothing
    both(await redeemed(keys.winds, debt.id, r1.id, 18000))
    expect(sun.balance(debt, T)).toBe(32000)
    expect(winds.balance(debt, T)).toBe(32000)

    const r2 = await redeem(keys.winds, debt.id, 32000)
    both(r2)
    both(await redeemed(keys.winds, debt.id, r2.id, 32000))
    expect(sun.status(debt, T)).toBe('paid')
    expect(sun.balance(debt, T)).toBe(0)
    expect(sun.liabilities(T)).toBe(0)
    expect(sun.entry(debt)!.redeemed).toHaveLength(2) // the issuer keeps the holder's proofs
    await expect((async () => sun.ingest(await redeem(keys.winds, debt.id, 1), T))()).rejects.toThrow('retired (paid)')
  })

  test('per-peer views show liabilities and assets', async () => {
    const { winds } = await setup()
    winds.ingest(await iou(keys.winds, MOON, 7000), T)
    winds.ingest(await iou(keys.moon, WINDS, 1000000), T)
    expect(winds.peers(T)).toEqual([
      { peer: MOON, owesMe: 1000000, iOwe: 7000 },
      { peer: SUN, owesMe: 50000, iOwe: 0 },
    ].sort((a, b) => a.peer.localeCompare(b.peer)))
    expect(winds.assets(T)).toBe(1050000)
    expect(winds.liabilities(T)).toBe(7000)
  })

  test('round-trips through JSON', async () => {
    const { sun, debt } = await setup()
    const r = await redeem(keys.winds, debt.id, 10000)
    sun.ingest(r, T)
    sun.ingest(await redeemed(keys.winds, debt.id, r.id, 10000), T)
    const copy = Ledger.fromJSON(JSON.parse(JSON.stringify(sun)))
    expect(copy.balance(debt, T)).toBe(40000)
    expect(copy.toJSON()).toEqual(sun.toJSON())
    // dedupe and single crediting survive the round trip
    expect(copy.ingest(r, T).duplicate).toBe(true)
    await expect((async () => copy.ingest(await redeemed(keys.winds, debt.id, r.id, 5000), T))()).rejects.toThrow('already credited')
  })
})

describe('over-redemption', () => {
  test('a redeem over the remaining balance is declined, stating the remaining amount', async () => {
    const { sun, debt, both } = await setup(50000)
    const r1 = await redeem(keys.winds, debt.id, 20000)
    both(r1)
    both(await redeemed(keys.winds, debt.id, r1.id, 18000))
    const big = await redeem(keys.winds, debt.id, 32001)
    const reason = 'redeem asks for 32001 tokens but only 32000 remain on this iou'
    expect(checkRedeem(sun, big, T)).toEqual({ ok: false, reason, remaining: 32000 })
    // the decline Sun signs: ref, reason, remaining (A8 §6.2)
    const d = declineRedeem(sun, big, T)!
    expect(d).toEqual({ kind: 'decline', from: SUN, ref: big.id, reason, remaining: 32000 })
    const signed = await verify(JSON.stringify(await sign(keys.sun, { ...d, ts: T })))
    expect(signed).toMatchObject({ kind: 'decline', ref: big.id, remaining: 32000 })
    expect(declineRedeem(sun, await redeem(keys.winds, debt.id, 32000), T)).toBeUndefined()
    let err: unknown
    try { sun.ingest(big, T) } catch (e) { err = e }
    expect(err).toBeInstanceOf(LedgerError)
    expect((err as LedgerError).remaining).toBe(32000)
    expect((err as Error).message).toContain('only 32000 remain')
    expect(checkRedeem(sun, await redeem(keys.winds, debt.id, 32000), T)).toEqual({ ok: true })
  })

  test('a credit over the remaining balance is refused', async () => {
    const { sun, debt } = await setup(1000)
    const r = await redeem(keys.winds, debt.id, 1000)
    sun.ingest(r, T)
    await expect((async () => sun.ingest(await redeemed(keys.winds, debt.id, r.id, 1001), T))()).rejects.toThrow('exceeds the 1000 remaining')
  })
})

describe('dedupe on (from, id)', () => {
  test('a replayed redeemed is ignored, never double-credited', async () => {
    const { sun, debt } = await setup()
    const r = await redeem(keys.winds, debt.id, 20000)
    sun.ingest(r, T)
    const paid = await redeemed(keys.winds, debt.id, r.id, 18000)
    expect(sun.ingest(paid, T)).toEqual({ applied: true, duplicate: false })
    expect(sun.ingest(paid, T)).toEqual({ applied: false, duplicate: true })
    expect(sun.ingest({ ...paid }, T).duplicate).toBe(true)
    expect(sun.balance(debt, T)).toBe(32000)
    // a fresh redeemed for the same redeem (new id) is still refused
    await expect((async () => sun.ingest(await redeemed(keys.winds, debt.id, r.id, 18000), T))()).rejects.toThrow('already credited')
    expect(sun.balance(debt, T)).toBe(32000)
  })

  test('a replayed iou is ignored; same issuer reusing the id never adds debt', async () => {
    const { sun, debt } = await setup()
    expect(sun.ingest(debt, T).duplicate).toBe(true)
    expect(sun.liabilities(T)).toBe(50000)
    const clash = await iou(keys.sun, WINDS, 1, { id: debt.id, ts: T + 1 })
    expect(sun.ingest(clash, T).duplicate).toBe(true) // same (from, id)
    expect(sun.balance(debt, T)).toBe(50000)
  })

  test('IOUs are identified by (issuer, id): another issuer may use the same id', async () => {
    // Winds holds two IOUs with one id, from Sun and from Moon.
    const { winds, debt } = await setup(50000)
    const moonDebt = await iou(keys.moon, WINDS, 700, { id: debt.id })
    winds.ingest(moonDebt, T)
    expect(winds.balance(debt, T)).toBe(50000)
    expect(winds.balance(moonDebt, T)).toBe(700)
    // On each issuer's side the reference resolves within the pair.
    const moon = new Ledger(MOON)
    moon.ingest(moonDebt, T)
    const r = await redeem(keys.winds, debt.id, 700)
    moon.ingest(r, T)
    moon.ingest(await redeemed(keys.winds, debt.id, r.id, 700), T)
    expect(moon.status(moonDebt, T)).toBe('paid')
    // Winds' own copy of its redeem is ambiguous until it names the carrier peer.
    await expect((async () => winds.ingest(r, T))()).rejects.toThrow('ambiguous')
    winds.ingest(r, T, { peer: MOON })
    winds.ingest(await redeemed(keys.winds, debt.id, r.id, 700), T, { peer: MOON })
    expect(winds.status(moonDebt, T)).toBe('paid')
    expect(winds.balance(debt, T)).toBe(50000)
  })

  test('the same id from a different sender is a different message', async () => {
    const l = new Ledger(WINDS)
    const a = await msg(keys.sun, { kind: 'beacon', agent: SUN, pool: 'codex', used_pct: 30, resets_at: T, lending: true, id: 'A'.repeat(22) })
    const b = await msg(keys.moon, { kind: 'beacon', agent: MOON, pool: 'local', used_pct: 0, resets_at: T, lending: true, id: 'A'.repeat(22) })
    expect(l.ingest(a, T).applied).toBe(true)
    expect(l.ingest(b, T).applied).toBe(true)
  })
})

describe('retirement', () => {
  test('release forgives the rest', async () => {
    const { sun, winds, debt, both } = await setup()
    both(await msg(keys.winds, { kind: 'release', iou: debt.id }))
    expect(sun.status(debt, T)).toBe('released')
    expect(sun.owedTo(WINDS, T)).toBe(0)
    expect(winds.owedBy(SUN, T)).toBe(0)
    await expect((async () => sun.ingest(await redeem(keys.winds, debt.id, 1), T))()).rejects.toThrow('retired (released)')
  })

  test('expiry retires at expires_at; 0 means never', async () => {
    const { sun, debt } = await setup(50000, { expires_at: T + 3600 })
    expect(sun.status(debt, T + 3599)).toBe('live')
    expect(sun.status(debt, T + 3600)).toBe('expired')
    expect(sun.balance(debt, T + 3600)).toBe(0)
    expect(sun.liabilities(T + 3600)).toBe(0)
    await expect((async () => sun.ingest(await redeem(keys.winds, debt.id, 1), T + 4000))()).rejects.toThrow('retired (expired)')
    const forever = await iou(keys.sun, WINDS, 5)
    sun.ingest(forever, T)
    expect(sun.status(forever, T + 10 ** 9)).toBe('live')
  })
})

describe('signer roles', () => {
  test('redeem, redeemed and release must be signed by the holder', async () => {
    const { sun, debt } = await setup()
    const r = await redeem(keys.winds, debt.id, 100)
    sun.ingest(r, T)
    // the issuer cannot sign its own proof of payment
    await expect((async () => sun.ingest(await redeemed(keys.sun, debt.id, r.id, 100), T))()).rejects.toThrow('not signed by the iou holder')
    await expect((async () => sun.ingest(await redeemed(keys.moon, debt.id, r.id, 100), T))()).rejects.toThrow('not signed by the iou holder')
    await expect((async () => sun.ingest(await redeem(keys.moon, debt.id, 100), T))()).rejects.toThrow('not signed by the iou holder')
    await expect((async () => sun.ingest(await msg(keys.sun, { kind: 'release', iou: debt.id }), T))()).rejects.toThrow('not signed by the iou holder')
    expect(sun.balance(debt, T)).toBe(50000)
  })

  test('an iou must be signed by its issuer', async () => {
    // Moon signs an iou claiming to be from Sun: verify refuses it before the ledger sees it.
    const forged = await sign(keys.moon, { kind: 'iou', from: SUN, holder: WINDS, face_tokens: 9, quote: '', issued_at: T, expires_at: 0, ts: T })
    await expect(verify(forged)).rejects.toThrow('bad signature')
    const l = new Ledger(WINDS)
    await expect((async () => l.ingest(await iou(keys.sun, SUN, 9), T))()).rejects.toThrow('own issuer')
    await expect((async () => l.ingest(await iou(keys.sun, MOON, 9), T))()).rejects.toThrow('does not involve this agent')
  })

  test('a receipt must come from the quoted worker', async () => {
    const l = new Ledger(WINDS)
    const q = await msg<Quote>(keys.winds, { kind: 'quote', to: MOON, task: 'docs', est_tokens: 1000, offer_face_tokens: 1000, expires_at: T + 600 })
    l.ingest(q, T)
    await expect((async () => l.ingest(await msg(keys.sun, { kind: 'receipt', quote: q.id, spent_tokens: 1 }), T))()).rejects.toThrow('quoted worker')
    l.ingest(await msg(keys.moon, { kind: 'receipt', quote: q.id, spent_tokens: 1 }), T)
    expect(l.receipt(q)!.from).toBe(MOON)
  })
})

describe('policy (A8 §8)', () => {
  const policy: EconPolicy = { fleet: new Set([SUN, WINDS]), maxIssuedTokens: 100000, maxIssuedPerPeer: 60000, maxOwedByPeer: 80000 }

  test('global max_issued_tokens caps total outstanding debt across all holders', async () => {
    const l = new Ledger(WINDS)
    l.ingest(await iou(keys.winds, SUN, 60000), T)
    const fresh = { ...policy, fleet: new Set([SUN, WINDS, MOON, 'peer-x']) }
    expect(checkIssue(l, fresh, { holder: MOON, face_tokens: 40000, quote: '' }, T)).toEqual({ ok: true })
    const over = checkIssue(l, fresh, { holder: 'peer-x', face_tokens: 40001, quote: '' }, T)
    expect(over).toEqual({ ok: false, reason: 'would owe 100001 in total, over max_issued_tokens 100000' })
    // exactly at the cap is allowed
    expect(checkIssue(l, { ...fresh, maxIssuedPerPeer: undefined }, { holder: SUN, face_tokens: 40000, quote: '' }, T).ok).toBe(true)
  })

  test('optional per-counterparty cap', async () => {
    const l = new Ledger(WINDS)
    l.ingest(await iou(keys.winds, SUN, 50000), T)
    expect(checkIssue(l, policy, { holder: SUN, face_tokens: 10001, quote: '' }, T))
      .toEqual({ ok: false, reason: 'would owe 60001 to this holder, over the per-counterparty cap 60000' })
    expect(checkIssue(l, policy, { holder: SUN, face_tokens: 10000, quote: '' }, T).ok).toBe(true)
  })

  test('in-fleet: prospective IOUs allowed; outside: only after the receipt', async () => {
    const l = new Ledger(WINDS)
    expect(checkIssue(l, policy, { holder: SUN, face_tokens: 1000, quote: '' }, T).ok).toBe(true)

    const q = await msg<Quote>(keys.winds, { kind: 'quote', to: MOON, task: 'docs', est_tokens: 1000, offer_face_tokens: 5000, expires_at: T + 600 })
    l.ingest(q, T)
    expect(checkIssue(l, policy, { holder: MOON, face_tokens: 5000, quote: '' }, T).ok).toBe(false)
    const early = checkIssue(l, policy, { holder: MOON, face_tokens: 5000, quote: q.id }, T)
    expect(early).toEqual({ ok: false, reason: 'outside the fleet an iou is issued only after the work is delivered (no receipt yet)' })
    // the worker's claimed spend is not checked against the agreed face
    l.ingest(await msg(keys.moon, { kind: 'receipt', quote: q.id, spent_tokens: 999999 }), T)
    expect(checkIssue(l, policy, { holder: MOON, face_tokens: 5000, quote: q.id }, T)).toEqual({ ok: true })
    expect(checkIssue(l, policy, { holder: MOON, face_tokens: 5001, quote: q.id }, T))
      .toEqual({ ok: false, reason: 'face 5001 exceeds the 5000 agreed in the quote' })
  })

  test('max_owed_by_peer declines further work', async () => {
    const { winds } = await setup(50000)
    expect(checkQuote(winds, policy, { from: SUN, offer_face_tokens: 30000 }, T)).toEqual({ ok: true })
    expect(checkQuote(winds, policy, { from: SUN, offer_face_tokens: 30001 }, T))
      .toEqual({ ok: false, reason: 'peer would owe 80001, over max_owed_by_peer 80000' })
  })

  test('cannot issue to oneself', () => {
    expect(checkIssue(new Ledger(WINDS), policy, { holder: WINDS, face_tokens: 1, quote: '' }, T).ok).toBe(false)
  })
})
