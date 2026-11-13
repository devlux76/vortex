// A8 §12 item 2a: the pure ledger and its §8 policy checks.
import { describe, expect, test } from 'bun:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import { newId, sign, verify, type EconInput, type EconMessage, type Iou, type Quote, type Receipt, type Redeem } from './iou.ts'
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
// `issuer` is the signed issuer of the IOU (A8 §6.1); Sun issued the default debt.
const redeem = (k: PrivateKey, iouId: string, est: number, issuer = SUN): Promise<Redeem> =>
  msg<Redeem>(k, { kind: 'redeem', issuer, iou: iouId, task: 'QA PR #12', est_tokens: est })
const redeemed = (k: PrivateKey, iouId: string, redeemId: string, credited: number, issuer = SUN): Promise<EconMessage> =>
  msg(k, { kind: 'redeemed', issuer, iou: iouId, redeem: redeemId, credited_tokens: credited })

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
    // The redeem names its issuer in its signature, so it resolves without any carrier context.
    const r = await redeem(keys.winds, debt.id, 700, MOON)
    moon.ingest(r, T)
    moon.ingest(await redeemed(keys.winds, debt.id, r.id, 700, MOON), T)
    expect(moon.status(moonDebt, T)).toBe('paid')
    winds.ingest(r, T)
    winds.ingest(await redeemed(keys.winds, debt.id, r.id, 700, MOON), T)
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
    both(await msg(keys.winds, { kind: 'release', issuer: SUN, iou: debt.id }))
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
    await expect((async () => sun.ingest(await msg(keys.sun, { kind: 'release', issuer: SUN, iou: debt.id }), T))()).rejects.toThrow('not signed by the iou holder')
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
    l.ingest(await msg(keys.moon, { kind: 'accept', quote: q.id, reason: '' }), T)
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
    l.ingest(await msg(keys.moon, { kind: 'accept', quote: q.id, reason: '' }), T)
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

