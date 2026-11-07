// Claude Code plugin tests (§8.11): real hub in-process, real server.ts and
// `vx hook context` subprocesses, loopback + temp dirs only.
// F13 hub-connection and hook-isolation tests (split from claude.test.ts; shared setup in testkit.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { startHub } from '../../hub/main.ts'
import { VortexClient } from '../../client/client.ts'
import { FIXED_PEER_DATA_LINE, parseBatch } from '../../client/render.ts'
import { Bridge, INSTRUCTIONS } from './bridge.ts'
import { TOOL } from './server.ts'
import { READ_TOOL } from '../../client/read.ts'
import { hookFromHost, hookOrigin } from '../../client/hooksocket.ts'
import {
  ROOT,
  SERVER,
  VX,
  sleep,
  until,
  type Env,
  setup,
  McpServer,
  evidenceOf,
  runHook,
  ready
} from './testkit.ts'

// ---- F13: the hub connection never blocks or kills the plugin --------------

function freePort (): number {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data () {} } })
  const port = l.port
  l.stop(true)
  return port
}

test('F13: hub down when the plugin starts: MCP answers at once, then a new binding binds and streams when the hub comes up', { timeout: 40000 }, async () => {
  const env = await setup()
  const stateDir = env.newDir()
  const configDir = env.newDir()
  const cfg = { sendPerMinute: 1000, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100 }
  let late: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    const port = freePort()
    const first = await startHub({ stateDir, configDir, cfg: { ...cfg, listen: `127.0.0.1:${port}` } })
    const token = first.store.createPrincipal('claude').token
    await first.stop()
    const credFile = `${env.newDir()}/claude-late.json`
    writeFileSync(credFile, JSON.stringify({ hub: `ws://127.0.0.1:${port}`, token, rooms: ['all'] }))
    const s = new McpServer({ ...env, claudeCredFile: credFile }, { binding: 'late' })
    const t0 = Date.now()
    const init = await s.handshake()
    assert.equal(init.serverInfo.name, 'vortex')
    assert.ok(Date.now() - t0 < 3000, 'initialize is not held behind the hub connection')
    const down = await s.call({ text: 'while the hub is down' })
    assert.equal(down.isError, true, 'a send with the hub down is a tool error, not a dead server')
    await sleep(1200) // several failed attempts, so recovery comes from a retry, not the first try
    late = await startHub({ stateDir, configDir, cfg: { ...cfg, listen: `127.0.0.1:${port}` } })
    await until(() => late!.delivery.openStreams().some(o => o.principal === 'claude' && o.name === 'late'), 15000, 'late binding stream open')
    assert.ok(late.store.getBinding('claude', 'late'), 'the binding was created by a retried bind')
    const up = await s.call({ text: 'after the hub came up' })
    assert.ok(!up.isError, up.content?.[0]?.text)
  } finally {
    await late?.stop()
    await env.teardown()
  }
})

test('F13: an unreachable pinned (wss) hub does not kill the MCP server', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    const credFile = `${env.newDir()}/claude-pinned.json`
    writeFileSync(credFile, JSON.stringify({ hub: `wss://127.0.0.1:${freePort()}`, token: 'x'.repeat(32), fingerprint: 'ab'.repeat(32), rooms: ['all'] }))
    const s = new McpServer({ ...env, claudeCredFile: credFile }, { binding: 'pinned' })
    const init = await s.handshake()
    assert.equal(init.serverInfo.name, 'vortex')
    await sleep(800) // the background pin attempt has failed by now
    const list = (await s.request('tools/list')).result.tools
    assert.deepEqual(list.map((t: any) => t.name), ['vx_send', 'vx_read'])
    const r = await s.call({ text: 'pinned hub unreachable' })
    assert.equal(r.isError, true)
  } finally { await env.teardown() }
})

