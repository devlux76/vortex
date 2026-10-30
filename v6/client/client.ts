// Shared v6 client (§3: "All three use the same ~100-line client"); used by
// the `vx` CLI and every plugin. HTTP JSON + one WebSocket stream per binding,
// TLS pinned by the fingerprint printed at enrollment (§8.2).
import type { Credential } from './credential.ts'

export interface VortexMessage {
  text: string
  to?: string[]
  room?: string
  scope?: 'room' | 'dm'
  reply_to?: string
  human_turn?: true
}

export interface WireApiMessage {
  id: string
  seq: number
  ts: number
  scope: 'room' | 'dm'
  room?: string
  to: string[]
  from: string
  text: string
  reply_to?: string
  human: boolean
  reply_author?: string
  reply_ts?: number
}

export interface BatchEvent {
  type: 'batch'
  batch: string
  wake: boolean
  messages: WireApiMessage[]
}

export type StreamFrame = BatchEvent | { type: 'error'; reason: string; batch?: string }

export type Evidence = 'host-accepted' | 'transport-written' | 'hook-returned'

export interface StreamHandlers {
  onBatch: (batch: string, wake: boolean, messages: WireApiMessage[]) => void
  onError?: (reason: string, batch: string | undefined) => void
  onOpen?: () => void
  onClose?: (event: { code: number; reason: string }) => void
}

function pinnedTls (fingerprint: string | undefined) {
  if (fingerprint === undefined) return undefined
  const pin = fingerprint.toLowerCase().replace(/:/g, '')
  return {
    // The hub presents its self-signed cert; the pin is the whole identity.
    rejectUnauthorized: false,
    checkServerIdentity: (_host: string, cert: { raw: Uint8Array }) => {
      const digest = new Bun.CryptoHasher('sha256')
      digest.update(new Uint8Array(cert.raw))
      if (digest.digest('hex') !== pin) {
        return new Error('vortex: TLS fingerprint pin mismatch')
      }
      return undefined
    },
  } as const
}

export class VortexClient {
  private cfg: Credential
  constructor (cfg: Credential) { this.cfg = cfg }

  private httpBase (): string {
    return this.cfg.hub.replace(/^ws/, 'http')
  }

  private req (method: string, path: string, body?: unknown): Promise<Response> {
    const tls = pinnedTls(this.cfg.fingerprint) as any
    return fetch(`${this.httpBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(tls === undefined ? {} : { tls }),
    })
  }

  async send (msg: VortexMessage): Promise<{ id: string; seq: number }> {
    const res = await this.req('POST', '/v1/messages', msg)
    return await expectJson(res, 200)
  }

  async bind (binding: string, rooms: string[]): Promise<{ ok: boolean }> {
    const res = await this.req('PUT', `/v1/bindings/${encodeURIComponent(binding)}`, { rooms })
    return await expectJson(res, 200)
  }

  async status (): Promise<any> {
    return await expectJson(await this.req('GET', '/v1/status'), 200)
  }

  async roomLog (room: string, after = 0, limit = 100): Promise<{ messages: WireApiMessage[] }> {
    return await expectJson(await this.req('GET', `/v1/rooms/${encodeURIComponent(room)}/log?after=${after}&limit=${limit}`), 200)
  }

  async dmLog (after = 0, limit = 100): Promise<{ messages: WireApiMessage[] }> {
    return await expectJson(await this.req('GET', `/v1/dms?after=${after}&limit=${limit}`), 200)
  }

  async recent (limit = 200): Promise<{ messages: WireApiMessage[] }> {
    return await expectJson(await this.req('GET', `/v1/recent?limit=${limit}`), 200)
  }

  async release (principal: string, name: string): Promise<{ ok: boolean }> {
    return await expectJson(await this.req('DELETE', `/v1/bindings/${encodeURIComponent(principal)}/${encodeURIComponent(name)}`), 200)
  }

  /** One WebSocket stream per binding (§8.3); returns the live socket handle. */
  stream (binding: string, handlers: StreamHandlers): { ws: WebSocket } {
    const tls = pinnedTls(this.cfg.fingerprint)
    const headers = { authorization: `Bearer ${this.cfg.token}` }
    const url = `${this.cfg.hub}/v1/bindings/${encodeURIComponent(binding)}/stream`
    const ws = new WebSocket(url, {
      headers,
      ...(tls === undefined ? {} : { tls }),
    } as any) as any
    ws.addEventListener('open', () => handlers.onOpen?.())
    ws.addEventListener('message', (event: MessageEvent) => {
      let frame: StreamFrame
      try { frame = JSON.parse(String(event.data)) as StreamFrame } catch { return }
      if (frame.type === 'batch') handlers.onBatch(frame.batch, frame.wake, frame.messages)
      else if (frame.type === 'error') {
        if (handlers.onError !== undefined) handlers.onError(frame.reason, frame.batch)
      }
    })
    ws.addEventListener('close', (event: CloseEvent) => handlers.onClose?.({ code: event.code, reason: event.reason }))
    ws.addEventListener('error', () => { /* surfaced by close */ })
    return { ws }
  }

  delivered (ws: WebSocket, batch: string, evidence: Evidence): void {
    ws.send(JSON.stringify({ type: 'delivered', batch, evidence }))
  }

  failed (ws: WebSocket, batch: string, reason: string): void {
    ws.send(JSON.stringify({ type: 'failed', batch, reason }))
  }

  pull (ws: WebSocket): void {
    ws.send(JSON.stringify({ type: 'pull', kind: 'passive' }))
  }
}

async function expectJson (res: Response, status: number): Promise<any> {
  const payload = await res.json().catch(() => undefined)
  if (res.status !== status) {
    const detail = payload?.error ?? res.statusText
    const err = new Error(`vortex hub ${res.status}: ${detail}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return payload
}
