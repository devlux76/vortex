// The OpenCode plugin's delivery engine (docs/v6-proposal.md §8.4, §8.8): hub
// stream <-> ctx.session.synthetic admissions. Wake batches flush at the
// `session.wait` idle boundary with delivery "queue"; passive batches pass
// resume:false and need no idle turn. Shared stream/send logic lives in
// client/bridge-base.ts (no hook socket here: OpenCode has no hooks).
import type { WireApiMessage } from '../../client/client.ts'
import { BridgeBase, type BaseOptions } from '../../client/bridge-base.ts'
import { measure, type WireMessage } from '../../client/render.ts'
import { renderWrapped } from '../../client/render.ts'
import type { SyntheticInput } from './host.ts'

export { INSTRUCTIONS, type SendArgs } from '../../client/mcp.ts'

/**
 * Host errors (Effect-style) may carry an empty message. Keep only allowlisted
 * fields (tag, name, message, scalar code) so failure reasons stay diagnosable
 * without ever serializing nested host data (requests, headers, causes).
 */
export function describeError (e: unknown): string {
  const MAX = 300
  const clip = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX)}…` : s)
  if (typeof e === 'string') return e.length > 0 ? clip(e) : 'unknown error'
  if (typeof e !== 'object' || e === null) return e === undefined || e === null ? 'unknown error' : clip(String(e))
  const o = e as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
  const tag = str(o._tag) ?? (str(o.name) !== 'Error' ? str(o.name) : undefined)
  const msg = str(o.message)
  const code = typeof o.code === 'string' || typeof o.code === 'number' ? String(o.code) : undefined
  const parts = [tag, msg].filter((x): x is string => x !== undefined)
  if (code !== undefined) parts.push(`code ${code}`)
  if (parts.length > 0) return clip(parts.join(': '))
  return o instanceof Error ? 'Error' : 'unknown error (non-standard host error)'
}

/** Stable host message id for a batch (§8.8): the inbox reconciles repeats of it. */
export function batchMessageId (batch: string): string {
  return `msg_vx_${batch}`
}

export interface BatchStore {
  get: (batch: string) => string | undefined
  record: (batch: string, messageId: string) => Promise<void>
}

export interface OpenCodeBridgeOptions extends BaseOptions {
  /** The one explicitly configured wake session (§8.8). */
  sessionID: string
  session: {
    synthetic: (input: SyntheticInput) => Promise<{ id: string }>
    wait: (input: { sessionID: string }) => Promise<void>
  }
  store: BatchStore
  /** Passive pull cadence (default 30 s); passive mail needs no idle turn. */
  passivePullMs?: number
}

export class OpenCodeBridge extends BridgeBase {
  protected readonly host = 'opencode' as const
  protected readonly wakeEvidence = 'host-accepted' as const
  protected override readonly hookSocket = false
  lastFailure?: string
  private wakeChain: Promise<void> = Promise.resolve()
  private passiveChain: Promise<void> = Promise.resolve()
  private inflight = new Set<string>()
  private pullTimer?: ReturnType<typeof setInterval>
  private readonly oopts: OpenCodeBridgeOptions

  constructor (opts: OpenCodeBridgeOptions) {
    super(opts, 'opencode')
    this.oopts = opts
  }

  /** Connects in the background (BridgeBase retries with bounded backoff); never throws into plugin setup. */
  begin (): void {
    if (this.closed) return
    void this.start()
    const every = this.oopts.passivePullMs ?? 30_000
    this.pullTimer = setInterval(() => this.pullPassive(), every)
  }

  protected override hubFailed (reason: string): void { this.lastFailure = `hub connect failed: ${reason}` }

  protected override streamOpened (): void { this.pullPassive() }

  /** Passive mail is pulled at natural insertion points (stream open, human prompt, timer). */
  pullPassive (): void {
    const ws = this.ws
    if (this.closed || this.busy || ws === undefined || ws.readyState !== 1) return
    this.client.pull(ws)
  }

  /** §8.5: a user message in the wake session that the plugin did not create. */
  noteHumanTurn (): void {
    this.humanTurn = true
    this.pullPassive()
  }

  get isClosed (): boolean { return this.closed }

  protected async onWake (batch: string, messages: WireApiMessage[], notices: string[]): Promise<void> {
    await this.admit(batch, true, messages, notices)
  }

  override async onBatch (batch: string, wake: boolean, messages: WireApiMessage[], notices: string[]): Promise<void> {
    if (this.closed || this.inflight.has(batch)) return // never submit a batch already being delivered
    this.inflight.add(batch)
    const run = (): Promise<void> => this.admit(batch, wake, messages, notices).finally(() => { this.inflight.delete(batch) })
    // Wake and passive queues are independent: a passive admission never waits for a busy turn (§8.4).
    if (wake) { this.wakeChain = this.wakeChain.then(run, run) } else { this.passiveChain = this.passiveChain.then(run, run) }
  }

  /** Resolves when every submission queued so far has settled (tests, shutdown). */
  async idle (): Promise<void> {
    await Promise.all([this.wakeChain, this.passiveChain])
  }

  private failDelivery (batch: string, reason: string): void {
    this.lastFailure = reason
    this.fail(batch, reason)
  }

  private async admit (batch: string, wake: boolean, messages: WireApiMessage[], notices: string[]): Promise<void> {
    const id = batchMessageId(batch)
    if (this.oopts.store.get(batch) === id) { this.ack(batch, 'host-accepted'); return } // accepted before a restart/lost ack
    const first = messages[0]
    const compose = { batch, scope: first?.scope ?? 'room', room: first?.room, notices, messages: messages as unknown as WireMessage[] }
    const fit = measure(compose)
    if (!fit.fits) { this.failDelivery(batch, `rendered batch exceeds bounds (${fit.overflow})`); return }
    const sessionID = this.oopts.sessionID
    if (wake) {
      // Flush at the fork's idle boundary; "queue" below makes the remaining race safe.
      try { await this.oopts.session.wait({ sessionID }) } catch (e) {
        this.failDelivery(batch, `session.wait failed: ${describeError(e)}`)
        return
      }
      if (this.closed) return
    }
    let admitted: { id?: unknown } | undefined
    try {
      admitted = await this.oopts.session.synthetic({
        sessionID,
        id,
        text: renderWrapped(compose),
        description: 'VORTEX peer batch',
        metadata: { vortex: { batch } },
        delivery: 'queue',
        ...(wake ? {} : { resume: false }),
      })
    } catch (e) {
      this.failDelivery(batch, `session.synthetic failed: ${describeError(e)}`)
      return
    }
    // Only a response naming the matching id is host-accepted evidence (§8.8).
    if (admitted?.id !== id) { this.failDelivery(batch, `admission response id ${String(admitted?.id)} does not match ${id}`); return }
    try {
      await this.oopts.store.record(batch, id)
    } catch (e) {
      this.failDelivery(batch, `cannot persist batch-to-message association: ${(e as Error).message}`)
      return
    }
    this.lastFailure = undefined
    this.ack(batch, 'host-accepted')
  }

  /** Awaited cleanup: no timers, no reconnect, hub stream closed before this resolves. */
  async shutdown (): Promise<void> {
    if (this.pullTimer !== undefined) clearInterval(this.pullTimer)
    const ws = this.ws
    const closed = ws === undefined || ws.readyState === 3
      ? Promise.resolve()
      : new Promise<void>(resolve => {
        const t = setTimeout(resolve, 2000)
        ws.addEventListener('close', () => { clearTimeout(t); resolve() })
      })
    this.stop()
    await closed
  }
}