describe('settlement and quotes (Sun QA on #35)', () => {
  test('a proof for issuer A never changes issuer B balance (same IOU id from A and B)', async () => {
    const holder = new Ledger(WINDS)
    const SHARED = newId()
    const fromA = await msg<Iou>(keys.sun, { kind: 'iou', id: SHARED, holder: WINDS, face_tokens: 100, quote: '', issued_at: T, expires_at: 0 })
    const fromB = await msg<Iou>(keys.moon, { kind: 'iou', id: SHARED, holder: WINDS, face_tokens: 100, quote: '', issued_at: T, expires_at: 0 })
    holder.ingest(fromA, T)
    holder.ingest(fromB, T)
    // The redeem is signed against A's IOU, and its proof names A too.
    const r = await msg<Redeem>(keys.winds, { kind: 'redeem', issuer: SUN, iou: SHARED, task: 'QA', est_tokens: 75 })
    holder.ingest(r, T)
    // A proof naming B cannot settle a redeem signed against A (no redeem on B's IOU).
    await expect((async () => holder.ingest(await msg(keys.winds, { kind: 'redeemed', issuer: MOON, iou: SHARED, redeem: r.id, credited_tokens: 75 }), T))())
      .rejects.toThrow('names no redeem')
    holder.ingest(await msg(keys.winds, { kind: 'redeemed', issuer: SUN, iou: SHARED, redeem: r.id, credited_tokens: 75 }), T)
    expect(holder.balance(fromA, T)).toBe(25)
    expect(holder.balance(fromB, T)).toBe(100)
    // Settlement survives serialisation and stays per issuer.
    const copy = Ledger.fromJSON(JSON.parse(JSON.stringify(holder)))
    expect(copy.balance(fromB, T)).toBe(100)
    await expect((async () => copy.ingest(await msg(keys.winds, { kind: 'redeemed', issuer: SUN, iou: SHARED, redeem: r.id, credited_tokens: 1 }), T))())
      .rejects.toThrow('already credited')
  })

  const qpolicy: EconPolicy = { fleet: new Set([SUN, WINDS]), maxIssuedTokens: 1e9, maxOwedByPeer: 1e9 }

  test('one IOU per quote: a second IOU against the same quote is refused, whatever its face', async () => {
    const sun = new Ledger(SUN)
    const q = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA PR #12', est_tokens: 20000, offer_face_tokens: 50000, expires_at: T + 600 })
    sun.ingest(q, T)
    const first = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 50000, quote: q.id, issued_at: T, expires_at: 0 })
    sun.ingest(first, T)
    expect(checkIssue(sun, qpolicy, { holder: WINDS, face_tokens: 1000, quote: q.id }, T))
      .toEqual({ ok: false, reason: 'quote already has an iou from this agent (one iou per quote)' })
    const second = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 1000, quote: q.id, issued_at: T, expires_at: 0 })
    expect(() => sun.ingest(second, T)).toThrow('quote already has an iou from this issuer')
  })

  test('face may not exceed the quote offer', async () => {
    const winds = new Ledger(WINDS)
    const q = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA', est_tokens: 1000, offer_face_tokens: 5000, expires_at: T + 600 })
    winds.ingest(q, T)
    const over = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 5001, quote: q.id, issued_at: T, expires_at: 0 })
    expect(() => winds.ingest(over, T)).toThrow('exceeds the 5000 agreed in the quote')
  })

  test('accept gates on time, not issuance (A8 §6.2, Sun QA on #35)', async () => {
    const winds = new Ledger(WINDS)
    const q = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA', est_tokens: 1000, offer_face_tokens: 5000, expires_at: T + 10 })
    winds.ingest(q, T)
    // A receipt with no acceptance is refused.
    const early = await msg<Receipt>(keys.winds, { kind: 'receipt', quote: q.id, spent_tokens: 100, ts: T + 3 })
    expect(() => winds.ingest(early, T + 3)).toThrow('must reference an accepted quote')
    // An acceptance on time is recorded.
    winds.ingest(await msg(keys.winds, { kind: 'accept', quote: q.id, reason: '', ts: T + 4 }), T + 4)
    expect(winds.accept(q)?.ts).toBe(T + 4)
    // Delivery and the receipt may follow expiry.
    winds.ingest(await msg<Receipt>(keys.winds, { kind: 'receipt', quote: q.id, spent_tokens: 100, ts: T + 12 }), T + 12)
    // Issuance after expiry is fine when the acceptance was on time.
    const debt = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 5000, quote: q.id, issued_at: T + 20, expires_at: 0 })
    winds.ingest(debt, T + 20)
    expect(winds.balance(debt, T + 20)).toBe(5000)
    // One IOU per quote still holds after expiry.
    const again = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 1, quote: q.id, issued_at: T + 21, expires_at: 0 })
    expect(() => winds.ingest(again, T + 21)).toThrow('quote already has an iou from this issuer')
  })

  test('a late or missing acceptance is void: no receipt, no settlement', async () => {
    const winds = new Ledger(WINDS)
    const q = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA', est_tokens: 1000, offer_face_tokens: 5000, expires_at: T + 10 })
    winds.ingest(q, T)
    // An accept at the expiry instant is void.
    const late = await msg(keys.winds, { kind: 'accept', quote: q.id, reason: '', ts: T + 10 })
    expect(() => winds.ingest(late, T + 10)).toThrow('accept is void: at or after the quote expiry')
    expect(winds.accept(q)).toBeUndefined()
    // With no recorded acceptance, the receipt is refused.
    const receipt = await msg<Receipt>(keys.winds, { kind: 'receipt', quote: q.id, spent_tokens: 1, ts: T + 11 })
    expect(() => winds.ingest(receipt, T + 11)).toThrow('must reference an accepted quote')
  })
})

