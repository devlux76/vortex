// The Codex plugin's delivery engine (docs/v6-proposal.md §6, §8.4, §8.7):
// wake batches become one `turn/start` with `toolOutput` on the locally bound
// chat via the app-server; passive batches go to hooks (client/bridge-base.ts).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { WireApiMessage } from '../../client/client.ts'
import { renderBatch } from '../../client/render.ts'
import { BridgeBase, type BaseOptions } from '../../client/bridge-base.ts'
import { loadThreadBinding } from './binding.ts'
import { AppServerError, type AppServer } from './appserver.ts'

export { INSTRUCTIONS, type SendArgs } from '../../client/mcp.ts'

export const TOOL_OUTPUT = { name: 'vx_receive', namespace: 'vortex' } as const

export interface CodexBridgeOptions extends BaseOptions {
  appServer: AppServer
  /** Batch -> turn associations persist here before the hub is told (§8.7). */
  turnsFile: string
}

export class CodexBridge extends BridgeBase {
  protected readonly host = 'codex' as const
  protected readonly wakeEvidence = 'host-accepted' as const
  /** Last delivery failure, for status; also sent to the hub (thread id removed). */
  lastFailure?: string
  private queue: Promise<void> = Promise.resolve()
  private inflight = new Set<string>()
  private wokenBatches: string[] = []
  private turns: Record<string, { turn: string; at: number }>
  private readonly copts: CodexBridgeOptions

  constructor (opts: CodexBridgeOptions) {
    super(opts, 'codex')
    this.copts = opts
    this.turns = this.loadTurns()
  }

  private loadTurns (): Record<string, { turn: string; at: number }> {
    try { return JSON.parse(readFileSync(this.copts.turnsFile, 'utf8')) } catch { return {} }
  }

  /** Batch -> turn association recorded when the host admitted it. */
  turnOf (batch: string): string | undefined { return this.turns[batch]?.turn }

  private persistTurn (batch: string, turn: string): void {
    this.turns[batch] = { turn, at: Date.now() }
    const keys = Object.keys(this.turns)
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete this.turns[k]
    mkdirSync(this.copts.turnsFile.replace(/\/[^/]*$/, ''), { recursive: true, mode: 0o700 })
    // Synchronous and throwing: no association on disk means no acknowledgment.
    writeFileSync(this.copts.turnsFile, JSON.stringify(this.turns), { mode: 0o600 })
  }

  /** Only the selected chat may consume passive context or record a human turn. */
  protected override acceptsHook (event: Record<string, unknown>): boolean {
    const session = event.session_id
    return typeof session === 'string' && session.length > 0 && loadThreadBinding(this.opts.binding)?.thread === session
  }

  /** §8.5: a tool-output wake or an empty prompt is never a human prompt. */
  protected override isMachineTurn (event: Record<string, unknown>): boolean {
    const prompt = typeof event.prompt === 'string' ? event.prompt : ''
    if (prompt.trim().length === 0) return true
    return this.wokenBatches.some(id => prompt.includes(id))
  }

  protected async onWake (batch: string, messages: WireApiMessage[], notices: string[]): Promise<void> {
    if (this.inflight.has(batch)) return // never submit a batch that is already being delivered
    this.inflight.add(batch)
    // Serialize submissions to the host (§6): one turn/start at a time.
    this.queue = this.queue.then(() => this.deliver(batch, messages, notices)).finally(() => { this.inflight.delete(batch) })
    // Callers do not wait for the host; ack/fail happen inside deliver().
  }

  /** Resolves when every queued submission has settled (used by tests and stop()). */
  idle (): Promise<void> { return this.queue }

  private scrub (text: string, thread: string | undefined): string {
    return thread === undefined ? text : text.split(thread).join('<bound chat>')
  }

  private failDelivery (batch: string, reason: string, thread?: string): void {
    const safe = this.scrub(reason, thread)
    this.lastFailure = safe
    this.fail(batch, safe)
  }

  private async deliver (batch: string, messages: WireApiMessage[], notices: string[]): Promise<void> {
    const bound = loadThreadBinding(this.opts.binding)
    if (bound === undefined) {
      this.failDelivery(batch, `codex chat not bound for binding "${this.opts.binding}": run \`vx codex bind\` in the chat to receive mail`)
      return
    }
    const thread = bound.thread
    const first = messages[0]
    const output = renderBatch({
      batch, scope: first?.scope ?? 'room', room: first?.room, notices, messages: this.toWire(messages),
    })
    let result: any
    try {
      result = await this.copts.appServer.request('turn/start', {
        threadId: thread,
        input: [],
        toolOutput: { name: TOOL_OUTPUT.name, namespace: TOOL_OUTPUT.namespace, output, retain: true },
      })
    } catch (e) {
      const kind = e instanceof AppServerError ? e.kind : 'error'
      // RPC error, disconnect or timeout: unresolved. Nothing is acknowledged; the hub retries.
      this.failDelivery(batch, `turn/start ${kind}: ${(e as Error).message}`, thread)
      return
    }
    const turn = result?.turn?.id
    if (typeof turn !== 'string' || turn.length === 0) {
      this.failDelivery(batch, 'turn/start response did not name a turn', thread)
      return
    }
    try {
      this.persistTurn(batch, turn) // §8.7: persist the association before acknowledging
    } catch (e) {
      this.failDelivery(batch, `cannot persist batch-to-turn association: ${(e as Error).message}`, thread)
      return
    }
    this.wokenBatches.push(batch)
    if (this.wokenBatches.length > 200) this.wokenBatches = this.wokenBatches.slice(-200)
    this.lastFailure = undefined
    this.persist(batch)
    this.ack(batch, 'host-accepted')
  }

  override status (): string {
    if (this.busy) return this.busyMessage()
    if (loadThreadBinding(this.opts.binding) === undefined) return `codex chat not bound: run \`vx codex bind\``
    return this.lastFailure === undefined ? 'ok' : `last delivery failed: ${this.lastFailure}`
  }

  override stop (): void {
    super.stop()
    this.copts.appServer.close()
  }
}
