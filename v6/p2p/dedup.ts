// Dedup of signed p2p frames, keyed (from, id), persisted in SQLite so a
// restart does not reopen the replay window (Sun's QA on #8; the same
// pattern as the hub's edge_nonces on #7). Entries expire after twice the
// message skew window: any replayed frame is still inside the stored window.
// The claim is one IMMEDIATE transaction — prune expired rows first, then
// check for reuse, then the cap, then insert — so a full table drains as its
// rows expire and count and claim stay consistent.
import { Database } from 'bun:sqlite'
import { MAX_SKEW_MS } from './message.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS p2p_dedup (
  from_id TEXT NOT NULL,
  id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (from_id, id)
);
CREATE INDEX IF NOT EXISTS p2p_dedup_expires ON p2p_dedup(expires);
`

export class DedupStore {
  private readonly db: Database
  private readonly ttlMs: number
  private readonly cap: number

  constructor (path: string, ttlMs = 2 * MAX_SKEW_MS, cap = 100_000) {
    this.db = new Database(path, { create: true })
    this.db.exec(SCHEMA)
    this.ttlMs = ttlMs
    this.cap = cap
  }

  claim (from: string, id: string, now = Date.now()): 'ok' | 'used' | 'full' {
    return this.db.transaction((): 'ok' | 'used' | 'full' => {
      this.db.prepare('DELETE FROM p2p_dedup WHERE expires <= ?').run(now)
      if (this.db.prepare('SELECT 1 FROM p2p_dedup WHERE from_id = ? AND id = ?').get(from, id) != null) return 'used'
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM p2p_dedup').get() as { n: number }).n >= this.cap) return 'full'
      this.db.prepare('INSERT INTO p2p_dedup (from_id, id, expires) VALUES (?, ?, ?)').run(from, id, now + this.ttlMs)
      return 'ok'
    }).immediate()
  }

  close (): void {
    this.db.close()
  }
}
