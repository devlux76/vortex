// Codex plugin tests (§8.11): real hub in-process, real server.ts, `vx hook
// context --host codex` and `vx codex bind` subprocesses, and a fake app-server
// (fake-appserver.ts). Loopback + temp dirs only; the real Codex is never contacted.
// Hooks, passive delivery and wake turns; binding and escaping tests are in codex-2.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startHub } from '../../hub/main.ts'
import { VortexClient } from '../../client/client.ts'
import { FIXED_PEER_DATA_LINE, parseBatch } from '../../client/render.ts'
import { CodexBridge, INSTRUCTIONS } from './bridge.ts'
import { saveThreadBinding } from './binding.ts'
import { TOOL } from './server.ts'
import { READ_TOOL } from '../../client/read.ts'
import {
  ROOT,
  SERVER,
  FAKE,
  VX,
  CHAT,
  OTHER_CHAT,
  sleep,
  until,
  type Env,
  setup,
  fakeEnv,
  setMode,
  fakeRequests,
  turnStarts,
  McpServer,
  runVx,
  runHook,
  bindChat,
  evidenceOf,
  unresolved,
  firstPendingWake,
  ready,
  streamGone
} from './testkit.ts'

test('plugin files: portable manifest, MCP, hooks (limit 0, no Stop) and marketplace; server has no channel, fixed instructions, send/read tools', { timeout: 40000 }, async () => {
  const dir = `${ROOT}/v6/plugins/codex`
  const manifest = JSON.parse(readFileSync(`${dir}/plugin.json`, 'utf8'))
  assert.equal(manifest.name, 'vortex')
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.equal(manifest.extensions['com.openai'].hooks, './hooks/hooks.json')
  const mcp = JSON.parse(readFileSync(`${dir}/mcp.json`, 'utf8'))
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  assert.deepEqual(mcp.mcpServers.vortex, { type: 'stdio', command: 'bun', args: ['${PLUGIN_ROOT}/dist/server.js'] })
  const hooks = JSON.parse(readFileSync(`${dir}/hooks/hooks.json`, 'utf8')).hooks
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'UserPromptSubmit']) // no Stop hook
  for (const ev of Object.values<any>(hooks)) {
    assert.equal(ev.length, 1)
    assert.equal(ev[0].hooks.length, 1)
    const h = ev[0].hooks[0]
    assert.equal(h.type, 'command')
    assert.equal(h.additionalContextLimit, 0)
    assert.match(h.command, /vx\.js" hook context --host codex$/)
  }
  const mk = JSON.parse(readFileSync(`${ROOT}/v6/.agents/plugins/marketplace.json`, 'utf8'))
  assert.equal(mk.plugins[0].name, manifest.name)
  assert.equal(mk.plugins[0].source.path, './plugins/codex')
  const env = await setup()
  try {
    const s = new McpServer(env)
    const init = await s.handshake()
    assert.equal(init.capabilities.experimental, undefined)
    assert.equal(init.instructions, INSTRUCTIONS)
    assert.equal(init.serverInfo.name, 'vortex')
    const list = (await s.request('tools/list')).result.tools
    assert.deepEqual(list.map((t: any) => t.name), ['vx_send', 'vx_read'])
    assert.deepEqual(list[0], JSON.parse(JSON.stringify(TOOL)))
    assert.deepEqual(list[1], JSON.parse(JSON.stringify(READ_TOOL)))
    // A5: the desktop front door works over plain MCP tools, independent of app-server wake.
    await env.peer.send({ scope: 'dm', to: ['codex'], text: 'read me over mcp' })
    const read = (await s.request('tools/call', { name: 'vx_read', arguments: { scope: 'dm' } })).result
    assert.ok(!read.isError, read.content?.[0]?.text)
    assert.match(read.content[0].text, /read me over mcp/)
    assert.match(read.content[0].text, /\[vx: next after=\d+; more=(true|false)\]\s*$/)
  } finally { await env.teardown() }
})

