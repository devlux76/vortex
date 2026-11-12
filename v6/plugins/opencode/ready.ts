// VORTEX v6 OpenCode readiness (bundled to dist/ready.js). The OpenCode plugin
// starts only when its Location instance boots, which a directory-scoped API
// request triggers; a server restart alone leaves VORTEX unbound. This oneshot
// activates the exact wake directory, then verifies on the hub that the
// plugin's binding has an OPEN stream (not merely that OpenCode answered 200).
//
// It is meant for a companion systemd oneshot (PartOf the OpenCode unit), so a
// readiness failure is reported but never stops a healthy OpenCode.
//
//   bun dist/ready.js --directory <abs dir> [--server http://127.0.0.1:4096]
//                     [--binding opencode] [--credential <file>] [--timeout-ms 60000]
//
// Exit codes: 0 ready (stream open); 3 never bound (fresh setup or plugin
// inactive for this directory); 4 retained binding offline (mail queues on the
// hub, stream not open); 5 OpenCode unreachable; 2 usage/credential error.
import { readFileSync } from 'node:fs'
import { loadCredential, type Credential } from '../../client/credential.ts'
import { VortexClient } from '../../client/client.ts'

export type ReadyState = 'ready' | 'never-bound' | 'offline' | 'opencode-unreachable'

export const EXIT: Record<ReadyState, number> = { ready: 0, 'never-bound': 3, offline: 4, 'opencode-unreachable': 5 }

export interface ReadyOptions {
  server: string
  directory: string
  binding: string
  credential: Credential
  timeoutMs: number
  pollMs?: number
  /** Basic-auth password for OpenCode (OPENCODE_SERVER_PASSWORD); none when the server runs with auth disabled. */
  password?: string
}

export interface ReadyResult {
  state: ReadyState
  detail: string
  pending?: { wake: number; passive: number }
  lastError?: string
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
interface Deps { fetch: Fetch; now: () => number; sleep: (ms: number) => Promise<void> }

const defaultDeps: Deps = { fetch: (input, init) => fetch(input, init), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }

function hubLabel (hub: string): string {
  return hub.replace(/\/+$/, '')
}

/** Boots the wake Location: any directory-scoped request does; /api/config is cheap and read-only. */
async function activate (o: ReadyOptions, d: Deps): Promise<boolean> {
  const headers: Record<string, string> = {}
  if (o.password !== undefined && o.password.length > 0) headers.authorization = `Basic ${btoa(`opencode:${o.password}`)}`
  try {
    const res = await d.fetch(`${o.server.replace(/\/+$/, '')}/api/config?directory=${encodeURIComponent(o.directory)}`, { headers, signal: AbortSignal.timeout(10_000) })
    return res.ok
  } catch { return false }
}

interface BindingStatus { principal: string; name: string; open: boolean; pending?: { wake?: number; passive?: number }; lastError?: string }

/** Hub status through the shared VortexClient, so the enrolled TLS fingerprint pin applies exactly as in the plugin. */
async function bindingStatus (o: ReadyOptions, client: VortexClient): Promise<BindingStatus | undefined | 'hub-error'> {
  try {
    const body = await Promise.race([
      client.status() as Promise<{ bindings?: BindingStatus[] }>,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('status timeout')), 10_000)),
    ])
    const principal = o.credential.principal ?? 'opencode'
    return (body.bindings ?? []).find(b => b.principal === principal && b.name === o.binding)
  } catch { return 'hub-error' }
}

