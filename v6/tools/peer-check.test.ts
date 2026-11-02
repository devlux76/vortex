// Two-device kit checks against a real pinned TLS hub (pacing off for speed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { VortexClient, type WireApiMessage } from '../client/client.ts'
import { main } from './peer-check.ts'

async function env () {
  const root = mkdtempSync(join(tmpdir(), 'vx-peercheck-'))
  const hub = await startHub({ stateDir: join(root, 'state'), configDir: join(root, 'config'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0', wakeCoalesceMs: 0, wakeMinIntervalMs: 0 } as any })
  const mk = (p: string) => ({ principal: p, token: hub.store.createPrincipal(p).token, hub: `wss://127.0.0.1:${hub.tlsPort}`, fingerprint: hub.fingerprint! })
  const a = mk('dev-a'); const b = mk('dev-b')
  const aFile = join(root, 'a.json'); writeFileSync(aFile, JSON.stringify(a), { mode: 0o600 })
  const bFile = join(root, 'b.json'); writeFileSync(bFile, JSON.stringify(b), { mode: 0o600 })
  return { root, hub, a, b, aFile, bFile, stop: async () => { await hub.stop(); rmSync(root, { recursive: true, force: true }) } }
}

/** A misbehaving peer: answers PINGs with a chosen policy. */
async function rogue (cred: { principal: string; token: string; hub: string; fingerprint: string }, reply: (m: WireApiMessage, nonce: string) => Parameters<VortexClient['send']>[0]) {
  const c = new VortexClient(cred)
  await c.bind('rogue', ['all'])
  let ws!: WebSocket
  await new Promise<void>(resolve => {
    ws = c.stream('rogue', {
      onOpen: resolve,
      onBatch: (batch, _w, msgs) => {
        c.delivered(ws, batch, 'transport-written')
        for (const m of msgs) { const x = /^vx-peer-check PING (\S+)/.exec(m.text); if (x) void c.send(reply(m, x[1])) }
      },
    }).ws
  })
  return () => ws.close()
}

const initiate = (e: Awaited<ReturnType<typeof env>>, out: string) =>
  main(['--credential', e.aFile, '--role', 'initiate', '--peer', 'dev-b', '--rounds', '2', '--timeout-ms', '6000', '--out', out])

test('correct peer: both rounds valid, actual reply scope/recipients/reply_to recorded', async () => {
  const e = await env()
  try {
    const responder = main(['--credential', e.bFile, '--role', 'respond', '--peer', 'dev-a', '--timeout-ms', '15000', '--out', join(e.root, 'b.ev')])
    await new Promise(r => setTimeout(r, 300))
    const code = await initiate(e, join(e.root, 'a.ev'))
    assert.equal(code, 0)
    assert.equal(await responder, 0)
    const ev = JSON.parse(readFileSync(join(e.root, 'a.ev'), 'utf8'))
    assert.deepEqual(ev.rounds.map((r: any) => [r.scope, r.replyScope, r.valid, r.replyTo === r.sentId]), [['room', 'room', true, true], ['dm', 'dm', true, true]])
    assert.deepEqual(ev.rounds[1].replyRecipients, ['dev-a'])
  } finally { await e.stop() }
})

test('wrong-scope PONGs (room<->dm swapped, no reply_to) fail and record what came back', async () => {
  const e = await env()
  const stop = await rogue(e.b, (m, n) => m.scope === 'dm'
    ? { scope: 'room', room: 'all', to: ['dev-a'], text: `vx-peer-check PONG ${n} host=x` }
    : { scope: 'dm', to: ['dev-a'], text: `vx-peer-check PONG ${n} host=x` })
  try {
    assert.equal(await initiate(e, join(e.root, 'a.ev')), 1)
    const ev = JSON.parse(readFileSync(join(e.root, 'a.ev'), 'utf8'))
    assert.equal(ev.ok, false)
    assert.equal(ev.rounds[0].replyScope, 'dm', 'actual scope recorded, not the requested one')
    assert.equal(ev.rounds[0].valid, false)
  } finally { stop(); await e.stop() }
})

test('right scope but missing reply_to fails', async () => {
  const e = await env()
  const stop = await rogue(e.b, (m, n) => m.scope === 'dm'
    ? { scope: 'dm', to: ['dev-a'], text: `vx-peer-check PONG ${n} host=x` }
    : { scope: 'room', room: 'all', to: ['dev-a'], text: `vx-peer-check PONG ${n} host=x` })
  try {
    assert.equal(await initiate(e, join(e.root, 'a.ev')), 1)
    const ev = JSON.parse(readFileSync(join(e.root, 'a.ev'), 'utf8'))
    assert.match(ev.rounds[0].invalid, /reply_to/)
  } finally { stop(); await e.stop() }
})

test('device-hub: same --dir on a new port refreshes the endpoint, keeps principal and token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-devhub-'))
  const boot = async () => {
    const p = Bun.spawn(['bun', `${import.meta.dir}/device-hub.ts`, '--dir', dir, '--tls', '127.0.0.1:0'], { stdout: 'pipe', stderr: 'pipe' })
    const rd = p.stderr.getReader(); let log = ''
    while (!log.includes('credentials in')) { const { done, value } = await rd.read(); if (done) throw new Error(log); log += new TextDecoder().decode(value) }
    const actual = /device-hub: TLS (wss:\/\/\S+)/.exec(log)![1]
    const cred = JSON.parse(readFileSync(join(dir, 'dev-a.json'), 'utf8'))
    p.kill(); await p.exited
    return { actual, cred }
  }
  try {
    const first = await boot(); const second = await boot()
    assert.equal(second.cred.hub, second.actual, 'credential follows the live listener')
    assert.equal(second.cred.token, first.cred.token)
    assert.equal(second.cred.principal, 'dev-a')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
