// Shared setup for the codex plugin tests (codex.test.ts, codex-2.test.ts).
// Codex plugin tests (§8.11): real hub in-process, real server.ts, `vx hook
// context --host codex` and `vx codex bind` subprocesses, and a fake app-server
// (fake-appserver.ts). Loopback + temp dirs only; the real Codex is never contacted.
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

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
export const SERVER = `${ROOT}/v6/plugins/codex/server.ts`
export const FAKE = `${ROOT}/v6/plugins/codex/fake-appserver.ts`
export const VX = `${ROOT}/v6/cli/vx.ts`
export const CHAT = '019c0000-aaaa-7000-8000-000000000001'
export const OTHER_CHAT = '019c0000-bbbb-7000-8000-000000000002'

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
  peer: VortexClient
  operator: VortexClient
  codexCred: string
  runtime: string
  stateHome: string
  pluginCfg: string
  fakeLog: string
  modeFile: string
  servers: McpServer[]
  teardown: () => Promise<void>
}

export async function setup (): Promise<Env> {
  const dirs: string[] = []
  const newDir = () => { const d = mkdtempSync(`${tmpdir()}/vortex-codex-test-`); dirs.push(d); return d }
  const hub = await startHub({
    stateDir: newDir(),
    configDir: newDir(),
    cfg: { listen: '127.0.0.1:0', sendPerMinute: 1000, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100 },
  })
  const url = `ws://127.0.0.1:${hub.port}`
  const codexToken = hub.store.createPrincipal('codex').token
  const peerToken = hub.store.createPrincipal('claude').token
  const opCred = JSON.parse(readFileSync(`${process.env.XDG_CONFIG_HOME}/vortex/operator.json`, 'utf8'))
  const codexCred = `${newDir()}/codex.json`
  writeFileSync(codexCred, JSON.stringify({ hub: url, token: codexToken, rooms: ['all'] }))
  const scratch = newDir()
  const env: Env = {
    hub, codexCred, servers: [],
    peer: new VortexClient({ hub: url, token: peerToken }),
    operator: new VortexClient({ hub: url, token: opCred.token }),
    runtime: newDir(), stateHome: newDir(), pluginCfg: newDir(),
    fakeLog: `${scratch}/fake.jsonl`, modeFile: `${scratch}/mode`,
    teardown: async () => {
      for (const s of env.servers) s.kill()
      await hub.stop()
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    },
  }
  return env
}

export const fakeEnv = (env: Env, threads = `${CHAT},${OTHER_CHAT}`): Record<string, string> => ({
  VORTEX_CODEX_APPSERVER_CMD: JSON.stringify(['bun', FAKE]),
  FAKE_LOG: env.fakeLog,
  FAKE_MODE_FILE: env.modeFile,
  FAKE_THREADS: threads,
})
export const setMode = (env: Env, mode: string) => writeFileSync(env.modeFile, mode)
export const fakeRequests = (env: Env): any[] =>
  existsSync(env.fakeLog) ? readFileSync(env.fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
export const turnStarts = (env: Env) => fakeRequests(env).filter(r => r.method === 'turn/start')

export class McpServer {
  private proc: ReturnType<typeof Bun.spawn>
  messages: any[] = []
  private nextId = 1
  private pending = new Map<number, (m: any) => void>()
  constructor (env: Env, opts: { binding?: string; threads?: string } = {}) {
    this.proc = Bun.spawn(['bun', SERVER], {
      cwd: ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      env: {
        ...process.env,
        ...fakeEnv(env, opts.threads),
        VORTEX_CREDENTIAL_FILE: env.codexCred,
        VORTEX_BINDING: opts.binding ?? 'main',
        XDG_RUNTIME_DIR: env.runtime,
        XDG_STATE_HOME: env.stateHome,
        XDG_CONFIG_HOME: env.pluginCfg,
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
  async handshake () {
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return init.result
  }
  async call (args: unknown) {
    return (await this.request('tools/call', { name: 'vx_send', arguments: args })).result
  }
  kill () { try { this.proc.kill() } catch { /* gone */ } }
}

export async function runVx (env: Env, args: string[], extra: Record<string, string> = {}, stdin = '') {
  const proc = Bun.spawn(['bun', VX, ...args], {
    cwd: ROOT, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...fakeEnv(env), XDG_RUNTIME_DIR: env.runtime, XDG_CONFIG_HOME: env.pluginCfg, VORTEX_BINDING: 'main', ...extra },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}
export const runHook = (env: Env, event: Record<string, unknown>) =>
  runVx(env, ['hook', 'context', '--host', 'codex'], {}, JSON.stringify({ session_id: CHAT, ...event }))
export const bindChat = (env: Env, chat = CHAT, extra: Record<string, string> = {}) => runVx(env, ['codex', 'bind', chat], extra)

export function evidenceOf (env: Env, batch: string): { status: string; evidence: string | null } | undefined {
  return env.hub.store.db.query('SELECT status, evidence FROM deliveries WHERE id = ?').get(batch) as any
}
/** Unresolved = not delivered: still pending, or reported failed (retryable with the same id); never evidence. */
export const unresolved = (env: Env, batch: string): boolean => {
  const r = evidenceOf(env, batch)
  return r !== undefined && (r.status === 'pending' || r.status === 'failed') && r.evidence === null
}
export const firstPendingWake = (env: Env): string | undefined =>
  (env.hub.store.db.query("SELECT id FROM deliveries WHERE binding_principal = 'codex' AND kind = 'wake' ORDER BY created LIMIT 1").get() as any)?.id

export async function ready (env: Env, opts: { bind?: boolean; threads?: string } = {}) {
  if (opts.bind !== false) {
    const b = await bindChat(env)
    assert.equal(b.code, 0, b.err)
  }
  const s = new McpServer(env, { threads: opts.threads })
  await s.handshake()
  await until(() => env.hub.delivery.openStreams().some(o => o.principal === 'codex' && o.name === 'main'), 5000, 'stream open')
  return s
}

/** Wait for the plugin's stream to drop (after kill) so a replacement is not refused with 4409. */
export const streamGone = (env: Env) =>
  until(() => !env.hub.delivery.openStreams().some(o => o.principal === 'codex') || undefined, 5000, 'old stream gone')