test('an addressed batch produces exactly one turn/start with toolOutput and empty input; host-accepted after the response names the turn', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    await ready(env)
    await env.peer.send({ text: 'can you check the hub test?', to: ['codex'] })
    const ts = await until(() => turnStarts(env)[0], 5000, 'turn/start')
    await sleep(300)
    assert.equal(turnStarts(env).length, 1)
    // handshake first, in order
    const serverPid = ts.pid // the plugin's own connection (the bind subprocess logged its own, earlier)
    assert.deepEqual(fakeRequests(env).filter(r => r.pid === serverPid).map(r => r.method), ['initialize', 'initialized', 'turn/start'])
    assert.equal(ts.params.threadId, CHAT)
    assert.deepEqual(ts.params.input, [])
    assert.deepEqual(Object.keys(ts.params).sort(), ['input', 'threadId', 'toolOutput'])
    const to = ts.params.toolOutput
    assert.deepEqual(Object.keys(to).sort(), ['name', 'namespace', 'output', 'retain'])
    assert.equal(to.name, 'vx_receive')
    assert.equal(to.namespace, 'vortex')
    assert.equal(to.retain, true)
    const parsed = parseBatch(to.output)
    assert.deepEqual(parsed.messages.map(m => [m.from, m.to, m.text]), [['claude', ['codex'], 'can you check the hub test?']])
    const row = await until(() => { const r = evidenceOf(env, parsed.batch); return r?.status === 'delivered' ? r : undefined }, 5000, 'delivered ack')
    assert.equal(row.evidence, 'host-accepted')
    // batch -> turn association persisted locally
    const turns = JSON.parse(readFileSync(`${env.stateHome}/vortex/codex-main.turns.json`, 'utf8'))
    assert.match(turns[parsed.batch].turn, /^turn-/)
    // the private thread id never reached the hub
    const dump = JSON.stringify([
      env.hub.store.db.query('SELECT * FROM messages').all(),
      env.hub.store.db.query('SELECT * FROM deliveries').all(),
      await env.operator.status(),
    ])
    assert.equal(dump.includes(CHAT), false)
  } finally { await env.teardown() }
})

test('passive traffic starts zero turns and is delivered only via the hook (hook-returned)', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    await ready(env)
    await env.peer.send({ text: 'fyi build is green' }) // no `to`: passive for codex
    await sleep(500)
    assert.equal(turnStarts(env).length, 0)
    const { out, code } = await runHook(env, { hook_event_name: 'PostToolUse', tool_name: 'shell' })
    assert.equal(code, 0)
    const json = JSON.parse(out)
    assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse')
    const ctx: string = json.hookSpecificOutput.additionalContext
    assert.equal(ctx.split('\n')[0], FIXED_PEER_DATA_LINE)
    const parsed = parseBatch(ctx.split('\n').slice(1).join('\n'))
    assert.deepEqual(parsed.messages.map(m => [m.from, m.text]), [['claude', 'fyi build is green']])
    const row = await until(() => { const r = evidenceOf(env, parsed.batch); return r?.status === 'delivered' ? r : undefined }, 5000, 'hook ack')
    assert.equal(row.evidence, 'hook-returned')
    const again = await runHook(env, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    assert.equal(again.out, '')
    await sleep(200)
    assert.equal(turnStarts(env).length, 0)
    // the hook handlers pass the full bounded text through (limit 0)
    const handlers = Object.values<any>(JSON.parse(readFileSync(`${ROOT}/v6/plugins/codex/hooks/hooks.json`, 'utf8')).hooks).map(e => e[0].hooks[0])
    assert.ok(handlers.every(h => h.additionalContextLimit === 0))
  } finally { await env.teardown() }
})

test('foreign, missing and malformed hook sessions neither consume passive mail nor mark a human turn', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    const server = await ready(env)
    await env.peer.send({ text: 'only the selected chat may read this' })
    for (const session_id of [OTHER_CHAT, undefined, '', 7]) {
      const hook = await runHook(env, { session_id, hook_event_name: 'UserPromptSubmit', prompt: 'foreign human prompt' })
      assert.equal(hook.code, 0)
      assert.equal(hook.out, '')
      const sent = await server.call({ text: 'automatic response' })
      const row = (await env.operator.roomLog('all')).messages.find(m => m.id === sent.structuredContent.id)!
      assert.equal(row.human, false)
    }
    assert.equal(existsSync(`${env.stateHome}/vortex/codex-main.batches.json`), false)
    const right = await runHook(env, { hook_event_name: 'PostToolUse' })
    const context = JSON.parse(right.out).hookSpecificOutput.additionalContext
    const batch = parseBatch(context.split('\n').slice(1).join('\n'))
    assert.deepEqual(batch.messages.map(m => m.text), ['only the selected chat may read this'])
    await until(() => evidenceOf(env, batch.batch)?.status === 'delivered' || undefined)
    assert.equal(evidenceOf(env, batch.batch)?.evidence, 'hook-returned')
    assert.equal(turnStarts(env).length, 0)
  } finally { await env.teardown() }
})

