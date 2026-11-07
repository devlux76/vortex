// Release-audit regressions, second pass (Claude standing in for Codex,
// 2026-11-06, audit issue vortex:3ab7f40 / review vortex:cda6b71). Each test
// was RED on v6-impl cf21102 before its fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { HubStore, type StoredMessage } from './store.ts'
import { Delivery, type ServerFrame, type SocketLike } from './delivery.ts'
import { DEFAULT_CONFIG, type HubConfig } from './config.ts'

function withStore (over: Partial<HubConfig>, fn: (s: HubStore, cfg: HubConfig) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(`${tmpdir()}/vortex-audit2-`)
    const cfg = { ...DEFAULT_CONFIG, ...over }
    const s = new HubStore(`${dir}/hub.db`, cfg)
    try { await fn(s, cfg) } finally { s.close(); rmSync(dir, { recursive: true, force: true }) }
  }
}

function socket (): SocketLike & { frames: ServerFrame[] } {
  const frames: ServerFrame[] = []
  return { frames, send: f => { frames.push(f) }, close: () => {} }
}

const dm = (s: HubStore, from: string, to: string, text: string): StoredMessage =>
  s.insertMessage({ from, to: [to], scope: 'dm', text, human: false })

test('F8: a pull whose outstanding passive batch lost all its messages is still answered', withStore({}, (s, cfg) => {
  s.setBinding('bob', 'main', ['all'])
  const d = new Delivery(s, cfg)
  try {
    const sock = socket()
    d.attach(sock, 'bob', 'main')
    // Its rows were dropped by pending overflow and then pruned by retention.
    s.insertBatchRow({ id: 'batch-empty', principal: 'bob', binding: 'main', kind: 'passive', msgIds: ['01GONEGONEGONEGONEGONEGONE'], notices: [] })
    d.handlePull(sock, 'bob', 'main')
    assert.ok(sock.frames.some(f => f.type === 'empty' || f.type === 'batch'), 'the hook waits for its pull timeout and a fault is reported instead')
  } finally { d.stop() }
}))

test('F8: a retried wake batch whose messages are gone frees the slot for waiting wake rows', withStore({ batchRetryMs: 20, wakeCoalesceMs: 0, wakeMinIntervalMs: 0 }, async (s, cfg) => {
  s.setBinding('bob', 'main', ['all'])
  const d = new Delivery(s, cfg)
  try {
    const sock = socket()
    d.attach(sock, 'bob', 'main')
    const first = dm(s, 'alice', 'bob', 'first')
    s.enqueuePending('bob', 'main', first, 'wake')
    d.attemptWakePush('bob', 'main')
    const pushed = sock.frames.find(f => f.type === 'batch')
    assert.ok(pushed !== undefined && pushed.type === 'batch', 'precondition: first wake batch pushed, retry timer armed')
    // Its row is dropped by pending overflow and the message pruned by retention.
    s.db.prepare('DELETE FROM pending WHERE msg_id = ?').run(first.id)
    s.db.prepare('DELETE FROM messages WHERE id = ?').run(first.id)
    const second = dm(s, 'alice', 'bob', 'waiting behind the empty batch')
    s.enqueuePending('bob', 'main', second, 'wake') // direct enqueue: no coalesce timer, no new event
    await Bun.sleep(80) // the retry timer finds the batch empty and deletes it
    const later = sock.frames.filter(f => f.type === 'batch' && f.messages.some(x => x.id === second.id))
    assert.ok(later.length > 0, 'the waiting wake row goes out once the empty batch is gone')
    assert.equal(new Set(later.map(f => f.type === 'batch' ? f.batch : '')).size, 1, 'in one batch (retries reuse its id)')
  } finally { d.stop() }
}))
