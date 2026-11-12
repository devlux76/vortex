// A3 (§8.15): each built plugin directory, copied ALONE into a temp dir with no
// sibling v6/ tree, must work: MCP initialize + tools/list and `vx hook context`
// (Claude, Codex) and the in-process entry with a fake ctx (OpenCode), all against
// a test hub. The manifests are executed exactly as written, with the host's
// root variable substituted for the copy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startHub } from '../hub/main.ts'
import { VortexClient } from '../client/client.ts'
import { FIXED_PEER_DATA_LINE, parseBatch } from '../client/render.ts'
import { INSTRUCTIONS } from '../client/mcp.ts'
import { FakeHost } from './opencode/fake-host.ts'

const V6 = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T> (fn: () => T | undefined | false, ms = 8000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined && v !== false) return v as T
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(15)
  }
}

const dirs: string[] = []
const newDir = () => { const d = mkdtempSync(`${tmpdir()}/vortex-bundle-test-`); dirs.push(d); return d }

/** Copy one plugin directory alone; nothing else from the repo exists beside it. */
function isolate (plugin: string): string {
  const root = `${newDir()}/${plugin}`
  cpSync(`${V6}/plugins/${plugin}`, root, { recursive: true })
  return root
}

function jsonFilesIn (dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = `${dir}/${e}`
    if (e === 'dist') continue
    if (statSync(p).isDirectory()) out.push(...jsonFilesIn(p))
    else if (e.endsWith('.json')) out.push(p)
  }
  return out
}

async function env () {
  const hub = await startHub({
    stateDir: newDir(), configDir: newDir(),
    cfg: { listen: '127.0.0.1:0', sendPerMinute: 1000, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100 },
  })
  const url = `ws://127.0.0.1:${hub.port}`
  const mk = (name: string) => {
    const token = hub.store.createPrincipal(name).token
    const file = `${newDir()}/${name}.json`
    writeFileSync(file, JSON.stringify({ hub: url, token, rooms: ['all'] }))
    return { token, file }
  }
  const agent = { claude: mk('claude'), codex: mk('codex'), opencode: mk('opencode') }
  const peerToken = hub.store.createPrincipal('peer').token
  return { hub, url, agent, peer: new VortexClient({ hub: url, token: peerToken }) }
}