describe('review on #35: collisions, precision, aliasing', () => {
  test('a quote id from another sender is kept apart, never replaces the original', async () => {
    const w = new Ledger(WINDS)
    const id = newId()
    const q1 = await msg<Quote>(keys.sun, { kind: 'quote', id, to: WINDS, task: 'first', est_tokens: 1, offer_face_tokens: 10, expires_at: T + 600 })
    const q2 = await msg<Quote>(keys.moon, { kind: 'quote', id, to: WINDS, task: 'second', est_tokens: 1, offer_face_tokens: 10, expires_at: T + 600 })
    w.ingest(q1, T)
    w.ingest(q2, T)
    expect(w.quote(SUN, id)?.task).toBe('first')
    expect(w.quote(MOON, id)?.task).toBe('second')
  })

  test('the same redeem id from two holders settles two different IOUs', async () => {
    const sun = new Ledger(SUN)
    const debtA = await iou(keys.sun, WINDS, 100)
    const debtB = await iou(keys.sun, MOON, 100)
    sun.ingest(debtA, T)
    sun.ingest(debtB, T)
    const rid = newId()
    const rA = await msg<Redeem>(keys.winds, { kind: 'redeem', id: rid, issuer: SUN, iou: debtA.id, task: 'a', est_tokens: 10 })
    const rB = await msg<Redeem>(keys.moon, { kind: 'redeem', id: rid, issuer: SUN, iou: debtB.id, task: 'b', est_tokens: 10 })
    sun.ingest(rA, T)
    sun.ingest(rB, T)
    sun.ingest(await msg(keys.winds, { kind: 'redeemed', issuer: SUN, iou: debtA.id, redeem: rid, credited_tokens: 10 }), T)
    sun.ingest(await msg(keys.moon, { kind: 'redeemed', issuer: SUN, iou: debtB.id, redeem: rid, credited_tokens: 10 }), T)
    expect(sun.balance(debtA, T)).toBe(90)
    expect(sun.balance(debtB, T)).toBe(90)
  })

  test('sums stay exact near the safe-integer limit (remaining computed per IOU)', async () => {
    const sun = new Ledger(SUN)
    const small = await iou(keys.sun, WINDS, 2)
    const big = await iou(keys.sun, WINDS, Number.MAX_SAFE_INTEGER)
    sun.ingest(small, T)
    sun.ingest(big, T)
    const r = await msg<Redeem>(keys.winds, { kind: 'redeem', issuer: SUN, iou: big.id, task: 'x', est_tokens: Number.MAX_SAFE_INTEGER - 1 })
    sun.ingest(r, T)
    sun.ingest(await msg(keys.winds, { kind: 'redeemed', issuer: SUN, iou: big.id, redeem: r.id, credited_tokens: Number.MAX_SAFE_INTEGER - 1 }), T)
    expect(sun.owedTo(WINDS, T)).toBe(3)
  })

  test('a saved state is not changed by later ingests', async () => {
    const { sun, debt } = await setup(50000)
    const saved = sun.toJSON()
    const r = await redeem(keys.winds, debt.id, 1000)
    sun.ingest(r, T)
    sun.ingest(await redeemed(keys.winds, debt.id, r.id, 1000), T)
    expect(saved.ious[0].credited).toBe(0)
    expect(saved.ious[0].redeemed).toHaveLength(0)
    expect(Ledger.fromJSON(saved).balance(debt, T)).toBe(50000)
  })
})

// Invictus QA on #3 (F1, F2): unknown quotes and repeated records.
describe('QA fixes: unknown quotes and repeated records', () => {
  test('F1: an iou naming a quote the ledger does not hold is refused at any face', async () => {
    const winds = new Ledger(WINDS)
    const ghost = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 999999, quote: newId(), issued_at: T, expires_at: 0 })
    expect(() => winds.ingest(ghost, T)).toThrow('iou references an unknown quote')
    expect(winds.entry(ghost)).toBeUndefined()
  })

  test('F2: a quote recorded twice in saved state still resolves (no ambiguity)', async () => {
    const sun = new Ledger(SUN)
    const q = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA', est_tokens: 1000, offer_face_tokens: 5000, expires_at: T + 600 })
    sun.ingest(q, T)
    const saved = sun.toJSON()
    const restored = Ledger.fromJSON({ ...saved, quotes: [...saved.quotes, ...saved.quotes] })
    const acc = await msg(keys.winds, { kind: 'accept', quote: q.id, reason: '', ts: T + 1 })
    expect(() => restored.ingest(acc, T + 1)).not.toThrow()
    expect(restored.accept(q)).toBeDefined()
  })
})
