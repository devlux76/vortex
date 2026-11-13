// A8 §10 acceptance tests for #73 (the acceptance half; the code half is Stars'
// per the pairing rule on #56). Written against the task's three points, and
// deliberately not through durable.test.ts's helpers: each check compares the
// durable ledger with an uncrashed, non-durable twin, or with its own state
// before a close, so a regression in the code cannot pass by agreeing with itself.
//
// Amounts are checked only as the u32 boundary (#100 / #102: whole kilotokens,
// 1..4,294,967,295). The durable layer must round-trip any amount unchanged.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'
import { encode, sign, verify, type Accept, type EconInput, type EconMessage, type Iou, type Quote, type Receipt, type Redeem, type Redeemed } from './iou.ts'
import { DurableLedger } from './durable.ts'
import { Ledger } from './ledger.ts'

const keys = { sun: await generateKeyPair('Ed25519'), winds: await generateKeyPair('Ed25519') }
const id = (k: PrivateKey): string => peerIdFromPrivateKey(k).toString()
const SUN = id(keys.sun)
const WINDS = id(keys.winds)
const T = 1794537600
const U32_MAX = 4294967295

async function msg<M extends EconMessage> (k: PrivateKey, body: Record<string, unknown>): Promise<M> {
  const m = await sign(k, { from: id(k), ts: T, ...body } as unknown as EconInput)
  return await verify(JSON.stringify(m)) as M
}

const dirs: string[] = []
const newPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'econ-durable-acc-'))
  dirs.push(dir)
  return join(dir, 'ledger.db')
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** The A8 §7 lifecycle as messages, in the order a real exchange produces them. */
async function lifecycleMessages (face = 50000, credited = 18000): Promise<EconMessage[]> {
  const quote = await msg<Quote>(keys.sun, { kind: 'quote', to: WINDS, task: 'QA PR #12', est_tokens: 30000, offer_face_tokens: face, expires_at: T + 3600 })
  const accept = await msg<Accept>(keys.winds, { kind: 'accept', quote: quote.id, reason: 'can start now' })
  const receipt = await msg<Receipt>(keys.winds, { kind: 'receipt', quote: quote.id, spent_tokens: 21000 })
  const iou = await msg<Iou>(keys.sun, { kind: 'iou', holder: WINDS, face_tokens: face, quote: quote.id, issued_at: T, expires_at: 0 })
  const redeem = await msg<Redeem>(keys.winds, { kind: 'redeem', issuer: SUN, iou: iou.id, task: 'QA PR #12', est_tokens: 20000 })
  const redeemed = await msg<Redeemed>(keys.winds, { kind: 'redeemed', issuer: SUN, iou: iou.id, redeem: redeem.id, credited_tokens: credited })
  return [quote, accept, receipt, iou, redeem, redeemed]
}

/** Everything a caller can ask a ledger, as plain data, so two ledgers can be compared whole. */
function snapshotOf (l: Ledger, self: string, quote: Quote | undefined, now = T): unknown {
  return {
    state: l.toJSON(),
    peers: l.peers(now),
    liabilities: l.liabilities(now),
    assets: l.assets(now),
    owedBy: l.owedBy(self === SUN ? WINDS : SUN, now),
    owedTo: l.owedTo(self === SUN ? WINDS : SUN, now),
    accept: quote === undefined ? undefined : l.accept({ from: quote.from, id: quote.id }),
    receipt: quote === undefined ? undefined : l.receipt({ from: quote.from, id: quote.id }),
  }
}

test('close and reopen: the whole state and every view is identical to before the close', async () => {
  const path = newPath()
  const sun = DurableLedger.open(path, SUN)
  const msgs = await lifecycleMessages()
  for (const m of msgs) sun.ingest(m, T)
  const quote = msgs[0] as Quote
  const before = snapshotOf(sun.ledger, SUN, quote)
  sun.close()

  const reopened = DurableLedger.open(path, SUN)
  expect(snapshotOf(reopened.ledger, SUN, quote)).toEqual(before)
  reopened.close()

  // And a second cycle changes nothing either.
  const again = DurableLedger.open(path, SUN)
  expect(snapshotOf(again.ledger, SUN, quote)).toEqual(before)
  again.close()
})

test('the durable ledger agrees with an uncrashed twin ledger after reopen, from both sides', async () => {
  const msgs = await lifecycleMessages()
  const quote = msgs[0] as Quote
  const sunPath = newPath()
  const sun = DurableLedger.open(sunPath, SUN)
  const winsPath = newPath()
  const winds = DurableLedger.open(winsPath, WINDS)
  for (const m of msgs) { sun.ingest(m, T); winds.ingest(m, T) }
  sun.close()
  winds.close()

  const twinSun = new Ledger(SUN)
  const twinWinds = new Ledger(WINDS)
  for (const m of msgs) { twinSun.ingest(m, T); twinWinds.ingest(m, T) }
  expect(snapshotOf(DurableLedger.open(sunPath, SUN).ledger, SUN, quote)).toEqual(snapshotOf(twinSun, SUN, quote))
  expect(snapshotOf(DurableLedger.open(winsPath, WINDS).ledger, WINDS, quote)).toEqual(snapshotOf(twinWinds, WINDS, quote))
})