class Mcp {
  private proc: ReturnType<typeof Bun.spawn>
  private nextId = 1
  private pending = new Map<number, (m: any) => void>()
  constructor (argv: string[], envv: Record<string, string>) {
    this.proc = Bun.spawn(argv, { cwd: tmpdir(), stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { ...process.env, ...envv } })
    void this.pump()
  }
  private async pump () {
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        this.pending.get(m.id)?.(m)
      }
    }
  }
  request (method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no response to ${method}`)), 8000)
      this.pending.set(id, m => { clearTimeout(t); resolve(m) })
      ;(this.proc.stdin as any).write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      ;(this.proc.stdin as any).flush()
    })
  }
  kill () { this.proc.kill() }
}

/** Resolves a manifest command (with its host root variable) into an argv for the isolated copy. */
function resolveCommand (spec: { command: string; args?: string[] }, rootVar: string, root: string): string[] {
  const sub = (s: string) => s.split('${' + rootVar + '}').join(root)
  if (spec.args !== undefined) return [spec.command, ...spec.args.map(sub)]
  return ['sh', '-c', sub(spec.command)]
}

for (const host of ['claude', 'codex'] as const) {
  const rootVar = host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT'
  test(`${host}: the bundled plugin directory alone serves MCP initialize/tools/list and vx hook context`, async () => {
    const e = await env()
    const root = isolate(host)
    const servers: Mcp[] = []
    try {
      // manifests reference only paths inside the plugin root, through the host variable
      for (const f of jsonFilesIn(root)) {
        const body = readFileSync(f, 'utf8')
        assert.ok(!body.includes('../'), `${f} must not escape the plugin root`)
        for (const m of body.matchAll(/\$\{(\w+)\}(\/[A-Za-z0-9_./-]*)/g)) {
          assert.equal(m[1], rootVar)
          assert.ok(existsSync(`${root}${m[2]}`), `${f} references missing ${m[2]}`)
          assert.ok(m[2].startsWith('/dist/'))
        }
      }
      const mcp = JSON.parse(readFileSync(`${root}/${host === 'codex' ? 'mcp.json' : '.mcp.json'}`, 'utf8')).mcpServers.vortex
      const runtime = newDir()
      const envv = { VORTEX_CREDENTIAL_FILE: e.agent[host].file, VORTEX_BINDING: 'iso', XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: newDir(), XDG_CONFIG_HOME: newDir() }
      if (host === 'codex') {
        mkdirSync(`${envv.XDG_CONFIG_HOME}/vortex`)
        writeFileSync(`${envv.XDG_CONFIG_HOME}/vortex/codex-thread-iso.json`, JSON.stringify({ thread: 'isolated-codex-chat', binding: 'iso', boundAt: 0 }))
      }
      const server = new Mcp(resolveCommand(mcp, rootVar, root), envv)
      servers.push(server)
      const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
      assert.equal(init.result.serverInfo.name, 'vortex')
      assert.equal(init.result.instructions, INSTRUCTIONS)
      const tools = await server.request('tools/list')
      assert.deepEqual(tools.result.tools.map((t: any) => t.name), ['vx_send', 'vx_read'])

      // `vx hook context` exactly as the host's hooks.json runs it
      const hooks = JSON.parse(readFileSync(`${root}/hooks/hooks.json`, 'utf8')).hooks.UserPromptSubmit[0].hooks[0]
      await until(() => e.hub.delivery.openStreams().some(s => s.principal === host) || undefined, 8000, 'plugin stream')
      await e.peer.send({ text: 'passive from the isolated copy', to: [] })
      await sleep(100)
      // Ordinary MCP read works without channel initialization or a host-wake
      // connection; the following hook must still receive this same mail.
      const read = await server.request('tools/call', { name: 'vx_read' })
      assert.equal(read.result.isError, undefined)
      assert.ok(read.result.content[0].text.includes('passive from the isolated copy'))
      assert.match(read.result.content[0].text, /\[vx: next after=\d+; more=false\]$/)
      const proc = Bun.spawn(resolveCommand(hooks, rootVar, root), {
        cwd: tmpdir(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        // The test process spawned the MCP server, so it is the host the hook belongs to.
        env: { ...process.env, ...envv, CLAUDE_PID: String(process.pid) },
      })
      ;(proc.stdin as any).write(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', session_id: 'isolated-codex-chat' }))
      ;(proc.stdin as any).end()
      const out = await new Response(proc.stdout as ReadableStream).text()
      await proc.exited
      const ctx: string = JSON.parse(out).hookSpecificOutput.additionalContext
      assert.equal(ctx.split('\n')[0], FIXED_PEER_DATA_LINE)
      assert.deepEqual(parseBatch(ctx.split('\n').slice(1).join('\n')).messages.map(m => m.text), ['passive from the isolated copy'])
    } finally {
      for (const s of servers) s.kill()
      await e.hub.stop()
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    }
  })
}

test('opencode: the bundled entry alone exposes send/read tools and admits a wake', async () => {
  const e = await env()
  const root = isolate('opencode')
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
    assert.equal(pkg.main, 'dist/server.js')
    const mod = await import(`${root}/dist/server.js`)
    assert.equal(mod.default.id, 'vortex')
    assert.equal(typeof mod.default.setup, 'function')
    const host = new FakeHost()
    const cleanup = await mod.default.setup(host.ctx({
      session: 'ses_wake', directory: host.directory, binding: 'iso',
      credentialFile: e.agent.opencode.file, operatorCredentialFile: `${root}/none.json`, passivePullMs: 50,
    }))
    assert.deepEqual([...host.tools.keys()], ['vx_send', 'vx_read'])
    assert.equal(host.tools.get('vx_send')!.options?.codemode, false)
    await until(() => e.hub.delivery.openStreams().some(s => s.principal === 'opencode') || undefined, 8000, 'plugin stream')
    await e.peer.send({ text: 'wake the bundle', to: ['opencode'] })
    await until(() => host.synthetics.length >= 1 || undefined, 8000, 'admission')
    assert.equal(host.synthetics[0].delivery, 'queue')
    const read = await host.tools.get('vx_read')!.execute({}, { sessionID: 'ses_wake' })
    assert.match(read.content!, /wake the bundle/)
    assert.match(read.content!, /\[vx: next after=\d+; more=false\]$/)
    const wake = { sessionID: 'ses_wake', system: [] as any[] }
    await host.fire('context', wake)
    assert.equal(wake.system[0].text, INSTRUCTIONS)
    await cleanup()
    assert.equal(host.active, 0)
  } finally {
    await e.hub.stop()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  }
})
