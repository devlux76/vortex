// Seen relayed envelopes (mesh→hub, #20): dedup on (origin principal,
// envelope id), persisted in SQLite so a replayed relay is handled once even
// after a restart. The claim statements run WITHOUT a transaction of their
// own: the hub's relay route calls this inside its `store.atomic`, so the
// claim commits together with the accepted message (Sun's QA on #37 — a
// refused relay must claim nothing, and a retry must be retried).
import { Database } from 'bun:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_seen (
  principal TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (principal, msg_id)
);
CREATE INDEX IF NOT EXISTS relay_seen_expires ON relay_seen(expires);
`

export class RelaySeen {
  private readonly db: Database
  private readonly ttlMs: number
  private readonly cap: number

  constructor (db: Database, ttlMs = 10 * 60_000, cap = 100_000) {
    this.db = db
    this.db.exec(SCHEMA)
    this.ttlMs = ttlMs
    this.cap = cap
  }

  /** Prune expired, then claim: 'used' | 'full' | 'ok'. Caller wraps in a transaction. */
  claim (principal: string, msgId: string, now = Date.now()): 'ok' | 'used' | 'full' {
    this.db.prepare('DELETE FROM relay_seen WHERE expires <= ?').run(now)
    if (this.db.prepare('SELECT 1 FROM relay_seen WHERE principal = ? AND msg_id = ?').get(principal, msgId) != null) return 'used'
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM relay_seen').get() as { n: number }).n >= this.cap) return 'full'
    this.db.prepare('INSERT INTO relay_seen (principal, msg_id, expires) VALUES (?, ?, ?)').run(principal, msgId, now + this.ttlMs)
    return 'ok'
  }
}