/** Polls until the binding's stream is open or the deadline passes; never throws. */
export async function checkReady (o: ReadyOptions, deps: Partial<Deps> = {}): Promise<ReadyResult> {
  const d: Deps = { ...defaultDeps, ...deps }
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs < 1 || o.timeoutMs > MAX_TIMEOUT_MS) throw new RangeError(`timeoutMs must be finite within 1..${MAX_TIMEOUT_MS}`)
  const deadline = d.now() + o.timeoutMs
  const poll = o.pollMs ?? 1000
  let activated = false
  let last: BindingStatus | undefined | 'hub-error' = undefined
  const client = new VortexClient(o.credential)
  while (true) {
    // Re-activate until it succeeds: OpenCode may still be starting.
    if (!activated) activated = await activate(o, d)
    if (activated) {
      last = await bindingStatus(o, client)
      if (last !== undefined && last !== 'hub-error' && last.open) {
        return { state: 'ready', detail: `binding ${last.principal}/${last.name} stream open`, pending: norm(last.pending), lastError: last.lastError }
      }
    }
    if (d.now() + poll > deadline) break
    await d.sleep(poll)
  }
  if (!activated) return { state: 'opencode-unreachable', detail: `OpenCode at ${o.server} did not answer a directory-scoped request for ${o.directory}` }
  if (last === 'hub-error') return { state: 'offline', detail: `hub ${hubLabel(o.credential.hub)} status unavailable (unreachable, unauthorized or TLS pin mismatch); cannot confirm the stream` }
  if (last === undefined) {
    return { state: 'never-bound', detail: `no binding ${o.credential.principal ?? 'opencode'}/${o.binding} on the hub: fresh setup, or the plugin is inactive for ${o.directory} (check options.directory, acceptRevisions, credential; OpenCode logs "[vortex] inactive: ...")` }
  }
  const pending = norm(last.pending)
  return { state: 'offline', detail: `binding ${last.principal}/${last.name} retained but stream not open; mail queues on the hub (wake ${pending.wake}, passive ${pending.passive})`, pending, lastError: last.lastError }
}

function norm (p: BindingStatus['pending']): { wake: number; passive: number } {
  return { wake: p?.wake ?? 0, passive: p?.passive ?? 0 }
}

function parse (argv: string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--') && argv[i + 1] !== undefined) { m.set(a.slice(2), argv[i + 1]); i++ }
  }
  return m
}

/** Readiness must terminate: a finite whole number of ms in [1, 3_600_000]. NaN, Infinity, 0 and negatives are usage errors. */
export const MAX_TIMEOUT_MS = 3_600_000

export function parseTimeout (raw: string | undefined): number | string {
  if (raw === undefined) return 60_000
  if (!/^[0-9]+$/.test(raw.trim())) return `--timeout-ms must be a whole number of milliseconds (1..${MAX_TIMEOUT_MS}), got "${raw}"`
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TIMEOUT_MS) return `--timeout-ms must be within 1..${MAX_TIMEOUT_MS}, got ${raw}`
  return n
}

export async function main (argv: string[]): Promise<number> {
  const f = parse(argv)
  const timeoutMs = parseTimeout(f.get('timeout-ms'))
  if (typeof timeoutMs === 'string') { console.error(`vortex-ready: ${timeoutMs}`); return 2 }
  const directory = f.get('directory')
  if (directory === undefined || !directory.startsWith('/')) { console.error('vortex-ready: --directory <absolute wake Location> is required'); return 2 }
  let credential: Credential | undefined
  try {
    const file = f.get('credential')
    credential = file !== undefined ? JSON.parse(readFileSync(file, 'utf8')) as Credential : loadCredential('opencode')
  } catch (e) { console.error(`vortex-ready: credential unreadable: ${(e as Error).message}`); return 2 }
  if (credential === undefined || typeof credential.hub !== 'string' || typeof credential.token !== 'string') {
    console.error('vortex-ready: no opencode credential (run: vx enroll opencode, or pass --credential)')
    return 2
  }
  const r = await checkReady({
    server: f.get('server') ?? 'http://127.0.0.1:4096',
    directory: directory.replace(/\/+$/, '') || '/',
    binding: f.get('binding') ?? 'opencode',
    credential,
    timeoutMs,
    password: process.env.OPENCODE_SERVER_PASSWORD,
  })
  const line = `vortex-ready: ${r.state}: ${r.detail}${r.lastError ? ` (lastError: ${r.lastError})` : ''}`
  if (r.state === 'ready') console.log(line); else console.error(line)
  return EXIT[r.state]
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
