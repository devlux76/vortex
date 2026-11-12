// VORTEX v6 OpenCode plugin (docs/v6-proposal.md §8.8, §8.9, A1, A3): an
// in-process Promise plugin for the operator's fork. One explicitly configured
// wake session, `vx_send` through ctx.tool.transform, fixed instructions through
// ctx.session.hook("context"), and the operator's human commands through
// ctx.command.transform (separate operator credential, never a model tool).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadCredential, type Credential } from '../../client/credential.ts'
import { VortexClient, type WireApiMessage } from '../../client/client.ts'
import { INSTRUCTIONS, TOOL, parseSendArgs } from '../../client/mcp.ts'
import { READ_TOOL, parseReadArgs, readHistory } from '../../client/read.ts'
import { recentLine, type WireMessage } from '../../client/render.ts'
import { OpenCodeBridge, type BatchStore } from './bridge.ts'
import { checkFork, type PluginCtx, type Registration } from './host.ts'

export const PLUGIN_ID = 'vortex'
const STORE_KEY = 'vortex.batches'
const KEEP = 200

export interface Options {
  /** The one long-lived wake session (§8.8); the plugin has no implicit session identity. */
  session: string
  /** Absolute Location directory this plugin serves; every other Location stays inert. */
  directory: string
  binding: string
  credentialFile?: string
  operatorCredentialFile?: string
  acceptRevisions: string[]
  passivePullMs?: number
  stateFile?: string
}

export function parseOptions (raw: Readonly<Record<string, any>>): Options | string {
  if (typeof raw.session !== 'string' || !raw.session.startsWith('ses_')) return 'options.session must be the wake session id (ses_...)'
  if (typeof raw.directory !== 'string' || !raw.directory.startsWith('/')) return 'options.directory must be the absolute Location directory'
  const str = (k: string): string | undefined => (typeof raw[k] === 'string' ? raw[k] : undefined)
  return {
    session: raw.session,
    directory: raw.directory.replace(/\/+$/, '') || '/',
    binding: str('binding') ?? 'opencode',
    credentialFile: str('credentialFile'),
    operatorCredentialFile: str('operatorCredentialFile'),
    acceptRevisions: Array.isArray(raw.acceptRevisions) ? raw.acceptRevisions.filter((r: unknown): r is string => typeof r === 'string') : [],
    passivePullMs: typeof raw.passivePullMs === 'number' ? raw.passivePullMs : undefined,
  }
}

function readFile (path: string): Credential {
  const c = JSON.parse(readFileSync(path, 'utf8')) as Credential
  if (typeof c.hub !== 'string' || typeof c.token !== 'string') throw new Error(`invalid credential file: ${path}`)
  return c
}

function agentCredential (o: Options): Credential | string {
  try {
    if (o.credentialFile !== undefined) return readFile(o.credentialFile)
    const c = loadCredential('opencode')
    if (c !== undefined) return c
  } catch (e) { return (e as Error).message }
  return `no agent credential at ${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/vortex/opencode.json; run: vx enroll opencode`
}

/** The human's credential, shared with `vx say`; resolved only when a human command runs. */
function operatorClient (o: Options): VortexClient {
  let c: Credential | undefined
  try { c = o.operatorCredentialFile !== undefined ? readFile(o.operatorCredentialFile) : loadCredential('operator') } catch (e) {
    throw new Error(`VORTEX operator credential unusable: ${(e as Error).message}`)
  }
  if (c === undefined) {
    throw new Error(`VORTEX operator credential is not configured (${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/vortex/operator.json, or options.operatorCredentialFile). Agent messaging is unaffected.`)
  }
  return new VortexClient(c)
}

async function loadStore (ctx: PluginCtx): Promise<BatchStore> {
  let map: Record<string, { id: string; at: number }> = {}
  try {
    const v = await ctx.storage.get(STORE_KEY)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) map = v as typeof map
  } catch { /* an unreadable store only costs a reconcile on replay */ }
  return {
    get: batch => map[batch]?.id,
    record: async (batch, id) => {
      const next = { ...map, [batch]: { id, at: Date.now() } }
      const keys = Object.keys(next)
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[k]
      await ctx.storage.set(STORE_KEY, next)
      map = next // memory follows disk only after the write succeeded
    },
  }
}

// ---- human commands -----------------------------------------------------------

function splitFirst (text: string): [string, string] {
  const t = text.trim()
  const i = t.search(/\s/)
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i).trim()]
}

async function visible (client: VortexClient): Promise<WireApiMessage[]> {
  return (await client.recent(200)).messages
}

export async function vxRoom (o: Options, text: string): Promise<void> {
  const [room, body] = splitFirst(text)
  if (room.length === 0 || body.length === 0) throw new Error('usage: /vx-room <room> <text>')
  const client = operatorClient(o)
  await client.send({ scope: 'room', room, text: body })
}

