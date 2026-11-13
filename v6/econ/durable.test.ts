// A8 §10 durability for #73 (the code half; the acceptance half is Ronin's per
// the pairing rule on #56). Covers the task's three points from the code side:
// close/reopen equality over the full lifecycle, a duplicate instrument that
// loads cleanly, and the crash simulated by writing the record only — plus
// atomic-refusal and wrong-owner checks.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import { encode, sign, verify, type Accept, type EconInput, type EconMessage, type Iou, type Quote, type Receipt, type Redeem, type Redeemed } from './iou.ts'
import { DurableLedger } from './durable.ts'

const keys = { sun: await generateKeyPair('Ed25519'), winds: await generateKeyPair('Ed25519') }
const id = (k: PrivateKey): string => peerIdFromPrivateKey(k).toString()
const SUN = id(keys.sun)
const WINDS = id(keys.winds)
const T = 1794537600

async function msg<M extends EconMessage> (k: PrivateKey, body: Record<string, unknown>): Promise<M> {
  const m = await sign(k, { from: id(k), ts: T, ...body } as unknown as EconInput)
  return await verify(JSON.stringify(m)) as M
}

const dirs: string[] = []
const dbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'econ-durable-'))
  dirs.push(dir)
  return join(dir, 'ledger.db')
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** The full A8 §7 lifecycle, ingested on both sides of a DurableLedger pair. */
async function lifecycle (now = T): Promise<{ sun: DurableLedger, winds: DurableLedger, iou: Iou }> {
  const sun = DurableLedger.open(dbPath(), SUN)
  const winds = DurableLedger.open(dbPath(), WINDS)
  const quote = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA PR #12', est_tokens: 30000, offer_face_tokens: 50000, expires_at: T + 3600 })
  const accept = await msg<Accept>(keys.winds, { kind: 'accept', quote: quote.id, reason: 'can start now' })
  const receipt = await msg<Receipt>(keys.winds, { kind: 'receipt', quote: quote.id, spent_tokens: 21000 })
  const iou = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 50000, quote: quote.id, issued_at: T, expires_at: 0 })
  const redeem = await msg<Redeem>(keys.winds, { kind: 'redeem', issuer: SUN, iou: iou.id, task: 'QA PR #12', est_tokens: 20000 })
  const redeemed = await msg<Redeemed>(keys.winds, { kind: 'redeemed', issuer: SUN, iou: iou.id, redeem: redeem.id, credited_tokens: 18000 })
  for (const m of [quote, accept, receipt, iou, redeem, redeemed]) {
    sun.ingest(m, now)
    winds.ingest(m, now)
  }
  return { sun, winds, iou }
}

