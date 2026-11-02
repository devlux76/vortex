// Release-audit regressions (Claude + Codex cross-review, 2026-11-02, audit
// issue vortex:3ab7f40). Each test reproduces a finding against the store and
// delivery engine directly: f9da54e (retention scope and count), 4f65a54 (retry
// timer after restart), 47d23e9 (stale or late `failed` frames).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { HubStore, type StoredMessage } from './store.ts'
import { Delivery, type ServerFrame, type SocketLike } from './delivery.ts'
import { DEFAULT_CONFIG, type HubConfig } from './config.ts'

function withStore (over: Partial<HubConfig>, fn: (s: HubStore, cfg: HubConfig) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(`${tmpdir()}/vortex-audit-`)
    const cfg = { ...DEFAULT_CONFIG, ...over }
    const s = new HubStore(`${dir}/hub.db`, cfg)
    try { await fn(s, cfg) } finally { s.close(); rmSync(dir, { recursive: true, force: true }) }
  }
}

const dm = (s: HubStore, from: string, to: string, text: string): StoredMessage =>
  s.insertMessage({ from, to: [to], scope: 'dm', text, human: false })
const post = (s: HubStore, from: string, room: string, text: string): StoredMessage =>
  s.insertMessage({ from, to: [], scope: 'room', room, text, human: false })

function socket (): SocketLike & { frames: ServerFrame[]; closes: number[] } {
  const frames: ServerFrame[] = []
  const closes: number[] = []
  return { frames, closes, send: f => { frames.push(f) }, close: code => { closes.push(code) } }
}

test('f9da54e: DM count retention is per unordered pair and keeps exactly dmMaxMessages', withStore({ dmMaxMessages: 2 }, s => {
  const unrelated = dm(s, 'carol', 'dave', 'unrelated recent DM')
  const pair = [dm(s, 'alice', 'bob', 'a1'), dm(s, 'bob', 'alice', 'b1'), dm(s, 'alice', 'bob', 'a2')]
  assert.ok(s.getMessage(unrelated.id), 'another pair\'s DM survives')
  assert.equal(s.getMessage(pair[0].id), undefined, 'oldest of the pair pruned')
  assert.deepEqual(s.dmLog('alice', 0, 100).map(m => m.text), ['b1', 'a2'], 'exactly 2 kept, both directions count as one conversation')
  // A third principal's own DMs with alice are a different pair.
  const other = dm(s, 'erin', 'alice', 'e1')
  dm(s, 'alice', 'bob', 'a3')
  assert.ok(s.getMessage(other.id), 'erin->alice is not alice<->bob')
}))

test('f9da54e: DM retention never prunes a pending DM', withStore({ dmMaxMessages: 1 }, s => {
  s.setBinding('bob', 'main', ['all'])
  const first = dm(s, 'alice', 'bob', 'still pending')
  s.enqueuePending('bob', 'main', first, 'wake')
  dm(s, 'alice', 'bob', 'second')
  assert.ok(s.getMessage(first.id))
}))

test('f9da54e: room count retention keeps exactly roomMaxMessages', withStore({ roomMaxMessages: 3 }, s => {
  for (let i = 1; i <= 5; i++) post(s, 'alice', 'all', `m${i}`)
  const other = post(s, 'alice', 'ops', 'other room')
  assert.deepEqual(s.roomLog('all', 0, 100).map(m => m.text), ['m3', 'm4', 'm5'])
  assert.ok(s.getMessage(other.id))
}))

test('4f65a54: an outstanding batch replayed after a hub restart keeps retrying', withStore({ batchRetryMs: 20 }, async (s, cfg) => {
  s.setBinding('bob', 'main', ['all'])
  const m = dm(s, 'alice', 'bob', 'pending across restart')
  s.enqueuePending('bob', 'main', m, 'wake')
  s.insertBatchRow({ id: 'batch-restart', principal: 'bob', binding: 'main', kind: 'wake', msgIds: [m.id], notices: [] })
  const d = new Delivery(s, cfg) // a fresh engine: no in-memory retry timers survive
  try {
    d.start()
    const sock = socket()
    d.attach(sock, 'bob', 'main')
    await Bun.sleep(90)
    const replays = sock.frames.filter(f => f.type === 'batch' && f.batch === 'batch-restart').length
    assert.ok(replays >= 2, `replayed ${replays} time(s); the retry timer must be re-armed on attach`)
  } finally { d.stop() }
}))

test('47d23e9: a failed frame from a released socket cannot reopen a delivered batch', withStore({}, (s, cfg) => {
  s.setBinding('bob', 'main', ['all'])
  const m = dm(s, 'alice', 'bob', 'x')
  s.enqueuePending('bob', 'main', m, 'wake')
  s.insertBatchRow({ id: 'batch-stale', principal: 'bob', binding: 'main', kind: 'wake', msgIds: [m.id], notices: [] })
  const d = new Delivery(s, cfg)
  try {
    const old = socket()
    d.attach(old, 'bob', 'main')
    d.release('bob', 'main')
    const next = socket()
    d.attach(next, 'bob', 'main')
    assert.equal(d.handleDelivered(next, 'bob', 'main', 'batch-stale', 'host-accepted'), true)
    d.handleFailed(old, 'bob', 'main', 'batch-stale', 'late error from the old owner')
    assert.equal(s.getBatch('batch-stale')?.status, 'delivered')
    assert.equal(s.outstandingBatch('bob', 'main', 'wake'), undefined, 'no outstanding batch is resurrected')
    assert.equal(d.lastError('bob', 'main'), undefined, 'a stale socket cannot set lastError')
    assert.ok(old.frames.some(f => f.type === 'error'), 'the stale socket is told')
  } finally { d.stop() }
}))

