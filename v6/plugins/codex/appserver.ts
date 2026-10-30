// Minimal JSON-RPC client for the running Codex app-server (docs/v6-proposal.md §6).
// Transport: stdio to `codex app-server proxy` (newline-delimited JSON, no
// "jsonrpc" field). The `initialize` request and `initialized` notification
// precede any other request. Event-driven: connects on first use, rejects every
// pending request when the proxy dies, reconnects on the next request.
export type AppServerErrorKind = 'rpc' | 'disconnect' | 'timeout' | 'spawn'

export class AppServerError extends Error {
  readonly kind: AppServerErrorKind
  constructor (kind: AppServerErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface AppServer {
  request (method: string, params: unknown): Promise<any>
  close (): void
}

/** Command that speaks app-server JSON-RPC on stdio. Override: VORTEX_CODEX_APPSERVER_CMD (JSON array). */
export function appServerCommand (): string[] {
  const override = process.env.VORTEX_CODEX_APPSERVER_CMD
  if (override !== undefined) {
    const parsed = JSON.parse(override)
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(a => typeof a !== 'string')) {
      throw new Error('VORTEX_CODEX_APPSERVER_CMD must be a JSON array of strings')
    }
    return parsed as string[]
  }
  return [process.env.CODEX_CLI_PATH ?? 'codex', 'app-server', 'proxy']
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class StdioAppServer implements AppServer {
  private proc?: ReturnType<typeof Bun.spawn>
  private connecting?: Promise<void>
  private pending = new Map<number, Pending>()
  private nextId = 1
  private readonly requestTimeoutMs: number
  private readonly command: () => string[]

  constructor (command: () => string[] = appServerCommand, requestTimeoutMs = 30_000) {
    this.command = command
    this.requestTimeoutMs = requestTimeoutMs
  }

  private write (obj: unknown): void {
    const stdin = this.proc!.stdin as any
    stdin.write(JSON.stringify(obj) + '\n')
    stdin.flush()
  }

  private dropConnection (reason: string): void {
    this.proc = undefined
    this.connecting = undefined
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new AppServerError('disconnect', reason))
      this.pending.delete(id)
    }
  }

  private async pump (proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    let buf = ''
    const dec = new TextDecoder()
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line.length > 0) this.onLine(proc, line)
        }
      }
    } catch { /* treated as disconnect below */ }
    if (this.proc === proc) this.dropConnection('app-server connection closed')
  }

  private onLine (proc: ReturnType<typeof Bun.spawn>, line: string): void {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    if (msg === null || typeof msg !== 'object') return
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (p === undefined) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error !== undefined) p.reject(new AppServerError('rpc', `${msg.error?.code ?? ''} ${msg.error?.message ?? 'error'}`.trim()))
      else p.resolve(msg.result)
      return
    }
    // A server-initiated request (approvals etc.) is not ours to answer.
    if (msg.id !== undefined && msg.method !== undefined && this.proc === proc) {
      this.write({ id: msg.id, error: { code: -32601, message: 'method not supported by the vortex client' } })
    }
  }

  private rawRequest (method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppServerError('timeout', `${method} got no response within ${this.requestTimeoutMs} ms`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new AppServerError('disconnect', (e as Error).message))
      }
    })
  }

  private connect (): Promise<void> {
    if (this.connecting !== undefined) return this.connecting
    const attempt = (async () => {
      let proc: ReturnType<typeof Bun.spawn>
      try {
        proc = Bun.spawn(this.command(), { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
      } catch (e) {
        throw new AppServerError('spawn', `cannot start the app-server proxy: ${(e as Error).message}`)
      }
      this.proc = proc
      void this.pump(proc)
      void proc.exited.then(() => { if (this.proc === proc) this.dropConnection('app-server proxy exited') })
      await this.rawRequest('initialize', {
        clientInfo: { name: 'vortex', title: 'VORTEX', version: '6.0.0' },
        capabilities: { experimentalApi: true },
      })
      this.write({ method: 'initialized' })
    })()
    this.connecting = attempt
    attempt.catch(() => { if (this.connecting === attempt) { this.connecting = undefined; try { this.proc?.kill() } catch { /* gone */ } this.proc = undefined } })
    return attempt
  }

  async request (method: string, params: unknown): Promise<any> {
    await this.connect()
    return await this.rawRequest(method, params)
  }

  close (): void {
    const proc = this.proc
    this.dropConnection('closed')
    try { proc?.kill() } catch { /* gone */ }
  }
}
