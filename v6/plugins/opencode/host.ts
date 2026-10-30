// The subset of the pinned fork's Promise plugin API this plugin uses (§8.8).
// Pinned integration target: github.com/anomalyco/opencode-style local fork
// at 88e0591d104706814c7c47d66a8a01de24bd46a8 (packages/plugin/src/promise/*).
// Declared structurally so the bundle imports nothing from the host.

export const PINNED_REVISION = '88e0591d104706814c7c47d66a8a01de24bd46a8'

export interface SyntheticInput {
  sessionID: string
  id?: string
  text: string
  description?: string
  metadata?: Record<string, unknown>
  delivery?: 'steer' | 'queue'
  resume?: boolean
}

export interface Registration { dispose: () => Promise<void> }

export interface ToolInfoLike {
  name: string
  description: string
  input: unknown
  options?: { codemode: boolean }
  execute: (input: unknown, context: { sessionID: string; signal?: AbortSignal }) => Promise<{ content?: string; output?: unknown }>
}

export interface CommandInvocation { sessionID: string; prompt: { text: string }; delivery: 'steer' | 'queue' }

export interface PluginCtx {
  app: { name: string; version: string; channel: string }
  location: { directory: string }
  options: Readonly<Record<string, any>>
  session: {
    synthetic: (input: SyntheticInput) => Promise<{ id: string }>
    wait: (input: { sessionID: string }) => Promise<void>
    hook: (name: string, callback: (event: any) => Promise<void> | void) => Promise<Registration>
  }
  tool: { transform: (callback: (editor: { add: (tool: ToolInfoLike) => void }) => void) => Promise<Registration> }
  command: {
    transform: (callback: (editor: { add: (def: { name: string; description?: string; execute: (input: CommandInvocation) => Promise<void> }) => void }) => void) => Promise<Registration>
  }
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: any) => Promise<void>
  }
}

/** Accepts an `-local.<sha>` fork build whose revision is the pinned one (or one the operator verified and listed). */
export function checkFork (ctx: PluginCtx, accept: readonly string[] = []): { ok: true } | { ok: false; reason: string } {
  const missing: string[] = []
  const fn = (v: unknown): boolean => typeof v === 'function'
  if (!fn(ctx.session?.synthetic)) missing.push('session.synthetic')
  if (!fn(ctx.session?.wait)) missing.push('session.wait')
  if (!fn(ctx.session?.hook)) missing.push('session.hook')
  if (!fn(ctx.tool?.transform)) missing.push('tool.transform')
  if (!fn(ctx.command?.transform)) missing.push('command.transform')
  if (!fn(ctx.storage?.get) || !fn(ctx.storage?.set)) missing.push('storage')
  if (typeof ctx.location?.directory !== 'string') missing.push('location.directory')
  if (missing.length > 0) return { ok: false, reason: `host lacks required plugin API: ${missing.join(', ')}` }
  const version = String(ctx.app?.version ?? '')
  const m = /-local\.([0-9a-f]{7,40})$/.exec(version)
  if (m === null) return { ok: false, reason: `unverified fork build "${version}": expected <version>-local.<sha> at revision ${PINNED_REVISION.slice(0, 9)}` }
  const sha = m[1]
  if (PINNED_REVISION.startsWith(sha) || accept.some(a => a.startsWith(sha) || sha.startsWith(a))) return { ok: true }
  return { ok: false, reason: `fork revision ${sha} is not the verified revision ${PINNED_REVISION.slice(0, 9)}; verify §8.8 against it, then add it to options.acceptRevisions` }
}
