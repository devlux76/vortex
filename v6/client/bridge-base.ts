// Delivery engine shared by the Claude and Codex plugins (§8.4, §8.6, §8.7):
// one hub stream per binding, passive batches offered to `vx hook context`
// over a per-binding unix socket, `vx_send`, accepted-id persistence, human-turn
// recording. Hosts supply only the wake path (`onWake`) and prompt classification.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { VortexClient, type Evidence, type WireApiMessage } from './client.ts'
import type { Credential } from './credential.ts'
import { measure, renderWrapped, type WireMessage } from './render.ts'
import { ensureRuntimeDir, socketPath, type HostName, type HookRequest, type HookResponse } from './hooksocket.ts'
import type { SendArgs } from './mcp.ts'

export interface BaseOptions {
  credential: Credential
  binding: string
  rooms?: string[]
  /** Where accepted batch ids persist across restarts (§8.4). */
  stateFile: string
  socketPath?: string
  /** Fault-fallback timeout for a passive pull (A2, default 300 ms); the hub normally answers `empty` at once. */
  pullWaitMs?: number
  /** How long a hook may take between receiving context and acknowledging. */
  hookAckMs?: number
}

export interface PassiveBatch { batch: string; messages: WireApiMessage[]; notices: string[] }

export abstract class BridgeBase {
  readonly client: VortexClient
  busy = false
  /** Passive pulls that hit the fault-fallback timeout (A2); also reported to the hub. */
  pullTimeouts = 0
  protected ws?: WebSocket
  protected closed = false
  protected humanTurn = false
  protected accepted: string[]
  private passive?: PassiveBatch
  private passiveInflight = new Set<string>()
  private passiveWaiters: Array<(why: 'batch' | 'empty') => void> = []
  private backoff = 500
  private server?: { stop: () => void }
  private reconnectTimer?: ReturnType<typeof setTimeout>
  readonly sockPath: string
  private ownsSocket = false

  protected abstract readonly host: HostName
  /** Evidence level recorded for a wake batch already accepted before a restart. */
  protected abstract readonly wakeEvidence: Evidence
  protected readonly opts: BaseOptions

  constructor (opts: BaseOptions, host: HostName) {
    this.opts = opts
    this.client = new VortexClient(opts.credential)
    this.sockPath = opts.socketPath ?? socketPath(opts.binding, host)
    this.accepted = this.loadAccepted()
  }

  /** The host's wake delivery for one wake batch. Must ack/fail through `ack`/`fail`. */
  protected abstract onWake (batch: string, messages: WireApiMessage[], notices: string[]): Promise<void>
  /** A `UserPromptSubmit` event that did not originate from the human (e.g. a channel/tool-output wake). */
  protected isMachineTurn (_event: Record<string, unknown>): boolean { return false }

  // ---- persistence of accepted batch ids (§8.4) ----------------------------

  private loadAccepted (): string[] {
    try { return JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as string[] } catch { return [] }
  }

  protected persist (batch: string): void {
    this.accepted.push(batch)
    if (this.accepted.length > 200) this.accepted = this.accepted.slice(-200)
    try {
      mkdirSync(this.opts.stateFile.replace(/\/[^/]*$/, ''), { recursive: true, mode: 0o700 })
      writeFileSync(this.opts.stateFile, JSON.stringify(this.accepted), { mode: 0o600 })
    } catch { /* best effort: a lost id can at worst redeliver (at-least-once) */ }
  }

  // ---- hub stream ------------------------------------------------------------

  async start (): Promise<void> {
    await this.client.bind(this.opts.binding, this.opts.rooms ?? ['all']).catch(() => {})
    await this.client.pin()
    this.connectStream()
    await this.listen()
  }