test('F13: an HTTP call to a hub that accepts but never answers times out', { timeout: 20000 }, async () => {
  const hole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data () {} } })
  try {
    const client = new VortexClient({ hub: `ws://127.0.0.1:${hole.port}`, token: 'x' }, { timeoutMs: 300 })
    const t0 = Date.now()
    await assert.rejects(client.send({ scope: 'room', room: 'all', text: 'into the void' }))
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`)
  } finally { hole.stop(true) }
})

// ---- Hook isolation (Codex 97e407b): a socket is per binding, not per chat --

function askHook (path: string, req: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = connect(path)
    let buf = ''
    s.setTimeout(3000, () => { s.destroy(); reject(new Error('hook timeout')) })
    s.on('error', reject)
    s.on('connect', () => s.write(JSON.stringify(req) + '\n'))
    s.on('data', c => {
      buf += c
      const i = buf.indexOf('\n')
      if (i >= 0) { resolve(JSON.parse(buf.slice(0, i))); s.destroy() }
    })
  })
}

test('hook isolation: a second Claude session on the same binding gets no passive mail and sets no human turn', { timeout: 40000 }, async () => {
  const env = await setup()
  const sock = `${env.newDir()}/owner.sock`
  const credential = { hub: `ws://127.0.0.1:${env.hub.port}`, token: env.claudeToken }
  const mk = (hostPid: number, name: string) => new Bridge({ credential, binding: 'iso', stateFile: `${env.newDir()}/${name}.json`, socketPath: sock, notify: async () => {}, hostPid })
  const owner = mk(1111, 'owner')
  const second = mk(2222, 'second')
  try {
    await owner.start()
    await until(() => env.hub.delivery.openStreams().some(o => o.principal === 'claude' && o.name === 'iso'), 5000, 'owner stream')
    await second.start()
    assert.equal(second.busy, true, 'the second session sees the live socket and stays idle')
    await env.codex.send({ text: 'OWNER_PASSIVE_SENTINEL' })
    await sleep(200)
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 'FOREIGN-CLAUDE-CHAT', prompt: 'foreign human input' }
    // The second session's hook: its own CLAUDE_PID, even with the owner further up its ancestry
    // (a Claude session started inside the owner's shell).
    const foreign = await askHook(sock, { op: 'context', event, origin: { claudePid: 2222, ancestors: [2222, 1111] } })
    assert.deepEqual(foreign, { ok: true })
    assert.equal((owner as any).humanTurn, false, 'a foreign hook never records a human turn')
    assert.deepEqual(await askHook(sock, { op: 'context', event }), { ok: true }, 'no origin: refused')
    assert.deepEqual(await askHook(sock, { op: 'context', event, origin: { ancestors: [2222] } }), { ok: true }, 'foreign ancestry: refused')
    const own = await askHook(sock, { op: 'context', event: { ...event, session_id: 'OWNER-CHAT' }, origin: { claudePid: 1111, ancestors: [1111] } })
    assert.match(own.context ?? '', /OWNER_PASSIVE_SENTINEL/, 'the owner session still gets its passive mail')
    assert.equal((owner as any).humanTurn, true)
  } finally {
    owner.stop()
    second.stop()
    await env.teardown()
  }
})

test('hook isolation end to end: a real hook from another Claude process prints nothing', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    await ready(env)
    await env.codex.send({ text: 'passive for the owner only' })
    await sleep(200)
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 'other', prompt: 'hi' }
    const proc = Bun.spawn(['bun', VX, 'hook', 'context'], {
      cwd: ROOT, stdin: new TextEncoder().encode(JSON.stringify(event)), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, XDG_RUNTIME_DIR: env.runtime, VORTEX_BINDING: 'main', CLAUDE_PID: '999999' },
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    assert.equal(code, 0)
    assert.equal(out, '', 'a hook of another Claude process gets no context')
    const mine = await runHook(env, event)
    assert.match(mine.out, /passive for the owner only/, 'the owning process still gets it')
  } finally { await env.teardown() }
})

