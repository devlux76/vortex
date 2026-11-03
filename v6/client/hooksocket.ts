// Per-binding unix socket shared by a plugin's MCP server and `vx hook context`
// (§8.6, §8.7). Newline-delimited JSON. Hooks never talk to the model or to the hub.
import { mkdirSync, readFileSync } from 'node:fs'

export type HostName = 'claude' | 'codex' | 'opencode'

export function bindingName (): string {
  return process.env.VORTEX_BINDING ?? 'default'
}

export function runtimeDir (): string {
  const base = process.env.XDG_RUNTIME_DIR ?? `/tmp/vortex-${process.getuid?.() ?? 'user'}`
  return `${base.replace(/\/$/, '')}/vortex`
}

export function socketPath (binding = bindingName(), host: HostName = 'claude'): string {
  return `${runtimeDir()}/${host}-${binding.replace(/[^A-Za-z0-9_.-]/g, '_')}.sock`
}

export function ensureRuntimeDir (): void {
  mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 })
}

/**
 * Which host process ran a hook. A socket is per binding, not per chat, so a
 * second session on the same binding reaches the first session's socket; the
 * server uses this to answer only hooks of its own host process.
 * Observed on Claude Code 2.1.316: an MCP server's parent is the `claude`
 * process, and hooks run as its descendants with `CLAUDE_PID` set to it.
 * The server does not get a fresh `CLAUDE_PID` (it inherits whatever its
 * parent had), so the server compares against its own `process.ppid`.
 */
export interface HookOrigin {
  /** `CLAUDE_PID` from the hook's environment, when it is a positive integer. */
  claudePid?: number
  /** The hook's ancestor pids, nearest first (its parent, grandparent, ...). */
  ancestors: number[]
}

/** Hook -> server requests. */
export type HookRequest =
  | { op: 'context'; event: Record<string, unknown>; origin?: HookOrigin }
  | { op: 'ack'; batch: string }

function parentOf (pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined
  } catch { return undefined }
}

/** The calling hook's origin: `/proc` where present, else one `ps` listing (macOS). */
export function hookOrigin (env: Record<string, string | undefined> = process.env, max = 16): HookOrigin {
  const raw = env.CLAUDE_PID
  const claudePid = raw !== undefined && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : undefined
  let parent: (pid: number) => number | undefined = parentOf
  if (parentOf(process.pid) === undefined) {
    const table = new Map<number, number>()
    try {
      const out = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=']).stdout.toString()
      for (const line of out.split('\n')) {
        const [p, pp] = line.trim().split(/\s+/).map(Number)
        if (Number.isInteger(p) && Number.isInteger(pp)) table.set(p as number, pp as number)
      }
    } catch { /* no ps: ancestors stay empty */ }
    parent = pid => table.get(pid)
  }
  const ancestors: number[] = []
  let pid = process.ppid
  while (ancestors.length < max && pid > 1) {
    ancestors.push(pid)
    const next = parent(pid)
    if (next === undefined) break
    pid = next
  }
  return claudePid === undefined ? { ancestors } : { claudePid, ancestors }
}

/**
 * Whether a hook came from host process `hostPid` (the server's parent). The
 * hook's own `CLAUDE_PID` names its nearest Claude process exactly, so a Claude
 * session started inside another session's shell is still told apart. Without
 * it, ancestry is the fallback. Neither present: refuse.
 */
export function hookFromHost (origin: HookOrigin | undefined, hostPid: number): boolean {
  if (origin === undefined || !Array.isArray(origin.ancestors)) return false
  if (origin.claudePid !== undefined) return origin.claudePid === hostPid
  return origin.ancestors.includes(hostPid)
}

/** Server -> hook responses. */
export type HookResponse =
  | { ok: true; context?: string; batch?: string }
  | { ok: false; error: string }