  private connectStream (): void {
    if (this.closed || this.busy) return
    const { ws } = this.client.stream(this.opts.binding, {
      onBatch: (batch, wake, messages, notices) => { void this.onBatch(batch, wake, messages, notices) },
      onEmpty: () => this.passiveWaiters.splice(0).forEach(w => w('empty')),
      onOpen: () => { this.backoff = 500 },
      onClose: ({ code }) => {
        if (this.ws === ws) this.ws = undefined
        if (code === 4409) { this.busy = true; return } // never steal: wait for the operator's release
        if (this.closed) return
        this.reconnectTimer = setTimeout(() => this.connectStream(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 30_000)
      },
    })
    this.ws = ws
  }

  protected toWire (m: WireApiMessage[]): WireMessage[] { return m as unknown as WireMessage[] }

  async onBatch (batch: string, wake: boolean, messages: WireApiMessage[], notices: string[]): Promise<void> {
    if (!wake) {
      // Passive mail is only ever offered to hooks; never a wake.
      if (this.accepted.includes(batch)) { this.ack(batch, 'hook-returned'); return }
      this.passive = { batch, messages, notices }
      this.passiveWaiters.splice(0).forEach(w => w('batch'))
      return
    }
    if (this.accepted.includes(batch)) { this.ack(batch, this.wakeEvidence); return }
    await this.onWake(batch, messages, notices)
  }

  protected ack (batch: string, evidence: Evidence): void {
    if (this.ws !== undefined && this.ws.readyState === 1) this.client.delivered(this.ws, batch, evidence)
  }

  protected fail (batch: string, reason: string): void {
    if (this.ws !== undefined && this.ws.readyState === 1) this.client.failed(this.ws, batch, reason)
  }

  // ---- model send ------------------------------------------------------------

  busyMessage (): string {
    return `binding busy (4409): another session already owns binding "${this.opts.binding}". ` +
      `This session will not take it over; the operator can run: vx binding release <principal>/${this.opts.binding}`
  }

  /** `vx_send`. The model controls only text/to/room/scope; identity and human_turn are never its to set. */
  async send (args: SendArgs): Promise<{ id: string }> {
    if (this.busy) throw new Error(this.busyMessage())
    const scope = args.scope ?? 'room'
    if (scope === 'dm' && (args.room !== undefined || args.to?.length !== 1)) {
      throw new Error('a DM needs scope "dm", exactly one recipient in `to`, and no room')
    }
    const human = this.humanTurn
    const res = await this.client.send({
      text: args.text,
      ...(args.scope === undefined ? {} : { scope: args.scope }),
      ...(args.room === undefined ? {} : { room: args.room }),
      ...(args.to === undefined || args.to.length === 0 ? {} : { to: args.to }),
      ...(human ? { human_turn: true as const } : {}),
    })
    if (human) this.humanTurn = false
    return { id: res.id }
  }

  // ---- hook socket -----------------------------------------------------------

  private async socketLive (): Promise<boolean> {
    if (!existsSync(this.sockPath)) return false
    return await new Promise<boolean>(resolve => {
      const s = connect(this.sockPath)
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
    })
  }

  private async listen (): Promise<void> {
    ensureRuntimeDir()
    if (await this.socketLive()) { this.busy = true; return } // another live server owns this binding
    try { unlinkSync(this.sockPath) } catch { /* absent */ }
    const bridge = this
    const listener = Bun.listen<{ buf: string; ack?: { batch: string; resolve: (v: boolean) => void } }>({
      unix: this.sockPath,
      socket: {
        open (sock) { sock.data = { buf: '' } },
        data (sock, chunk) {
          sock.data.buf += chunk.toString()
          let i: number
          while ((i = sock.data.buf.indexOf('\n')) >= 0) {
            const line = sock.data.buf.slice(0, i)
            sock.data.buf = sock.data.buf.slice(i + 1)
            void bridge.onHookLine(sock, line)
          }
        },
        close (sock) { sock.data?.ack?.resolve(false) },
        error () { /* closed by close() */ },
      },
    })
    this.ownsSocket = true
    this.server = listener
  }

  private async onHookLine (sock: { data: { ack?: { batch: string; resolve: (v: boolean) => void } }; write: (s: string) => unknown }, line: string): Promise<void> {
    const reply = (r: HookResponse): void => { sock.write(JSON.stringify(r) + '\n') }
    let req: HookRequest
    try { req = JSON.parse(line) as HookRequest } catch { reply({ ok: false, error: 'invalid request' }); return }
    if (req.op === 'context') {
      // Only the two natural-turn insertion points offer context; Stop or any other event acknowledges and offers nothing.
      const name = req.event?.hook_event_name
      if (name !== 'UserPromptSubmit' && name !== 'PostToolUse') { reply({ ok: true }); return }
      // §8.5: UserPromptSubmit records the human turn, unless it was a machine-originated prompt (A2).
      if (req.event?.hook_event_name === 'UserPromptSubmit' && !this.isMachineTurn(req.event)) this.humanTurn = true
      const offer = await this.offerPassive()
      if (offer === undefined) { reply({ ok: true }); return }
      const compose = {
        batch: offer.batch,
        scope: offer.messages[0]?.scope ?? 'room',
        room: offer.messages[0]?.room,
        notices: offer.notices,
        messages: this.toWire(offer.messages),
      }
      const context = renderWrapped(compose)
      const fits = measure(compose)
      if (!fits.fits) {
        this.passiveInflight.delete(offer.batch)
        this.fail(offer.batch, `rendered passive batch exceeds bounds (${fits.overflow})`)
        reply({ ok: true })
        return
      }
      const acked = new Promise<boolean>(resolve => { sock.data.ack = { batch: offer.batch, resolve } })
      reply({ ok: true, context, batch: offer.batch })
      const timer = setTimeout(() => sock.data.ack?.resolve(false), this.opts.hookAckMs ?? 10_000)
      const ok = await acked
      clearTimeout(timer)
      this.passiveInflight.delete(offer.batch)
      void ok // a missing acknowledgment simply leaves the batch pending
      return
    }
    if (req.op === 'ack') {
      const pending = sock.data.ack
      if (pending === undefined || pending.batch !== req.batch) { reply({ ok: false, error: 'no matching context offer' }); return }
      sock.data.ack = undefined
      this.persist(req.batch)
      if (this.passive?.batch === req.batch) this.passive = undefined
      this.ack(req.batch, 'hook-returned')
      pending.resolve(true)
      reply({ ok: true })
      return
    }
    reply({ ok: false, error: 'unknown op' })
  }

  /**
   * One bounded passive batch (§8.4): buffered replay, else a pull at this
   * natural-turn insertion point. The hub answers `empty` at once (A2); the
   * timeout is only a fault fallback and is reported to the hub for `vx status`.
   */
  private async offerPassive (): Promise<PassiveBatch | undefined> {
    if (this.busy) return undefined
    const take = (): PassiveBatch | undefined => {
      const p = this.passive
      if (p === undefined || this.passiveInflight.has(p.batch)) return undefined
      this.passiveInflight.add(p.batch)
      return p
    }
    const buffered = take()
    if (buffered !== undefined) return buffered
    if (this.passive !== undefined) return undefined // another hook holds it
    const ws = this.ws
    if (ws === undefined || ws.readyState !== 1) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const why = await new Promise<'batch' | 'empty' | 'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), this.opts.pullWaitMs ?? 300)
      this.passiveWaiters.push(w => resolve(w))
      this.client.pull(ws)
    })
    clearTimeout(timer)
    if (why === 'timeout') {
      this.pullTimeouts++
      this.client.fault(ws, `passive pull timed out after ${this.opts.pullWaitMs ?? 300} ms (hub did not answer)`)
    }
    return take()
  }

  // ---- status / lifecycle ----------------------------------------------------

  status (): string {
    if (this.busy) return this.busyMessage()
    return 'ok'
  }

  stop (): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    try { this.ws?.close() } catch { /* already closed */ }
    this.server?.stop()
    if (this.ownsSocket) { try { unlinkSync(this.sockPath) } catch { /* gone */ } }
  }
}
