// Hub pending queues, delivery batch rows, and the row mapper they share.
// Plain functions over a HubStore (s.db, s.cfg, and its public methods);
// HubStore's methods of the same names delegate here (store.ts).
import { ulid } from '../client/ulid.ts'
import type { HubStore } from './store.ts'
import type { StoredMessage, BatchRow } from './store-schema.ts'
import { utf8Count, convKeyOf } from './store-schema.ts'

export function rowToStoredMessage (row: any): StoredMessage {
  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    scope: row.scope,
    room: row.room === null ? undefined : row.room,
    to: JSON.parse(row.to_json),
    from: row.fromp,
    text: row.text,
    reply_to: row.reply_to === null ? undefined : row.reply_to,
    human: row.human === 1,
    reply_author: row.reply_author === null ? undefined : row.reply_author,
    reply_ts: row.reply_ts === null ? undefined : row.reply_ts,
  }
}

// ------------------------------------------------------------------
// pending queues (per binding, wake and passive; §8.4)
// ------------------------------------------------------------------

export function enqueuePending (s: HubStore, principal: string, binding: string, m: StoredMessage, kind: 'wake' | 'passive'):
  { overflowDropped: number; nowOverBoundary: boolean } {
  let dropped = 0
  let nowOverBoundary = false
  const bytes = utf8Count(m.text)
  s.db.transaction(() => {
    s.db.prepare(
      `INSERT INTO pending (binding_principal, binding_name, msg_id, kind, enqueued, message_bytes, conv)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(principal, binding, m.id, kind, ulid(Date.now()), bytes, convKeyOf(m))
    const stats = s.pendingStats(principal, binding)
    while (stats.count > s.cfg.pendingMaxMessages || stats.bytes > s.cfg.pendingMaxBytes) {
      const oldest = s.db.prepare(
        `SELECT msg_id FROM pending WHERE binding_principal = ? AND binding_name = ? ORDER BY rowid LIMIT 1`,
      ).get(principal, binding) as any
      if (oldest === undefined) break
      s.db.prepare('DELETE FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id = ?').run(principal, binding, oldest.msg_id)
      const row = s.pendingStats(principal, binding)
      stats.count = row.count
      stats.bytes = row.bytes
      dropped++
    }
    if (dropped > 0) {
      // Expire notice rides the next batch for this binding (§8.4), persisted.
      s.db.prepare('UPDATE bindings SET expired_pending = expired_pending + ? WHERE principal = ? AND name = ?').run(dropped, principal, binding)
      nowOverBoundary = true
    }
  })()
  return { overflowDropped: dropped, nowOverBoundary }
}

export function pendingStats (s: HubStore, principal: string, binding: string): { count: number; bytes: number } {
  const row = s.db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(message_bytes), 0) AS b FROM pending WHERE binding_principal = ? AND binding_name = ?`,
  ).get(principal, binding) as any
  return { count: row.c, bytes: row.b }
}

export function pendingCountByKind (s: HubStore, principal: string, binding: string): { wake: number; passive: number } {
  const rows = s.db.prepare(
    `SELECT kind, COUNT(*) AS c FROM pending WHERE binding_principal = ? AND binding_name = ? GROUP BY kind`,
  ).all(principal, binding) as any[]
  const out = { wake: 0, passive: 0 }
  for (const r of rows) (out as any)[r.kind] = r.c
  return out
}

export function pendingMessages (s: HubStore, principal: string, binding: string, kind: 'wake' | 'passive'): StoredMessage[] {
  const rows = s.db.prepare(
    `SELECT m.* FROM pending p JOIN messages m ON m.id = p.msg_id
     WHERE p.binding_principal = ? AND p.binding_name = ? AND p.kind = ?
     ORDER BY p.rowid`,
  ).all(principal, binding, kind) as any[]
  return rows.map(r => rowToStoredMessage(r))
}

export function deletePending (s: HubStore, principal: string, binding: string, ids: string[]): void {
  const stmt = s.db.prepare('DELETE FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id = ?')
  for (const id of ids) stmt.run(principal, binding, id)
}

export function consumeExpiredNotice (s: HubStore, principal: string, binding: string): number {
  const b = s.getBinding(principal, binding)
  if (b === undefined) return 0
  const n = b.expiredPending
  if (n > 0) s.db.prepare('UPDATE bindings SET expired_pending = 0 WHERE principal = ? AND name = ?').run(principal, binding)
  return n
}

// ------------------------------------------------------------------
// deliveries (batch records; id stable across retries §8.4)
// ------------------------------------------------------------------

export function insertBatchRow (s: HubStore, b: { id: string; principal: string; binding: string; kind: 'wake' | 'passive'; msgIds: string[]; notices: string[] }): void {
  s.db.prepare(
    `INSERT INTO deliveries (id, binding_principal, binding_name, kind, status, msg_ids, notices, created)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(b.id, b.principal, b.binding, b.kind, JSON.stringify(b.msgIds), JSON.stringify(b.notices), Date.now())
}

export function getBatch (s: HubStore, id: string): BatchRow | undefined {
  const row = s.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as any
  if (row == null) return undefined
  return {
    id: row.id, principal: row.binding_principal, binding: row.binding_name,
    kind: row.kind, status: row.status, error: row.error === null ? undefined : row.error,
    msgIds: JSON.parse(row.msg_ids), notices: JSON.parse(row.notices), created: row.created,
  }
}

export function outstandingBatch (s: HubStore, principal: string, binding: string, kind: 'wake' | 'passive'): BatchRow | undefined {
  // At most one outstanding batch of each kind (§8.4): newest pending/failed row.
  const row = s.db.prepare(
    `SELECT * FROM deliveries WHERE binding_principal = ? AND binding_name = ? AND kind = ? AND status IN ('pending','failed')
     ORDER BY created DESC, id DESC LIMIT 1`,
  ).get(principal, binding, kind) as any
  if (!row) return undefined
  return { id: row.id, principal: row.binding_principal, binding: row.binding_name, kind: row.kind, status: row.status, error: row.error === null ? undefined : row.error, msgIds: JSON.parse(row.msg_ids), notices: JSON.parse(row.notices), created: row.created }
}

export function outstandingBatchesOf (s: HubStore, principal: string, binding: string): BatchRow[] {
  const wake = s.outstandingBatch(principal, binding, 'wake')
  const passive = s.outstandingBatch(principal, binding, 'passive')
  return [wake, passive].filter((x): x is BatchRow => x !== undefined)
}

export function deliverBatch (s: HubStore, id: string, evidence: string): void {
  s.db.transaction(() => {
    const row = s.getBatch(id)
    if (row != null) {
      const convs = new Set((s.db.prepare(`SELECT DISTINCT conv FROM pending WHERE binding_principal = ? AND binding_name = ? AND msg_id IN (${row.msgIds.map(() => '?').join(',') || "''"})`)
        .all(row.principal, row.binding, ...row.msgIds) as any[]).map(r => r.conv as string))
      s.deletePending(row.principal, row.binding, row.msgIds)
      const now = Date.now()
      for (const c of convs) if (c !== null && !s.hasWakeWork(c)) s.db.prepare('UPDATE conversations SET last_drain_ts = ? WHERE conv = ?').run(now, c)
      s.db.prepare(
        `UPDATE deliveries SET status = 'delivered', evidence = ? WHERE id = ?`,
      ).run(evidence, id)
      // Keep the newest delivered row per binding for status display; prune the rest.
      s.db.prepare(
        `DELETE FROM deliveries
         WHERE binding_principal = ? AND binding_name = ? AND status = 'delivered' AND id != ?`,
      ).run(row.principal, row.binding, id)
    }
  })()
}

export function markBatchFailed (s: HubStore, id: string, error: string): void {
  s.db.prepare(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`).run(error, id)
}

export function keepBatchPending (s: HubStore, id: string): void {
  s.db.prepare(`UPDATE deliveries SET status = 'pending', error = NULL WHERE id = ?`).run(id)
}

export function deleteBatchRow (s: HubStore, id: string): void {
  s.db.prepare('DELETE FROM deliveries WHERE id = ?').run(id)
}
