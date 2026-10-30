// Hub HTTP + WebSocket API (docs/v6-proposal.md §8.3). All JSON, bearer auth.
// Status codes: 400 invalid fields, 403 unauthorized, 404 unknown/invisible
// resource, 413 raw or rendered-fit overflow (rejected before storage, §8.4),
// 429 rate limit, 4409 webSocket close for binding busy (§8.3).
import type { ServerWebSocket } from 'bun'
import type { HubStore, StoredMessage } from './store.ts'
import type { Delivery, Evidence, SocketLike } from './delivery.ts'
import type { HubConfig } from './config.ts'
import { PRINCIPAL_RE, ROOM_RE, BINDING_RE } from './config.ts'
import { fitSingle, type Bounds } from '../client/render.ts'

const EVIDENCE_KINDS: Evidence[] = ['host-accepted', 'transport-written', 'hook-returned']

export interface PostBody {
  scope?: 'room' | 'dm'
  room?: string
  to?: string[]
  text?: unknown
  reply_to?: string
  human_turn?: boolean
}

export interface HubServerDeps {
  cfg: HubConfig
  store: HubStore
  delivery: Delivery
  /** Test seam: disable the §8.5 send-rate limiter. */
  skipRateLimit?: boolean
}

export class ApiError extends Error {
  readonly status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class Api {
  private rateWindows = new Map<string, number[]>()
  readonly deps: HubServerDeps

  constructor (deps: HubServerDeps) {
    this.deps = deps
  }

  /** Test seam: clear the sliding send-rate windows. */
  resetRateLimits (): void { this.rateWindows = new Map() }

  private bounds (): Bounds {
    return {
      maxMessages: this.deps.cfg.batchMaxMessages,
      maxCodePoints: this.deps.cfg.batchMaxCodePoints,
      maxBytes: this.deps.cfg.batchMaxBytes,
    }
  }

  /** Returns Bun.serve-compatible fetch + websocket objects. */
  handlers () {
    const api = this
    return {
      fetch: (req: Request, server: any): Promise<Response | undefined> => this.fetch(req, server),
      websocket: {
        open (ws: ServerWebSocket<any>) { api.onOpen(ws) },
        message (ws: ServerWebSocket<any>, raw: string | Buffer) { api.onMessage(ws, raw) },
        close (ws: ServerWebSocket<any>) { api.onClose(ws) },
      },
    }
  }

  private authorized (req: Request): string | undefined {
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return undefined
    return this.deps.store.verifyToken(auth.slice(7))
  }

  private async fetch (req: Request, server: any): Promise<Response | undefined> {
    const url = new URL(req.url)
    const path = url.pathname
    const isUpgrade = path.startsWith('/v1/bindings/') && path.endsWith('/stream') && req.method === 'GET'
    if (isUpgrade) {
      const name = path.slice('/v1/bindings/'.length, -'/stream'.length)
      if (!BINDING_RE.test(name)) return new Response('bad binding name', { status: 400 })
      const principal = this.authorized(req)
      if (principal === undefined) return new Response('unauthorized', { status: 401 })
      if (!this.deps.store.getBinding(principal, name)) return new Response('unknown binding', { status: 404 })
      // Socket upgrade succeeded: the WS handlers below own the response.
      if (server.upgrade(req, { data: { principal, name } })) return undefined
      return new Response('upgrade failed', { status: 400 })
    }
    try {
      return await this.apiFetch(req, url, path)
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status)
      return json({ error: 'internal error' }, 500)
    }
  }

  private async apiFetch (req: Request, url: URL, path: string): Promise<Response> {
    const method = req.method
    if (method === 'POST' && path === '/v1/messages') return this.postMessages(req)
    if (method === 'PUT' && /^\/v1\/bindings\/[^/]+$/.test(path)) return this.putBinding(req, url, path.slice('/v1/bindings/'.length))
    if (method === 'DELETE' && /^\/v1\/bindings\/[^/]+\/[^/]+$/.test(path)) return this.deleteBinding(req, path)
    if (method === 'GET' && /^\/v1\/rooms\/[^/]+\/log$/.test(path)) return this.roomLog(req, url, path)
    if (method === 'GET' && path === '/v1/dms') return this.dmLog(req, url)
    if (method === 'GET' && path === '/v1/recent') return this.recent(req, url)
    if (method === 'GET' && path === '/v1/status') return this.status(req)
    return json({ error: 'not found' }, 404)
  }