test('47d23e9: a late failed frame from the current owner cannot reopen a delivered batch', withStore({}, (s, cfg) => {
  s.setBinding('bob', 'main', ['all'])
  const m = dm(s, 'alice', 'bob', 'y')
  s.enqueuePending('bob', 'main', m, 'wake')
  s.insertBatchRow({ id: 'batch-late', principal: 'bob', binding: 'main', kind: 'wake', msgIds: [m.id], notices: [] })
  const d = new Delivery(s, cfg)
  try {
    const sock = socket()
    d.attach(sock, 'bob', 'main')
    d.handleDelivered(sock, 'bob', 'main', 'batch-late', 'host-accepted')
    d.handleFailed(sock, 'bob', 'main', 'batch-late', 'late')
    assert.equal(s.getBatch('batch-late')?.status, 'delivered')
    assert.equal(s.outstandingBatch('bob', 'main', 'wake'), undefined)
  } finally { d.stop() }
}))

// ---- Claude findings, self-confirmed RED on ace2dde before the fix ----

import { logLine, recentLine, type WireMessage } from '../client/render.ts'
import { loadHubConfig } from './config.ts'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'

const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/

test('F14: human listings never pass terminal control from peer text', () => {
  const evil = 'hi \u001b]52;c;cHduZWQ=\u0007 \u001b[2J\u001b[8m hidden \u009b31m \u007f ‮gnirts'
  const m: WireMessage = { id: '01ABCDEFGHJKMNPQRSTVWXYZ01', seq: 1, ts: 0, from: 'peer', scope: 'room', room: 'all', to: [], text: evil, human: false }
  for (const line of [logLine(m), recentLine(m)]) {
    assert.ok(!CONTROL.test(line), `raw control character in ${JSON.stringify(line)}`)
    assert.ok(line.includes('\\x1b]52;c;'), 'escape shown visibly, not dropped')
    assert.ok(line.includes('\\u202e'))
  }
})

test('F4: hub.json rejects wrong types, out-of-range numbers and unknown keys', async () => {
  const dir = mkdtempSync(`${tmpdir()}/vortex-hubcfg-`)
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  mkdirSync(`${dir}/vortex`)
  const load = (v: unknown) => { writeFileSync(`${dir}/vortex/hub.json`, JSON.stringify(v)); return loadHubConfig() }
  try {
    const bad: unknown[] = [
      { wakeMinIntervalMs: '10000' }, { wakeHourlyLimit: 0 }, { wakeHourlyLimit: -1 }, { batchMaxMessages: 1.5 },
      { sendPerMinute: null }, { nope: 1 }, { tls: { lsten: ':7901' } }, { tls: { listen: 7901 } }, { tls: 'x' },
      { listen: 7900 }, { listen: 'host:notaport' }, [], null,
    ]
    for (const b of bad) await assert.rejects(load(b), `accepted ${JSON.stringify(b)}`)
    const ok = await load({ listen: '127.0.0.1:7900', wakeMinIntervalMs: 0, wakeCoalesceMs: 0, wakeHourlyLimit: 90, tls: { listen: ':7901' } })
    assert.equal(ok.wakeHourlyLimit, 90)
    assert.equal(ok.wakeMinIntervalMs, 0)
    assert.equal(ok.tlsListen, ':7901')
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F27: the Codex hook command finds the plugin root by substitution, PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT', async () => {
  const hooks = JSON.parse(readFileSync(new URL('../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8')).hooks
  const command: string = hooks.UserPromptSubmit[0].hooks[0].command
  const root = mkdtempSync(`${tmpdir()}/vortex-hookroot-`)
  try {
    mkdirSync(`${root}/dist`)
    writeFileSync(`${root}/dist/vx.js`, 'console.log("reached " + process.argv.slice(2).join(" "))')
    const run = async (cmd: string, env: Record<string, string>) => {
      const base = { ...process.env } as Record<string, string>
      delete base.PLUGIN_ROOT; delete base.CLAUDE_PLUGIN_ROOT
      const p = Bun.spawn(['sh', '-c', cmd], { env: { ...base, ...env }, stdout: 'pipe', stderr: 'pipe' })
      return (await new Response(p.stdout).text()).trim()
    }
    const want = 'reached hook context --host codex'
    assert.equal(await run(command.split('${PLUGIN_ROOT}').join(root), {}), want, 'host substitutes ${PLUGIN_ROOT} textually')
    assert.equal(await run(command, { PLUGIN_ROOT: root }), want, 'host exports PLUGIN_ROOT')
    assert.equal(await run(command, { CLAUDE_PLUGIN_ROOT: root }), want, 'host exports only CLAUDE_PLUGIN_ROOT')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
