// Shared setup for the Claude Code plugin tests (claude.test.ts, claude-2.test.ts).
// Claude Code plugin tests (§8.11): real hub in-process, real server.ts and
// `vx hook context` subprocesses, loopback + temp dirs only.
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

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
export const SERVER = `${ROOT}/v6/plugins/claude/server.ts`
export const VX = `${ROOT}/v6/cli/vx.ts`

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export async function until<T> (fn: () => T | undefined | false, ms = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined && v !== false) return v as T
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(15)
  }
}

export interface Env {
  hub: Awaited<ReturnType<typeof startHub>>
  dirs: string[]
  codex: VortexClient
  operator: VortexClient
  claudeCredFile: string
  claudeToken: string
  runtime: string
  stateHome: string
  newDir: () => string
  teardown: () => Promise<void>
  servers: McpServer[]
}

export async function setup (): Promise<Env> {
  const dirs: string[] = []
  const newDir = () => { const d = mkdtempSync(`${tmpdir()}/vortex-claude-test-`); dirs.push(d); return d }
  const hub = await startHub({
    stateDir: newDir(),
    configDir: newDir(),
    cfg: { listen: '127.0.0.1:0', sendPerMinute: 1000, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100 },
  })
  const url = `ws://127.0.0.1:${hub.port}`
  const claudeToken = hub.store.createPrincipal('claude').token
  const codexToken = hub.store.createPrincipal('codex').token
  const opCred = JSON.parse(readFileSync(`${process.env.XDG_CONFIG_HOME}/vortex/operator.json`, 'utf8'))
  const claudeCredFile = `${newDir()}/claude.json`
  writeFileSync(claudeCredFile, JSON.stringify({ hub: url, token: claudeToken, rooms: ['all'] }))
  const env: Env = {
    hub, dirs, newDir, claudeCredFile, claudeToken,
    codex: new VortexClient({ hub: url, token: codexToken }),
    operator: new VortexClient({ hub: url, token: opCred.token }),
    runtime: newDir(),
    stateHome: newDir(),
    servers: [],
    teardown: async () => {
      for (const s of env.servers) s.kill()
      await hub.stop()
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    },
  }
  return env
}

export class McpServer {
  private proc: ReturnType<typeof Bun.spawn>
  messages: any[] = []
  private nextId = 1
  private pending = new Map<number, (m: any) => void>()
  constructor (env: Env, opts: { binding?: string; runtime?: string } = {}) {
    this.proc = Bun.spawn(['bun', SERVER], {
      cwd: ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: {
        ...process.env,
        VORTEX_CREDENTIAL_FILE: env.claudeCredFile,
        VORTEX_BINDING: opts.binding ?? 'main',
        XDG_RUNTIME_DIR: opts.runtime ?? env.runtime,
        XDG_STATE_HOME: env.stateHome,
        VORTEX_PULL_WAIT_MS: '1500',
      },
    })
    void this.pump()
    env.servers.push(this)
  }
  private async pump () {
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        const m = JSON.parse(line)
        if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id) } else this.messages.push(m)
      }
    }
  }
  private write (obj: unknown) { (this.proc.stdin as any).write(JSON.stringify(obj) + '\n'); (this.proc.stdin as any).flush() }
  request (method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no response to ${method}`)), 8000)
      this.pending.set(id, m => { clearTimeout(t); resolve(m) })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }
  notify (method: string) { this.write({ jsonrpc: '2.0', method }) }
  async handshake () {
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    this.notify('notifications/initialized')
    return init.result
  }
  channels () { return this.messages.filter(m => m.method === 'notifications/claude/channel') }
  async call (args: unknown) {
    const res = await this.request('tools/call', { name: 'vx_send', arguments: args })
    return res.result
  }
  kill () { try { this.proc.kill() } catch { /* gone */ } }
}

export function evidenceOf (env: Env, batch: string): { status: string; evidence: string | null } | undefined {
  return env.hub.store.db.query('SELECT status, evidence FROM deliveries WHERE id = ?').get(batch) as any
}

export async function runHook (env: Env, event: Record<string, unknown>, binding = 'main') {
  const proc = Bun.spawn(['bun', VX, 'hook', 'context'], {
    cwd: ROOT, stdin: new TextEncoder().encode(JSON.stringify(event)), stdout: 'pipe', stderr: 'pipe',
    // The test process spawned the MCP server, so it plays the Claude Code host the hook belongs to.
    env: { ...process.env, XDG_RUNTIME_DIR: env.runtime, VORTEX_BINDING: binding, CLAUDE_PID: String(process.pid) },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { out, code }
}

export async function ready (env: Env, binding = 'main') {
  const s = new McpServer(env, { binding })
  await s.handshake()
  await until(() => env.hub.delivery.openStreams().some(o => o.principal === 'claude' && o.name === binding), 5000, 'stream open')
  return s
}
