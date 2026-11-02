// Readiness oneshot against a real in-process hub. A fake OpenCode server plays
// the plugin: a directory-scoped request "boots the Location" (binds + streams).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startHub, type HubHandles } from '../../hub/main.ts'
import { VortexClient } from '../../client/client.ts'
import { checkReady, type ReadyOptions } from './ready.ts'

interface Env { hub: HubHandles; cred: { hub: string; token: string; principal: string }; aliceToken: string; stop: () => Promise<void> }

async function setup (): Promise<Env> {
  const st = mkdtempSync(`${tmpdir()}/vx-ready-state-`)
  const cf = mkdtempSync(`${tmpdir()}/vx-ready-config-`)
  process.env.XDG_STATE_HOME = st
  process.env.XDG_CONFIG_HOME = cf
  const hub = await startHub({ cfg: { listen: '127.0.0.1:0' } as any })
  const token = hub.store.createPrincipal('opencode').token
  const aliceToken = hub.store.createPrincipal('alice').token
  return {
    hub, aliceToken,
    cred: { hub: `ws://127.0.0.1:${hub.port}`, token, principal: 'opencode' },
    stop: async () => { await hub.stop(); rmSync(st, { recursive: true, force: true }); rmSync(cf, { recursive: true, force: true }); delete process.env.XDG_STATE_HOME; delete process.env.XDG_CONFIG_HOME },
  }
}

/** Fake OpenCode: the first request for `dir` activates the "plugin" (bind + open stream) when `plugin` is set. */
function fakeOpenCode (env: Env, dir: string, plugin: 'stream' | 'bind-only' | 'none') {
  const client = new VortexClient({ hub: env.cred.hub, token: env.cred.token })
  let ws: WebSocket | undefined
  const seen: string[] = []
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch (req) {
    const u = new URL(req.url)
    seen.push(`${u.pathname}?${u.searchParams.get('directory')}`)
    if (u.pathname === '/api/config' && u.searchParams.get('directory') === dir && ws === undefined && plugin !== 'none') {
      await client.bind('opencode', ['all'])
      if (plugin === 'stream') ws = client.stream('opencode', { onBatch: () => {} }).ws
    }
    return Response.json({ data: [] })
  } })
  return { url: `http://127.0.0.1:${srv.port}`, seen, stop: () => { try { ws?.close() } catch {} ; srv.stop(true) } }
}

const opts = (env: Env, server: string, over: Partial<ReadyOptions> = {}): ReadyOptions =>
  ({ server, directory: '/work/wake', binding: 'opencode', credential: env.cred, timeoutMs: 1500, pollMs: 50, ...over })

test('ready: activation of the exact wake directory opens the stream', async () => {
  const env = await setup()
  const oc = fakeOpenCode(env, '/work/wake', 'stream')
  try {
    const r = await checkReady(opts(env, oc.url))
    assert.equal(r.state, 'ready', r.detail)
    assert.ok(oc.seen.includes('/api/config?/work/wake'), 'activated the exact directory')
  } finally { oc.stop(); await env.stop() }
})

test('never-bound: OpenCode answers but no binding ever appears (fresh setup / inactive plugin)', async () => {
  const env = await setup()
  const oc = fakeOpenCode(env, '/work/wake', 'none')
  try {
    const r = await checkReady(opts(env, oc.url))
    assert.equal(r.state, 'never-bound', r.detail)
  } finally { oc.stop(); await env.stop() }
})

