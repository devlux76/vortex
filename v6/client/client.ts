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
  /** One-line [vx: ...] notices that render above the messages. */
  notices?: string[]
}

export type StreamFrame = BatchEvent | { type: 'error'; reason: string; batch?: string }

export type Evidence = 'host-accepted' | 'transport-written' | 'hook-returned'

export interface StreamHandlers {
  onBatch: (batch: string, wake: boolean, messages: WireApiMessage[], notices: string[]) => void
  onError?: (reason: string, batch: string | undefined) => void
  onOpen?: () => void
  onClose?: (event: { code: number; reason: string }) => void
}

/**
 * TLS pinning (§8.2). Bun ignores checkServerIdentity unless the chain
 * verifies, so: probe the hub once, require the presented certificate's
 * SHA-256 to equal the pin, then trust exactly that certificate as the CA and
 * re-check the digest in checkServerIdentity on every real connection (no gap
 * for a different certificate to appear later). Hostname/SAN is not the
 * identity; the pin is.
 */
function derDigest (raw: Uint8Array): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(raw)
  return h.digest('hex')
}

async function pinnedTls (hub: string, fingerprint: string): Promise<Record<string, unknown>> {
  const pin = fingerprint.toLowerCase().replace(/:/g, '')
  const url = new URL(hub.replace(/^ws/, 'http'))
  const port = Number(url.port || 443)
  const { connect } = await import('node:tls')
  const raw: Uint8Array = await new Promise((resolve, reject) => {
    const sock = connect({ host: url.hostname, port, rejectUnauthorized: false }, () => {
      const der = sock.getPeerCertificate(true)?.raw
      sock.destroy()
      if (der === undefined) reject(new Error('vortex: hub presented no TLS certificate'))
      else resolve(new Uint8Array(der))
    })
    sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error('vortex: TLS probe timed out')) })
    sock.on('error', reject)
  })
  if (derDigest(raw) !== pin) throw new Error('vortex: TLS fingerprint pin mismatch')
  const b64 = Buffer.from(raw).toString('base64').match(/.{1,64}/g)!.join('\n')
  return {
    ca: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    checkServerIdentity: (_host: string, cert: { raw: Uint8Array }) =>
      derDigest(new Uint8Array(cert.raw)) === pin ? undefined : new Error('vortex: TLS fingerprint pin mismatch'),
  }
}

export class VortexClient {
  private cfg: Credential
  private tlsOptions?: Record<string, unknown>
  constructor (cfg: Credential) { this.cfg = cfg }

  /**
   * Resolve and verify the pinned TLS options (no-op without a fingerprint).
   * Every HTTP call does this implicitly; call it once before `stream()` on a
   * pinned hub, because the WebSocket constructor cannot await.
   */
  async pin (): Promise<void> {
    if (this.cfg.fingerprint === undefined || this.tlsOptions !== undefined) return
    this.tlsOptions = await pinnedTls(this.cfg.hub, this.cfg.fingerprint)
  }

  private httpBase (): string {
    return this.cfg.hub.replace(/^ws/, 'http')
  }

  private async req (method: string, path: string, body?: unknown): Promise<Response> {
    await this.pin()
    const tls = this.tlsOptions
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
    if (this.cfg.fingerprint !== undefined && this.tlsOptions === undefined) {
      throw new Error('vortex: pinned hub requires `await client.pin()` before stream()')
    }
    const tls = this.tlsOptions
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
      if (frame.type === 'batch') handlers.onBatch(frame.batch, frame.wake, frame.messages, frame.notices ?? [])
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