describe('durable ledger', () => {
  test('close and reopen: the derived state is identical over the full lifecycle', async () => {
    const before = await lifecycle()
    const views = (l: DurableLedger) => ({
      state: l.ledger.toJSON(),
      owedBy: l.ledger.owedBy(SUN, T),
      owedTo: l.ledger.owedTo(WINDS, T),
      liabilities: l.ledger.liabilities(T),
      assets: l.ledger.assets(T),
      entry: l.ledger.entry({ from: SUN, id: before.iou.id })?.credited,
      peers: l.ledger.peers(T),
    })
    const sunBefore = views(before.sun)
    const windsBefore = views(before.winds)
    before.sun.close()
    before.winds.close()

    // Reopening the same files: balances and references are identical, and the
    // instrument log does not grow.
    const sun = DurableLedger.open((before.sun.db).filename, SUN)
    const winds = DurableLedger.open((before.winds.db).filename, WINDS)
    expect(views(sun)).toEqual(sunBefore)
    expect(views(winds)).toEqual(windsBefore)
    expect(sun.count()).toBe(6)
    expect(winds.count()).toBe(6)
    // and it is idempotent: reopening again changes nothing
    sun.close()
    const sunAgain = DurableLedger.open((before.sun.db).filename, SUN)
    expect(views(sunAgain)).toEqual(sunBefore)
    sunAgain.close()
    winds.close()
  })

  test('the same instrument stored twice is one instrument', async () => {
    const l = DurableLedger.open(dbPath(), SUN)
    const iou = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 50000, quote: '', issued_at: T, expires_at: 0 })
    expect(l.ingest(iou, T)).toEqual({ applied: true, duplicate: false })
    expect(l.ingest(iou, T)).toEqual({ applied: false, duplicate: true })
    expect(l.count()).toBe(1)
    l.close()
  })

  test('a log file that contains a duplicate instrument loads cleanly and resolve does not throw', async () => {
    // A file written by something without the UNIQUE constraint: two identical rows.
    const path = dbPath()
    const iou = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 50000, quote: '', issued_at: T, expires_at: 0 })
    const raw = new Database(path, { create: true })
    raw.run('CREATE TABLE econ_instruments (seq INTEGER PRIMARY KEY AUTOINCREMENT, from_key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, now INTEGER NOT NULL)')
    raw.run('CREATE TABLE econ_state (id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'\')')
    for (let i = 0; i < 2; i++) raw.run('INSERT INTO econ_instruments (from_key, id, kind, body, now) VALUES (?, ?, ?, ?, ?)', [iou.from, iou.id, iou.kind, encode(iou), T])
    raw.close()
    const l = DurableLedger.open(path, SUN)
    expect(l.count()).toBe(2) // the file is preserved as it is
    expect(l.ledger.entry({ from: SUN, id: iou.id })).toBeDefined()
    expect(l.ledger.liabilities(T)).toBe(50000) // credited once, not twice
    expect(l.ledger.balance({ from: SUN, id: iou.id }, T)).toBe(50000)
    l.close()
  })

  test('a crash between record written and state updated recovers on reopen', async () => {
    const l = DurableLedger.open(dbPath(), WINDS)
    const quote = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA PR #12', est_tokens: 30000, offer_face_tokens: 50000, expires_at: T + 3600 })
    l.ingest(quote, T)
    // Simulate the crash: the next instrument's record is written, the state
    // snapshot is not (watermark stays behind).
    const iou = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 50000, quote: quote.id, issued_at: T, expires_at: 0 })
    const wm = (l.db.query('SELECT watermark FROM econ_state WHERE id = 1').get() as { watermark: number }).watermark
    expect(wm).toBe(1)
    l.db.run('INSERT INTO econ_instruments (from_key, id, kind, body, now) VALUES (?, ?, ?, ?, ?)', [iou.from, iou.id, iou.kind, encode(iou), T])
    l.close()

    const reopened = DurableLedger.open(l.db.filename, WINDS)
    expect(reopened.ledger.entry({ from: SUN, id: iou.id })).toBeDefined()
    expect(reopened.ledger.owedBy(SUN, T)).toBe(50000)
    // the recovered snapshot is now current: a third open replays nothing
    reopened.close()
    const third = DurableLedger.open(l.db.filename, WINDS)
    expect(third.count()).toBe(2)
    expect(third.ledger.owedBy(SUN, T)).toBe(50000)
    third.close()
  })

  test('a message the ledger refuses is written nowhere', async () => {
    const l = DurableLedger.open(dbPath(), SUN)
    const bad = await msg<Quote>(keys.sun, { kind: 'quote', to: SUN, task: 'self', est_tokens: 1, offer_face_tokens: 1, expires_at: 0 })
    expect(() => l.ingest(bad, T)).toThrow(/addressed to its sender/)
    expect(l.count()).toBe(0)
    l.close()
    const reopened = DurableLedger.open(l.db.filename, SUN)
    expect(reopened.count()).toBe(0)
    reopened.close()
  })

  test('the storage layer constrains no amount domain: a u32-maximum amount round-trips unchanged (#100)', async () => {
    const l = DurableLedger.open(dbPath(), SUN)
    // 2^32 - 1 is legal under every MAXINT proposed on #100, so this test
    // stays valid whichever width the operator rules; the storage layer just
    // carries the canonical text.
    const iou = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: 4294967295, quote: '', issued_at: T, expires_at: 0 })
    l.ingest(iou, T)
    l.close()
    const reopened = DurableLedger.open(l.db.filename, SUN)
    expect(reopened.ledger.entry({ from: SUN, id: iou.id })?.iou.face_tokens).toBe(4294967295)
    expect(reopened.ledger.liabilities(T)).toBe(4294967295)
    reopened.close()
  })

  test('a durable ledger belongs to one self', async () => {
    const l = DurableLedger.open(dbPath(), SUN)
    l.close()
    expect(() => DurableLedger.open(l.db.filename, WINDS)).toThrow(/belongs to/)
  })
})