test('hook origin: CLAUDE_PID parsed strictly, ancestry starts at the parent; matching rules', () => {
  const o = hookOrigin({ CLAUDE_PID: '1234' })
  assert.equal(o.claudePid, 1234)
  assert.equal(o.ancestors[0], process.ppid)
  assert.equal(hookOrigin({ CLAUDE_PID: '12x' }).claudePid, undefined)
  assert.equal(hookOrigin({ CLAUDE_PID: '0' }).claudePid, undefined)
  assert.equal(hookOrigin({}).claudePid, undefined)
  assert.equal(hookFromHost({ claudePid: 5, ancestors: [5] }, 5), true)
  assert.equal(hookFromHost({ claudePid: 6, ancestors: [6, 5] }, 5), false, 'nested session: its own CLAUDE_PID wins over ancestry')
  assert.equal(hookFromHost({ ancestors: [9, 5] }, 5), true, 'no CLAUDE_PID: ancestry fallback')
  assert.equal(hookFromHost({ ancestors: [9] }, 5), false)
  assert.equal(hookFromHost(undefined, 5), false)
  assert.equal(hookFromHost({ ancestors: 'x' } as any, 5), false)
})

test('concurrent start (Codex c144c44): exactly one session owns both the socket and the stream, and its hooks work', { timeout: 40000 }, async () => {
  const env = await setup()
  const sock = `${env.newDir()}/race.sock`
  const credential = { hub: `ws://127.0.0.1:${env.hub.port}`, token: env.claudeToken }
  const mk = (hostPid: number, name: string) => new Bridge({ credential, binding: 'race', stateFile: `${env.newDir()}/${name}.json`, socketPath: sock, notify: async () => {}, hostPid })
  const a = mk(1111, 'a')
  const b = mk(2222, 'b')
  try {
    await Promise.all([a.start(), b.start()])
    assert.equal([a, b].filter(x => x.busy).length, 1, 'exactly one loser')
    const winner = a.busy ? b : a
    const pid = winner === a ? 1111 : 2222
    await until(() => env.hub.delivery.openStreams().some(o => o.principal === 'claude' && o.name === 'race'), 5000, 'winner stream')
    await sleep(300)
    assert.equal([a, b].filter(x => x.busy).length, 1, 'the loser never opened a competing stream')
    await env.codex.send({ text: 'RACE_SENTINEL' })
    await sleep(200)
    const own = await askHook(sock, { op: 'context', event: { hook_event_name: 'UserPromptSubmit', prompt: 'p' }, origin: { claudePid: pid, ancestors: [pid] } })
    assert.match(own.context ?? '', /RACE_SENTINEL/, 'the stream owner also owns the socket its hooks reach')
  } finally { a.stop(); b.stop(); await env.teardown() }
})

test('a stale socket file is recovered, and a live one is never unlinked', { timeout: 40000 }, async () => {
  const env = await setup()
  const sock = `${env.newDir()}/stale.sock`
  writeFileSync(sock, '') // left over from a crash: exists, nothing listening
  const credential = { hub: `ws://127.0.0.1:${env.hub.port}`, token: env.claudeToken }
  const a = new Bridge({ credential, binding: 'stale', stateFile: `${env.newDir()}/a.json`, socketPath: sock, notify: async () => {}, hostPid: 1 })
  const b = new Bridge({ credential, binding: 'stale', stateFile: `${env.newDir()}/b.json`, socketPath: sock, notify: async () => {}, hostPid: 2 })
  try {
    await a.start()
    assert.equal(a.busy, false, 'stale file replaced')
    await b.start()
    assert.equal(b.busy, true, 'a live socket makes the second busy')
    const r = await askHook(sock, { op: 'context', event: { hook_event_name: 'PostToolUse' }, origin: { claudePid: 1, ancestors: [1] } })
    assert.equal(r.ok, true, 'the first server still answers on its socket')
  } finally { a.stop(); b.stop(); await env.teardown() }
})