test('offline: a retained binding without a stream queues mail and reports pending', async () => {
  const env = await setup()
  const oc = fakeOpenCode(env, '/work/wake', 'bind-only')
  try {
    await fetch(`${oc.url}/api/config?directory=/work/wake`) // binds, no stream (an earlier plugin run)
    const res = await fetch(`http://127.0.0.1:${env.hub.port}/v1/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${env.aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'dm', to: ['opencode'], text: 'while you were away' }),
    })
    assert.equal(res.status, 200)
    const r = await checkReady(opts(env, oc.url))
    assert.equal(r.state, 'offline', r.detail)
    assert.deepEqual(r.pending, { wake: 1, passive: 0 }, 'offline mail is retained, not lost')
  } finally { oc.stop(); await env.stop() }
})

test('opencode-unreachable: nothing answers the directory-scoped request', async () => {
  const env = await setup()
  try {
    const r = await checkReady(opts(env, 'http://127.0.0.1:9', { timeoutMs: 300 }))
    assert.equal(r.state, 'opencode-unreachable', r.detail)
  } finally { await env.stop() }
})

test('a different directory does not count as activation of the wake Location', async () => {
  const env = await setup()
  const oc = fakeOpenCode(env, '/work/other', 'stream')
  try {
    const r = await checkReady(opts(env, oc.url))
    assert.equal(r.state, 'never-bound', r.detail)
  } finally { oc.stop(); await env.stop() }
})

async function tlsEnv () {
  const root = mkdtempSync(`${tmpdir()}/vx-ready-tls-`)
  const hub = await startHub({ stateDir: `${root}/state`, configDir: `${root}/config`, cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } as any })
  const token = hub.store.createPrincipal('opencode').token
  const oc = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ data: [] }) })
  const good = { hub: `wss://127.0.0.1:${hub.tlsPort}`, token, principal: 'opencode', fingerprint: hub.fingerprint! }
  const client = new VortexClient(good)
  await client.bind('opencode', ['all'])
  let ws: WebSocket | undefined
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pinned stream did not open')), 3000)
    ws = client.stream('opencode', { onBatch: () => {}, onOpen: () => { clearTimeout(t); resolve() } }).ws
  })
  return { hub, oc, good, stop: async () => { try { ws?.close() } catch {} ; oc.stop(true); await hub.stop(); rmSync(root, { recursive: true, force: true }) } }
}

test('TLS: readiness uses the enrolled fingerprint pin like the plugin (correct pin -> ready)', async () => {
  const e = await tlsEnv()
  try {
    const r = await checkReady({ server: `http://127.0.0.1:${e.oc.port}`, directory: '/work/wake', binding: 'opencode', credential: e.good, timeoutMs: 1500, pollMs: 50 })
    assert.equal(r.state, 'ready', r.detail)
  } finally { await e.stop() }
})

test('TLS: a wrong fingerprint pin is never reported ready, even with the stream open', async () => {
  const e = await tlsEnv()
  try {
    const bad = { ...e.good, fingerprint: 'ab'.repeat(32) }
    const r = await checkReady({ server: `http://127.0.0.1:${e.oc.port}`, directory: '/work/wake', binding: 'opencode', credential: bad, timeoutMs: 400, pollMs: 50 })
    assert.notEqual(r.state, 'ready')
    assert.match(r.detail, /TLS pin mismatch/)
  } finally { await e.stop() }
})

test('timeout: only finite whole ms in 1..3600000; NaN/Infinity/0/negative are usage errors', async () => {
  const { parseTimeout } = await import('./ready.ts')
  assert.equal(parseTimeout(undefined), 60_000)
  assert.equal(parseTimeout('1'), 1)
  assert.equal(parseTimeout('3600000'), 3_600_000)
  for (const bad of ['not-a-number', 'NaN', 'Infinity', '0', '-5', '1.5', '1e3', '3600001', '']) assert.equal(typeof parseTimeout(bad), 'string', bad)
  await assert.rejects(checkReady({ server: 'http://127.0.0.1:9', directory: '/w', binding: 'b', credential: { hub: 'ws://127.0.0.1:9', token: 't' }, timeoutMs: Number.NaN }), RangeError)
})

test('timeout: the CLI exits 2 on a malformed timeout before any network request', async () => {
  let requests = 0
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { requests++; return Response.json({ bindings: [] }) } })
  const root = mkdtempSync(`${tmpdir()}/vx-ready-cli-`)
  const file = `${root}/cred.json`
  await Bun.write(file, JSON.stringify({ hub: `ws://127.0.0.1:${srv.port}`, token: 't', principal: 'opencode' }))
  const child = Bun.spawn(['bun', `${import.meta.dir}/ready.ts`, '--directory', '/work/wake', '--server', `http://127.0.0.1:${srv.port}`, '--credential', file, '--timeout-ms', 'not-a-number'], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const code = await Promise.race([child.exited, new Promise<string>(r => setTimeout(() => r('still-running'), 5000))])
    assert.equal(code, 2)
    assert.equal(requests, 0)
  } finally { child.kill(); await child.exited; srv.stop(true); rmSync(root, { recursive: true, force: true }) }
})