test('an unbound hook leaves passive mail available after explicit binding', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    await ready(env, { bind: false })
    await env.peer.send({ text: 'wait until a chat is selected' })
    assert.equal((await runHook(env, { hook_event_name: 'PostToolUse' })).out, '')
    assert.equal((await bindChat(env)).code, 0)
    const right = await runHook(env, { hook_event_name: 'PostToolUse' })
    assert.match(right.out, /wait until a chat is selected/)
  } finally { await env.teardown() }
})

test('passive delivery follows a rebind and rejects the previous chat', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    await ready(env)
    assert.equal((await bindChat(env, OTHER_CHAT)).code, 0)
    await env.peer.send({ text: 'mail for the new selected chat' })
    assert.equal((await runHook(env, { hook_event_name: 'PostToolUse' })).out, '')
    const right = await runHook(env, { hook_event_name: 'PostToolUse', session_id: OTHER_CHAT })
    assert.match(right.out, /mail for the new selected chat/)
    assert.equal(turnStarts(env).length, 0)
  } finally { await env.teardown() }
})

test('a rebind during a passive pull prevents context from reaching the old chat', { timeout: 40000 }, async () => {
  const previousConfig = process.env.XDG_CONFIG_HOME
  const env = await setup()
  let bridge: CodexBridge | undefined
  try {
    process.env.XDG_CONFIG_HOME = env.pluginCfg
    saveThreadBinding('main', CHAT)
    mkdirSync(`${env.runtime}/vortex`)
    bridge = new CodexBridge({
      credential: JSON.parse(readFileSync(env.codexCred, 'utf8')), binding: 'main',
      stateFile: `${env.stateHome}/vortex/codex-main.batches.json`,
      turnsFile: `${env.stateHome}/vortex/codex-main.turns.json`,
      socketPath: `${env.runtime}/vortex/codex-main.sock`,
      appServer: { request: async () => { throw new Error('passive mail must not call the host') }, close: () => {} },
    })
    const pull = bridge.client.pull.bind(bridge.client)
    let rebound = false
    bridge.client.pull = ws => {
      if (!rebound) { rebound = true; saveThreadBinding('main', OTHER_CHAT) }
      pull(ws)
    }
    await bridge.start()
    await until(() => env.hub.delivery.openStreams().some(s => s.principal === 'codex') || undefined)
    await env.peer.send({ text: 'the selection changed while pulling this mail' })
    assert.equal((await runHook(env, { hook_event_name: 'PostToolUse' })).out, '')
    assert.equal(rebound, true)
    const right = await runHook(env, { hook_event_name: 'PostToolUse', session_id: OTHER_CHAT })
    assert.match(right.out, /the selection changed while pulling this mail/)
  } finally {
    bridge?.stop()
    await env.teardown()
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfig
  }
})

test('a rebind before a hook acknowledges preserves the offer for the new chat', { timeout: 40000 }, async () => {
  const env = await setup()
  let socket: ReturnType<typeof connect> | undefined
  try {
    await ready(env)
    await env.peer.send({ text: 'pending while the selected chat changes' })
    socket = connect(`${env.runtime}/vortex/codex-main.sock`)
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]()
    await once(socket, 'connect')
    socket.write(JSON.stringify({ op: 'context', event: { hook_event_name: 'PostToolUse', session_id: CHAT } }) + '\n')
    const offer = JSON.parse((await lines.next()).value!)
    assert.match(offer.context, /pending while the selected chat changes/)
    assert.equal((await bindChat(env, OTHER_CHAT)).code, 0)
    socket.write(JSON.stringify({ op: 'ack', batch: offer.batch }) + '\n')
    const ack = JSON.parse((await lines.next()).value!)
    assert.equal(ack.ok, false)
    assert.ok(unresolved(env, offer.batch))
    const right = await runHook(env, { hook_event_name: 'PostToolUse', session_id: OTHER_CHAT })
    assert.equal(JSON.parse(right.out).hookSpecificOutput.additionalContext.includes(offer.batch), true)
    await until(() => evidenceOf(env, offer.batch)?.status === 'delivered' || undefined)
  } finally { socket?.destroy(); await env.teardown() }
})

