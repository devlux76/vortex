// A fake OpenCode plugin ctx for tests (no live OpenCode is ever contacted). It
// implements exactly the subset the plugin uses and records every call. The inbox
// model mirrors the fork's reconciliation (packages/core/src/session/inbox.ts:
// first admission wins for the same Session and type; a conflicting reuse fails).
import type { CommandInvocation, PluginCtx, Registration, SyntheticInput, ToolInfoLike } from './host.ts'

export class FakeHost {
  version = '2.1.4-local.88e0591d1'
  directory = '/work/vortex'
  busy = false
  waitCalls = 0
  synthetics: SyntheticInput[] = []
  inbox = new Map<string, { sessionID: string; text: string }>()
  /** Model turns started by admissions (resume !== false on a first admission). */
  turns = 0
  storage = new Map<string, unknown>()
  storageFailures = 0
  /** When set, admissions answer with this id instead of the proposed one. */
  respondId?: string
  tools = new Map<string, ToolInfoLike>()
  commands = new Map<string, { description?: string; execute: (input: CommandInvocation) => Promise<void> }>()
  hooks: Array<{ name: string; cb: (event: any) => Promise<void> | void; active: boolean }> = []
  active = 0
  private idleWaiters: Array<() => void> = []

  setBusy (b: boolean): void {
    this.busy = b
    if (!b) this.idleWaiters.splice(0).forEach(w => w())
  }

  private register (undo: () => void): Registration {
    this.active++
    let done = false
    return { dispose: async () => { if (!done) { done = true; this.active--; undo() } } }
  }

  async fire (name: string, event: any): Promise<void> {
    for (const h of this.hooks.filter(h => h.name === name && h.active)) await h.cb(event)
  }

  ctx (options: Record<string, any>): PluginCtx {
    const host = this
    return {
      app: { name: 'opencode', version: this.version, channel: 'local' },
      location: { directory: this.directory },
      options,
      session: {
        synthetic: async input => {
          host.synthetics.push(structuredClone(input))
          const existing = host.inbox.get(input.id!)
          if (existing !== undefined) {
            if (existing.sessionID !== input.sessionID) throw new Error('SyntheticConflictError')
            return { id: host.respondId ?? input.id! }
          }
          host.inbox.set(input.id!, { sessionID: input.sessionID, text: input.text })
          if (input.resume !== false) host.turns++
          return { id: host.respondId ?? input.id! }
        },
        wait: async () => {
          host.waitCalls++
          while (host.busy) await new Promise<void>(r => host.idleWaiters.push(r))
        },
        hook: async (name, cb) => {
          const h = { name, cb, active: true }
          host.hooks.push(h)
          return host.register(() => { h.active = false })
        },
      },
      tool: {
        transform: async cb => {
          const added: string[] = []
          cb({ add: t => { host.tools.set(t.name, t); added.push(t.name) } })
          return host.register(() => added.forEach(n => host.tools.delete(n)))
        },
      },
      command: {
        transform: async cb => {
          const added: string[] = []
          cb({ add: d => { host.commands.set(d.name, d); added.push(d.name) } })
          return host.register(() => added.forEach(n => host.commands.delete(n)))
        },
      },
      storage: {
        get: async key => host.storage.get(key),
        set: async (key, value) => {
          if (host.storageFailures > 0) { host.storageFailures--; throw new Error('storage unavailable') }
          host.storage.set(key, structuredClone(value))
        },
      },
    }
  }
}