test('a legacy file with duplicate quote and accept rows loads cleanly, and resolve finds each once', async () => {
  // Written by something without the UNIQUE constraint: the same quote and accept twice.
  const path = newPath()
  const [quote, accept] = await lifecycleMessages()
  const raw = new Database(path, { create: true })
  raw.run('CREATE TABLE econ_instruments (seq INTEGER PRIMARY KEY AUTOINCREMENT, from_key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, now INTEGER NOT NULL)')
  raw.run('CREATE TABLE econ_state (id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'\')')
  raw.run('CREATE TABLE econ_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  raw.run('INSERT INTO econ_meta (k, v) VALUES (\'owner\', ?)', [WINDS])
  for (const m of [quote, accept, quote, accept]) {
    raw.run('INSERT INTO econ_instruments (from_key, id, kind, body, now) VALUES (?, ?, ?, ?, ?)', [m.from, m.id, m.kind, encode(m), T])
  }
  raw.close()

  const l = DurableLedger.open(path, WINDS)
  expect(() => l.ledger.quote(SUN, quote.id)).not.toThrow()
  expect(l.ledger.quote(SUN, quote.id)).toBeDefined()
  expect(l.ledger.accept({ from: SUN, id: quote.id })).toBeDefined()
  expect(l.ledger.toJSON().quotes).toHaveLength(1)
  expect(l.ledger.toJSON().accepts).toHaveLength(1)
  l.close()
})

test('a crash that loses records (written, state not updated) recovers to the twin ledger state', async () => {
  const msgs = await lifecycleMessages()
  const quote = msgs[0] as Quote
  const path = newPath()
  // Winds' side: the quote is durable; accept and the IOU are written as records only.
  const winds = DurableLedger.open(path, WINDS)
  winds.ingest(msgs[0]!, T)
  const watermark = (winds.db.query('SELECT watermark FROM econ_state WHERE id = 1').get() as { watermark: number }).watermark
  for (const m of [msgs[1]!, msgs[2]!]) {
    winds.db.run('INSERT INTO econ_instruments (from_key, id, kind, body, now) VALUES (?, ?, ?, ?, ?)', [m.from, m.id, m.kind, encode(m), T])
  }
  // The snapshot still reflects only the quote: the crash happened before it was rewritten.
  expect((winds.db.query('SELECT watermark FROM econ_state WHERE id = 1').get() as { watermark: number }).watermark).toBe(watermark)
  winds.close()

  const recovered = DurableLedger.open(path, WINDS)
  const twin = new Ledger(WINDS)
  for (const m of msgs.slice(0, 3)) twin.ingest(m, T)
  expect(snapshotOf(recovered.ledger, WINDS, quote)).toEqual(snapshotOf(twin, WINDS, quote))
  // The recovered state is usable: the receipt that follows the accept is accepted.
  expect(recovered.ledger.receipt({ from: SUN, id: quote.id })).toBeDefined()
  recovered.close()
})

test('a refused message leaves the stored state and the reopened state exactly as they were', async () => {
  const path = newPath()
  const [quote, accept, receipt, iou] = await lifecycleMessages()
  const sun = DurableLedger.open(path, SUN)
  sun.ingest(quote!, T)
  const before = sun.count()
  // A receipt from a stranger is refused by the ledger; nothing may be written for it.
  const forged = await msg<Receipt>(keys.sun, { kind: 'receipt', quote: quote!.id, spent_tokens: 1 })
  expect(() => sun.ingest(forged, T)).toThrow()
  expect(sun.count()).toBe(before)
  const snapshot = snapshotOf(sun.ledger, SUN, quote as Quote)
  sun.close()
  expect(snapshotOf(DurableLedger.open(path, SUN).ledger, SUN, quote as Quote)).toEqual(snapshot)
  void accept; void receipt; void iou
})

test('a u32-maximum amount survives close and reopen unchanged, with its balance exact', async () => {
  const path = newPath()
  const msgs = await lifecycleMessages(U32_MAX, U32_MAX - 1)
  const quote = msgs[0] as Quote
  const sun = DurableLedger.open(path, SUN)
  for (const m of msgs) sun.ingest(m, T)
  const before = snapshotOf(sun.ledger, SUN, quote)
  sun.close()
  const reopened = DurableLedger.open(path, SUN)
  expect(snapshotOf(reopened.ledger, SUN, quote)).toEqual(before)
  expect(reopened.ledger.owedTo(WINDS, T)).toBe(1)
  reopened.close()
})