  // ------------------------------------------------------------------
  // POST /v1/messages (§8.2, §8.3, §8.4, §8.5)
  // ------------------------------------------------------------------

  private async postMessages (req: Request): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    let body: PostBody
    try { body = await req.json() as PostBody } catch { return json({ error: 'invalid JSON body' }, 400) }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid body' }, 400)
    if (body.to !== undefined && !Array.isArray(body.to)) return json({ error: 'invalid to' }, 400)
    if ((body as any).from !== undefined) {
      // The sender comes from the bearer token; an identity field in the body
      // is refused so peer text can never impersonate (§8.3).
      return json({ error: 'sender identity is not client-supplied' }, 400)
    }
    if (typeof body.text !== 'string' || body.text.length === 0) return json({ error: 'text required' }, 400)
    const textBytes = new TextEncoder().encode(body.text).length
    if (textBytes > this.deps.cfg.bodyMaxBytes) return json({ error: `text exceeds ${this.deps.cfg.bodyMaxBytes} bytes` }, 413)
    const scope = body.scope === undefined ? 'room' : body.scope
    if (scope !== 'room' && scope !== 'dm') return json({ error: 'invalid scope' }, 400)
    let to = (body.to ?? []) as string[]
    const seen = new Set<string>()
    for (const t of to) {
      if (typeof t !== 'string' || !PRINCIPAL_RE.test(t)) return json({ error: `invalid recipient: ${String(t)}` }, 400)
      if (seen.has(t)) return json({ error: `duplicate recipient: ${t}` }, 400)
      seen.add(t)
      if (!this.deps.store.principalExists(t)) return json({ error: `unknown recipient: ${t}` }, 400)
    }
    if (to.length > this.deps.cfg.toMaxPrincipals) return json({ error: `at most ${this.deps.cfg.toMaxPrincipals} recipients` }, 400)
    let room: string | undefined
    if (scope === 'dm') {
      if (to.length !== 1) return json({ error: 'a DM requires exactly one recipient' }, 400)
      room = undefined
    } else {
      if (body.room !== undefined) {
        if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) return json({ error: 'invalid room' }, 400)
        room = body.room
      } else room = 'all'
    }
    let reply_to: string | undefined
    let human_turn = body.human_turn === true
    if (body.reply_to !== undefined) {
      if (typeof body.reply_to !== 'string') return json({ error: 'invalid reply_to' }, 400)
      const original = this.deps.store.getMessage(body.reply_to)
      if (original === undefined) return json({ error: 'reply_to not found' }, 404)
      if (!this.canRead(principal, original)) return json({ error: 'reply_to not readable' }, 403)
      if (original.scope === 'dm') {
        // A DM reply remains a DM to the original sender, never a broadcast (§8.3).
        if (scope !== 'dm') return json({ error: 'a DM reply must remain scope dm' }, 400)
        const other = original.from === principal ? original.to[0] : original.from
        if (to[0] !== other) return json({ error: `a DM reply must go to ${other}` }, 400)
      } else {
        if (scope === 'dm') {
          if (to[0] !== original.from) return json({ error: 'a DM reply to a room message must go to its author' }, 400)
        } else {
          if (room !== original.room) return json({ error: 'a room reply must stay in the original room' }, 400)
        }
      }
      reply_to = body.reply_to
    }
    if (this.deps.skipRateLimit !== true && !this.allowSend(principal)) return json({ error: 'send rate exceeded' }, 429)
    const human = principal === 'operator' ? true : human_turn
    // Pre-acceptance rendered fit check (§8.4): canonical labels + full batch
    // wrapper incl. the fixed peer-data line; 413 before storage/seq advance.
    const fit = fitSingle({ id: 'x', seq: 0, ts: 0, from: principal, scope, room, to, text: body.text, human }, this.bounds())
    if (!fit.fits) return json({ error: `rendered batch exceeds bounds (${fit.bytes} bytes / ${fit.codePoints} code points)` }, 413)
    const stored = this.deps.store.insertMessage({ from: principal, scope, room, to, text: body.text, reply_to, human })
    this.deps.delivery.onMessageStored(this.deps.store.getMessage(stored.id)!)
    return json({ id: stored.id, seq: stored.seq }, 200)
  }

  canRead (principal: string, m: StoredMessage): boolean {
    if (principal === 'operator') return true // explicit privileged access (§8.2)
    if (m.scope === 'dm') return m.from === principal || (m.to.length === 1 && m.to[0] === principal)
    return this.deps.store.isMember(m.room!, principal)
  }

  private allowSend (principal: string): boolean {
    const now = Date.now()
    const window = (this.rateWindows.get(principal) ?? []).filter(t => now - t < 60_000)
    if (window.length >= this.deps.cfg.sendPerMinute) {
      this.rateWindows.set(principal, window)
      return false
    }
    window.push(now)
    this.rateWindows.set(principal, window)
    return true
  }

  // ------------------------------------------------------------------
  // bindings (§8.3)
  // ------------------------------------------------------------------

  private async putBinding (req: Request, _url: URL, name: string): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    let body: { rooms?: unknown }
    try { body = await req.json() as { rooms?: unknown } } catch { return json({ error: 'invalid JSON body' }, 400) }
    if (!Array.isArray(body.rooms) || body.rooms.some(r => typeof r !== 'string')) return json({ error: 'rooms must be a string array' }, 400)
    try {
      const binding = this.deps.store.setBinding(principal, name, body.rooms as string[])
      return json({ ok: true, binding: { principal, name: binding.name, rooms: binding.rooms } }, 200)
    } catch (e) {
      return json({ error: (e as Error).message }, 400)
    }
  }

  private async deleteBinding (req: Request, path: string): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    const [, , , p, n] = path.split('/')
    if (p === undefined || n === undefined) return json({ error: 'bad path' }, 400)
    if (principal !== 'operator') return json({ error: 'only the operator may release bindings' }, 403)
    if (!this.deps.store.getBinding(p, n)) return json({ error: 'unknown binding' }, 404)
    this.deps.delivery.release(p, n)
    return json({ ok: true }, 200)
  }

  // ------------------------------------------------------------------
  // logs / recent (§8.3, A1)
  // ------------------------------------------------------------------

  private async roomLog (req: Request, url: URL, path: string): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    const room = path.slice('/v1/rooms/'.length, -'/log'.length)
    if (!ROOM_RE.test(room)) return json({ error: 'invalid room' }, 400)
    if (principal !== 'operator' && !this.deps.store.isMember(room, principal)) {
      // Membership exists; never confirm room contents to non-members.
      return json({ error: 'not a member of this room' }, 404)
    }
    const after = clampInt(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 0)
    const limit = clampInt(url.searchParams.get('limit'), 1, this.deps.cfg.logLimitMax, 100)
    const messages = this.deps.store.roomLog(room, after, limit)
    // Room logs never contain DMs; scope filter is structural in storage.
    return json({ messages: messages.filter(m => m.scope === 'room') }, 200)
  }

  private async dmLog (req: Request, url: URL): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    if (principal !== 'operator') return json({ error: 'only the operator may read assembled DM logs; peers read only their own DMs' }, 403)
    const after = clampInt(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 0)
    const limit = clampInt(url.searchParams.get('limit'), 1, this.deps.cfg.logLimitMax, 100)
    return json({ messages: this.deps.store.dmLogAll(after, limit) }, 200)
  }

  private async recent (req: Request, url: URL): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    const limit = clampInt(url.searchParams.get('limit'), 1, this.deps.cfg.logLimitMax, 200)
    // Visible to the caller: member rooms + own DMs (A1 /vx-recent source);
    // the operator reads everything (§8.2 operator sovereignty).
    const messages = principal === 'operator'
      ? this.deps.store.recentGlobal(limit)
      : this.deps.store.recentFor(principal, limit)
    return json({ messages }, 200)
  }

  private async status (req: Request): Promise<Response> {
    const principal = this.authorized(req)
    if (principal === undefined) return json({ error: 'unauthorized' }, 401)
    const operator = principal === 'operator'
    const bindings = this.deps.store.allBindings().filter(b => operator || b.principal === principal)
    const openStreams = this.deps.delivery.openStreams().filter(s => operator || s.principal === principal)
    const conversations = this.deps.store.pausedConversations().filter(c => operator || !c.conv.includes('|'))
    const payload = {
      seq: this.deps.store.seqHead(),
      bindings: bindings.map(b => {
        const counts = this.deps.store.pendingCountByKind(b.principal, b.name)
        return {
          principal: b.principal,
          name: b.name,
          rooms: b.rooms,
          pending: counts,
          waitingWake: this.deps.delivery.waitingWake(b.principal, b.name),
          open: openStreams.some(s => s.principal === b.principal && s.name === b.name),
          lastError: this.deps.delivery.lastError(b.principal, b.name),
        }
      }),
      streams: openStreams.length,
      pausedConversations: conversations,
    }
    return json(payload, 200)
  }

  // ------------------------------------------------------------------
  // websocket (§8.3): one open stream per binding; 4409 second stream
  // ------------------------------------------------------------------

  private onOpen (ws: ServerWebSocket): void {
    const data = ws.data as unknown as { principal: string; name: string }
    const socket = bunSocket(ws)
    if (this.deps.delivery.attach(socket, data.principal, data.name)) return
    ws.close(4409, 'binding busy')
  }

  private async onMessage (ws: ServerWebSocket, raw: string | Buffer): Promise<void> {
    const data = ws.data as unknown as { principal: string; name: string }
    let frame: any
    try { frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) } catch {
      ws.send(JSON.stringify({ type: 'error', reason: 'invalid JSON frame' }))
      return
    }
    const socket = bunSocket(ws)
    if (frame?.type === 'delivered') {
      if (typeof frame.batch !== 'string' || !EVIDENCE_KINDS.includes(frame.evidence)) {
        socket.send({ type: 'error', reason: 'delivered requires a batch id and an evidence kind (host-accepted | transport-written | hook-returned)' })
        return
      }
      this.deps.delivery.handleDelivered(socket, data.principal, data.name, frame.batch, frame.evidence)
      return
    }
    if (frame?.type === 'failed') {
      if (typeof frame.batch !== 'string' || typeof frame.reason !== 'string') {
        socket.send({ type: 'error', reason: 'failed requires a batch id and a reason' })
        return
      }
      this.deps.delivery.handleFailed(socket, data.principal, data.name, frame.batch, frame.reason)
      return
    }
    if (frame?.type === 'pull') {
      if (frame.kind !== 'passive') {
        socket.send({ type: 'error', reason: "pull kind must be 'passive'" })
        return
      }
      this.deps.delivery.handlePull(socket, data.principal, data.name)
      return
    }
    socket.send({ type: 'error', reason: 'unknown frame type: must be delivered | failed | pull' })
  }

  private onClose (ws: ServerWebSocket): void {
    const data = ws.data as unknown as { principal: string; name: string }
    this.deps.delivery.detach(bunSocket(ws), data.principal, data.name)
  }
}

/** Test-only rate-limit reset seam. */
function json (payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function clampInt (raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function bunSocket (ws: ServerWebSocket): SocketLike & { close: (code: number, reason: string) => void } {
  return {
    send: (frame) => { try { ws.send(JSON.stringify(frame)) } catch { /* socket closing */ } },
    close: (code, reason) => { try { ws.close(code, reason) } catch { /* already closed */ } },
  }
}
