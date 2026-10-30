// Per-binding unix socket shared by a plugin's MCP server and `vx hook context`
// (§8.6, §8.7). Newline-delimited JSON. Hooks never talk to the model or to the hub.
import { mkdirSync } from 'node:fs'

export type HostName = 'claude' | 'codex'

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

/** Hook -> server requests. */
export type HookRequest =
  | { op: 'context'; event: Record<string, unknown> }
  | { op: 'ack'; batch: string }

/** Server -> hook responses. */
export type HookResponse =
  | { ok: true; context?: string; batch?: string }
  | { ok: false; error: string }
