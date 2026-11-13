// A8 §10: the durable ledger (#73). A settlement that is lost is a payment
// that is lost, so what a collector holds, owes and has honoured survives the
// process: every ingested instrument is written to SQLite, and the derived
// state needed to answer "what do I owe, what am I owed" is kept beside it.
//
// Shape: an append-only `econ_instruments` log keyed by the ledger's dedup
// key `(from_key, id)` — the same instrument stored twice is one row — and a
// one-row `econ_state` snapshot of `Ledger.toJSON()` with a **watermark**: the
// seq of the last instrument the snapshot reflects. Loading is therefore
// idempotent by construction: open the snapshot, then replay every stored
// instrument past the watermark through `Ledger.ingest` in seq order. A crash
// between "record written" and "state updated" (record present, snapshot
// stale) recovers on reopen, because the unreflected instruments are replayed
// exactly once; a duplicate instrument in the log is skipped by the same
// dedup the ledger applies to live traffic, so loading never throws on one.
//
// The wrap is deliberately thin: `Ledger` keeps its whole API (views,
// balances, peers) and this class owns only durability — the atomic
// record-plus-state write and the replay.
//
// **Amounts are not frozen here.** They exist only inside the canonical
// instrument text A8's encoder produces; this layer parses no amount field
// and stores no amount column, so the unit, width and field names (#100:
// whole kilotokens, 1..MAXINT, unsigned, zero banned) are expected to land in
// `v6/econ/iou.ts` with no edit — or at most a one-line edit — here, plus a
// migration note for ledgers written before the change. The acceptance tests
// carry an amount at the u32 boundary to prove this layer constrains no
// amount domain of its own.

import { Database } from 'bun:sqlite'
import { encode, type EconMessage } from './iou.ts'
import { Ledger, type IngestResult } from './ledger.ts'

export class DurableLedgerError extends Error {}

export class DurableLedger {
  readonly ledger: Ledger
  /** Exposed for tooling and tests; writes outside ingest() are recovered from on the next open. */
  readonly db: Database

  private constructor (db: Database, ledger: Ledger) {
    this.db = db
    this.ledger = ledger
  }

  /**
   * Opens (or creates) a durable ledger at `dbPath` for `self`: creates the
   * tables if needed, loads the snapshot, and replays every stored instrument
   * past its watermark in seq order. Loading a state file that contains a
   * duplicate instrument is clean: the dedup in `Ledger.ingest` skips it.
   */
  static open (dbPath: string, self: string): DurableLedger {
    const db = new Database(dbPath, { create: true })
    let ledger!: Ledger
    try {
      db.run('CREATE TABLE IF NOT EXISTS econ_instruments (seq INTEGER PRIMARY KEY AUTOINCREMENT, from_key TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, now INTEGER NOT NULL, UNIQUE (from_key, id))')
      db.run('CREATE TABLE IF NOT EXISTS econ_state (id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'\')')
      db.run('CREATE TABLE IF NOT EXISTS econ_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
      // The owner is recorded independently of the snapshot, so a file is
      // never adopted by the wrong self — with or without records in it.
      const owner = (db.query('SELECT v FROM econ_meta WHERE k = \'owner\'').get() as { v: string } | null)?.v
      if (owner !== undefined && owner !== self) throw new DurableLedgerError(`this ledger belongs to ${owner}, not ${self}`)
      if (owner === undefined) db.run('INSERT INTO econ_meta (k, v) VALUES (\'owner\', ?)', [self])
      const row = db.query('SELECT watermark, state FROM econ_state WHERE id = 1').get() as { watermark: number, state: string } | null
      ledger = row !== null && row.state !== '' ? Ledger.fromJSON(JSON.parse(row.state)) : new Ledger(self)
      if (ledger.self !== self) throw new DurableLedgerError(`this ledger belongs to ${ledger.self}, not ${self}`)
      // Replay every instrument the snapshot does not yet reflect, in seq
      // order, with the clock the original ingest used — stored per record,
      // because a replay must reproduce the original decision exactly (an
      // expiry decision made against the live clock is otherwise not
      // reconstructible from the instrument alone).
      const replay = db.query('SELECT seq, body, now FROM econ_instruments WHERE seq > ? ORDER BY seq').all(row?.watermark ?? 0) as Array<{ seq: number, body: string, now: number }>
      for (const { body, now } of replay) ledger.ingest(decodeStored(body), now)
      if (replay.length > 0) {
        db.run('BEGIN IMMEDIATE')
        try {
          db.run('INSERT INTO econ_state (id, watermark, state) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET watermark = excluded.watermark, state = excluded.state', [replay[replay.length - 1]!.seq, JSON.stringify(ledger.toJSON())])
          db.run('COMMIT')
        } catch (e) {
          try { db.run('ROLLBACK') } catch { /* no transaction open */ }
          throw e
        }
      }
    } catch (e) {
      db.close()
      throw e
    }
    return new DurableLedger(db, ledger)
  }

  /**
   * Applies one verified message durably, atomically: the instrument record
   * and the snapshot are written in one transaction, so a crash leaves either
   * neither or a stale snapshot — and a stale snapshot is replayed forward on
   * the next open. A message the ledger refuses is written nowhere.
   */
  ingest (m: EconMessage, now: number): IngestResult {
    if (typeof m.id !== 'string' || typeof m.from !== 'string' || m.id === '' || m.from === '') {
      throw new DurableLedgerError('an econ message carries non-empty from and id')
    }
    const body = encode(m)
    this.db.run('BEGIN IMMEDIATE')
    try {
      const dup = this.db.query('SELECT 1 FROM econ_instruments WHERE from_key = ? AND id = ?').get(m.from, m.id)
      if (dup !== null) {
        this.db.run('COMMIT')
        return { applied: false, duplicate: true }
      }
      const result = this.ledger.ingest(m, now)
      this.db.run('INSERT INTO econ_instruments (from_key, id, kind, body, now) VALUES (?, ?, ?, ?, ?)', [m.from, m.id, m.kind, body, now])
      const seq = (this.db.query('SELECT MAX(seq) AS s FROM econ_instruments').get() as { s: number | null }).s ?? 0
      this.db.run('INSERT INTO econ_state (id, watermark, state) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET watermark = excluded.watermark, state = excluded.state', [seq, JSON.stringify(this.ledger.toJSON())])
      this.db.run('COMMIT')
      return result
    } catch (e) {
      try { this.db.run('ROLLBACK') } catch { /* no transaction open */ }
      throw e
    }
  }

  /** Number of instruments stored (the log's length; duplicates collapsed). */
  count (): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM econ_instruments').get() as { n: number }).n
  }

  close (): void {
    this.db.close()
  }
}

/** Decodes a stored instrument: canonical JSON text, byte-checked by re-encoding. */
function decodeStored (body: string): EconMessage {
  let m: EconMessage
  try {
    m = JSON.parse(body) as EconMessage
  } catch (e) {
    throw new DurableLedgerError(`stored instrument is not JSON: ${(e as Error).message}`)
  }
  let again: string
  try {
    again = encode(m)
  } catch (e) {
    throw new DurableLedgerError(`stored instrument does not re-encode: ${(e as Error).message}`)
  }
  if (again !== body) throw new DurableLedgerError('stored instrument is not canonical')
  return m
}