test('an RPC error leaves the batch unresolved: nothing acked, failure reported with the chat id scrubbed; a restart redelivers the same batch', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    const first = await ready(env)
    setMode(env, 'rpc-error')
    await env.peer.send({ text: 'rpc error case', to: ['codex'] })
    const err = await until(() => env.hub.delivery.lastError('codex', 'main'), 5000, 'lastError')
    assert.match(err, /turn\/start rpc/)
    assert.equal(err.includes(CHAT), false)
    const batch = firstPendingWake(env)!
    await sleep(200)
    assert.ok(unresolved(env, batch), JSON.stringify(evidenceOf(env, batch)))
    assert.equal(turnStarts(env).length, 1)
    assert.equal(existsSync(`${env.stateHome}/vortex/codex-main.turns.json`), false) // no association without a turn
    // host recovers; the plugin restarts and the hub replays the SAME batch
    first.kill()
    await streamGone(env)
    setMode(env, 'ok')
    const second = new McpServer(env)
    await second.handshake()
    const row = await until(() => { const r = evidenceOf(env, batch); return r?.status === 'delivered' ? r : undefined }, 8000, 'redelivery ack')
    assert.equal(row.evidence, 'host-accepted')
    const ts = turnStarts(env)
    assert.equal(ts.length, 2)
    assert.equal(parseBatch(ts[1].params.toolOutput.output).batch, batch)
  } finally { await env.teardown() }
})

test('a disconnect before any response leaves the batch unresolved and unacked; so does a response that names no turn', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    const first = await ready(env)
    setMode(env, 'disconnect')
    await env.peer.send({ text: 'disconnect case', to: ['codex'] })
    const err = await until(() => env.hub.delivery.lastError('codex', 'main'), 8000, 'lastError')
    assert.match(err, /turn\/start disconnect/)
    const batch = firstPendingWake(env)!
    assert.ok(unresolved(env, batch), JSON.stringify(evidenceOf(env, batch)))
    assert.equal(turnStarts(env).length, 1)
    // a successful RPC response without a turn is not host-accepted evidence either
    first.kill()
    await streamGone(env)
    setMode(env, 'no-turn')
    const second = new McpServer(env)
    await second.handshake()
    await until(() => turnStarts(env).length === 2 || undefined, 8000, 'second attempt')
    await until(() => /did not name a turn/.test(env.hub.delivery.lastError('codex', 'main') ?? '') || undefined, 5000, 'no-turn failure')
    assert.ok(unresolved(env, batch), JSON.stringify(evidenceOf(env, batch)))
    // and then a real acceptance acknowledges exactly that batch
    second.kill()
    await streamGone(env)
    setMode(env, 'ok')
    const third = new McpServer(env)
    await third.handshake()
    const row = await until(() => { const r = evidenceOf(env, batch); return r?.status === 'delivered' ? r : undefined }, 8000, 'ack')
    assert.equal(row.evidence, 'host-accepted')
  } finally { await env.teardown() }
})

test('no Stop-hook receipts: a Stop event acknowledges nothing, offers nothing and is not wired', { timeout: 40000 }, async () => {
  const env = await setup()
  try {
    await ready(env)
    setMode(env, 'rpc-error')
    await env.peer.send({ text: 'stuck wake', to: ['codex'] })
    await env.peer.send({ text: 'waiting passive' })
    await until(() => env.hub.delivery.lastError('codex', 'main'), 5000, 'wake failure')
    const wake = firstPendingWake(env)!
    for (const hook_event_name of ['Stop', 'SessionStart']) {
      const r = await runHook(env, { hook_event_name })
      assert.equal(r.out, '')
      assert.equal(r.code, 0)
    }
    await sleep(300)
    const rows = env.hub.store.db.query("SELECT status, evidence FROM deliveries WHERE binding_principal = 'codex'").all() as any[]
    assert.ok(rows.length >= 1)
    assert.ok(rows.every(r => r.status !== 'delivered' && r.evidence === null), JSON.stringify(rows))
    assert.ok(unresolved(env, wake), JSON.stringify(evidenceOf(env, wake)))
    assert.equal(Object.keys(JSON.parse(readFileSync(`${ROOT}/v6/plugins/codex/hooks/hooks.json`, 'utf8')).hooks).includes('Stop'), false)
  } finally { await env.teardown() }
})
