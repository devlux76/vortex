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