export async function vxReply (o: Options, text: string): Promise<void> {
  const [rawRef, body] = splitFirst(text)
  const ref = rawRef.replace(/^#/, '')
  if (ref.length === 0 || body.length === 0) throw new Error('usage: /vx-reply <message-id|ref> <text>')
  const client = operatorClient(o)
  const view = await visible(client)
  const hits = view.filter(m => (ref.length === 26 ? m.id === ref : ref.length === 6 && m.id.endsWith(ref)))
  if (hits.length === 0) throw new Error(`unknown or inaccessible message reference "${ref}" (not among the ${view.length} most recent visible messages; \`vx log\` prints ids)`)
  if (hits.length > 1) {
    throw new Error(`ambiguous reference "${ref}"; matching candidates:\n${hits.map(m => recentLine(m as unknown as WireMessage)).join('\n')}`)
  }
  const original = hits[0]
  if (original.scope === 'dm') {
    const other = original.from === 'operator' ? original.to[0] : original.from
    await client.send({ scope: 'dm', to: [other], reply_to: original.id, text: body })
  } else {
    await client.send({ scope: 'room', room: original.room, reply_to: original.id, text: body })
  }
}

export const VX_RECENT_UNAVAILABLE =
  'The pinned fork has no command output channel that stays out of the model session (a command callback returns void). ' +
  'Per spec amendment A1, list references with the CLI instead: `vx log --dm` or `vx log <room>` (prints ids and refs).'

// ---- the plugin ---------------------------------------------------------------

export function createPlugin (log: (msg: string) => void = m => console.error(`[vortex] ${m}`)) {
  return {
    id: PLUGIN_ID,
    async setup (ctx: PluginCtx): Promise<() => Promise<void>> {
      const none = async (): Promise<void> => {}
      const opts = parseOptions(ctx.options ?? {})
      if (typeof opts === 'string') { log(`inactive: ${opts}`); return none }
      // Gate on the Location this instance was activated for; never touch another Location's sessions.
      if (opts.directory !== ctx.location.directory.replace(/\/+$/, '')) return none
      const fork = checkFork(ctx, opts.acceptRevisions)
      if (!fork.ok) { log(`inactive: ${fork.reason}`); return none }
      const cred = agentCredential(opts)
      if (typeof cred === 'string') { log(`inactive: ${cred}`); return none }

      const store = await loadStore(ctx)
      const bridge = new OpenCodeBridge({
        credential: cred,
        binding: opts.binding,
        rooms: Array.isArray(cred.rooms) ? cred.rooms as string[] : ['all'],
        stateFile: opts.stateFile ?? `${homedir()}/.local/state/vortex/opencode-${opts.binding.replace(/[^A-Za-z0-9_.-]/g, '_')}.unused.json`,
        sessionID: opts.session,
        session: ctx.session,
        store,
        passivePullMs: opts.passivePullMs,
      })
      const registrations: Registration[] = []
      try {
        registrations.push(await ctx.tool.transform(editor => {
          editor.add({
            name: TOOL.name,
            description: TOOL.description,
            input: JSON.parse(JSON.stringify(TOOL.inputSchema)),
            options: { codemode: false },
            execute: async (input, context) => {
              if (context.sessionID !== opts.session) throw new Error('vx_send is only available in the configured VORTEX session')
              if (bridge.isClosed) throw new Error('VORTEX plugin is shut down')
              const out = await bridge.send(parseSendArgs(input))
              return { content: JSON.stringify(out) }
            },
          })
          // A5: read-only, non-consuming history, the same session restriction as vx_send.
          editor.add({
            name: READ_TOOL.name,
            description: READ_TOOL.description,
            input: JSON.parse(JSON.stringify(READ_TOOL.inputSchema)),
            options: { codemode: false },
            execute: async (input, context) => {
              if (context.sessionID !== opts.session) throw new Error('vx_read is only available in the configured VORTEX session')
              if (bridge.isClosed) throw new Error('VORTEX plugin is shut down')
              return { content: await readHistory(bridge.client, parseReadArgs(input)) }
            },
          })
        }))
        registrations.push(await ctx.session.hook('context', event => {
          if (event.sessionID !== opts.session) return
          if (event.system.some((p: { text?: string }) => p.text === INSTRUCTIONS)) return
          event.system.push({ type: 'text', text: INSTRUCTIONS })
        }))
        registrations.push(await ctx.session.hook('prompt', event => {
          // The plugin never calls session.prompt, so any user prompt here is the human's (§8.5).
          if (event.sessionID === opts.session) bridge.noteHumanTurn()
        }))
        registrations.push(await ctx.command.transform(editor => {
          editor.add({ name: 'vx-room', description: 'post to a VORTEX room as the human operator: /vx-room <room> <text>', execute: async input => { await vxRoom(opts, input.prompt.text) } })
          editor.add({ name: 'vx-reply', description: 'reply as the human operator: /vx-reply <message-id|ref> <text>', execute: async input => { await vxReply(opts, input.prompt.text) } })
          editor.add({ name: 'vx-recent', description: 'list recent VORTEX messages (see `vx log`)', execute: async () => { throw new Error(VX_RECENT_UNAVAILABLE) } })
        }))
      } catch (e) {
        await Promise.allSettled(registrations.map(r => r.dispose()))
        throw e
      }
      bridge.begin()
      return async () => {
        await Promise.allSettled(registrations.map(r => r.dispose()))
        await bridge.shutdown()
      }
    },
  }
}
