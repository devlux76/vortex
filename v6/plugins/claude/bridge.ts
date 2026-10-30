// The Claude Code plugin's delivery engine (docs/v6-proposal.md §8.4, §8.6):
// hub stream <-> channel notifications (wake). Shared stream/hook/send logic
// lives in client/bridge-base.ts; server.ts supplies `notify`.
import type { WireApiMessage } from '../../client/client.ts'
import { renderBatch } from '../../client/render.ts'
import { BridgeBase, type BaseOptions } from '../../client/bridge-base.ts'

export { INSTRUCTIONS, type SendArgs } from '../../client/mcp.ts'

export interface BridgeOptions extends BaseOptions {
  /** Writes one channel notification; resolves when fully written to the transport. */
  notify: (params: { content: string; meta: Record<string, string> }) => Promise<void>
}

/** Wrapper Claude Code puts around a channel notification when it becomes a prompt (A2, §8.14). */
export const CHANNEL_WRAPPER = '<channel source="vortex"'

export class Bridge extends BridgeBase {
  /** True once the MCP `notifications/initialized` arrived (the only channel readiness signal a server can see). */
  initialized = false
  protected readonly host = 'claude' as const
  protected readonly wakeEvidence = 'transport-written' as const
  private heldWake: Array<{ batch: string; messages: WireApiMessage[]; notices: string[] }> = []
  /** Batch ids this binding delivered by channel (A2): a prompt naming one is channel-originated. */
  private channelBatches: string[] = []
  private readonly bopts: BridgeOptions

  constructor (opts: BridgeOptions) {
    super(opts, 'claude')
    this.bopts = opts
  }

  protected isMachineTurn (event: Record<string, unknown>): boolean {
    const prompt = typeof event.prompt === 'string' ? event.prompt : ''
    if (prompt.includes(CHANNEL_WRAPPER)) return true
    return this.channelBatches.some(id => prompt.includes(id))
  }

  protected async onWake (batch: string, messages: WireApiMessage[], notices: string[]): Promise<void> {
    if (!this.initialized) {
      this.heldWake.push({ batch, messages, notices })
      this.fail(batch, 'channels not enabled: MCP session is not initialized')
      return
    }
    await this.emitWake(batch, messages, notices)
  }

  /** Called when the MCP client sends `notifications/initialized`. */
  async markInitialized (): Promise<void> {
    this.initialized = true
    for (const h of this.heldWake.splice(0)) await this.emitWake(h.batch, h.messages, h.notices)
  }

  private async emitWake (batch: string, messages: WireApiMessage[], notices: string[]): Promise<void> {
    const first = messages[0]
    const scope = first?.scope ?? 'room'
    const content = renderBatch({ batch, scope, room: first?.room, notices, messages: this.toWire(messages) })
    const meta: Record<string, string> = scope === 'dm' ? { scope: 'dm' } : { room: first?.room ?? 'all' }
    // Recorded before the write: the resulting prompt can arrive before the write resolves.
    this.channelBatches.push(batch)
    if (this.channelBatches.length > 200) this.channelBatches = this.channelBatches.slice(-200)
    try {
      await this.bopts.notify({ content, meta })
    } catch (e) {
      this.fail(batch, `channel write failed: ${(e as Error).message}`)
      return
    }
    this.persist(batch)
    this.ack(batch, 'transport-written')
  }

  override status (): string {
    if (this.busy) return this.busyMessage()
    if (!this.initialized) return 'channels not enabled: MCP session is not initialized'
    return 'ok'
  }
}
