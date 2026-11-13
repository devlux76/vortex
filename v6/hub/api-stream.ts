// Signed delivery streams (A7 §3), split out of api.ts. An upgrade carrying
// `VX-Stream-Auth: <principal> <key_id>` is checked against the key table,
// then the socket receives a one-time challenge bound to this hub and must
// answer it with a signature over (stream, principal, key, hub, nonce, ts,
// binding) within streamAuthTimeoutMs. Until then nothing is attached or
// delivered, and any other frame, a bad answer or the timeout closes with 4401.
import type { ServerWebSocket } from 'bun'
import type { Api } from './api.ts'
import { socketOf } from './api.ts'
import { EdgeAuthError } from './edge-auth.ts'
import { AUTH_HEADER, STREAM_AUTH_HEADER } from '../client/edge-sign.ts'
import { BINDING_RE, PRINCIPAL_RE } from './config.ts'

interface Pending { keyId: string; nonce: string; verifying: boolean; timer?: ReturnType<typeof setTimeout> }
interface StreamData { principal: string; name: string; pending?: Pending }

function json (payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

export function signedUpgrade (api: Api, req: Request, server: any, path: string): Response | undefined {
  if (req.headers.has('authorization') || req.headers.has(AUTH_HEADER)) return json({ error: 'one authentication scheme per request' }, 400)
  const name = path.slice('/v1/bindings/'.length, -'/stream'.length)
  if (!BINDING_RE.test(name)) return new Response('bad binding name', { status: 400 })
  const [principal, keyId, extra] = (req.headers.get(STREAM_AUTH_HEADER) ?? '').trim().split(' ')
  if (extra !== undefined || principal === undefined || keyId === undefined || !PRINCIPAL_RE.test(principal)) return json({ error: 'malformed VX-Stream-Auth header' }, 401)
  if (api.hubId === undefined) return json({ error: 'signed streams need the hub TLS listener' }, 401)
  let custody: string
  try { custody = api.edgeAuth.usableKey(principal, keyId).custody } catch (e) {
    if (e instanceof EdgeAuthError) return json({ error: e.message }, e.status)
    throw e
  }
  if (custody === 'unsealed') return json({ error: 'an unsealed key may not open delivery streams' }, 403)
  if (!api.deps.store.getBinding(principal, name)) return new Response('unknown binding', { status: 404 })
  const pending: Pending = { keyId, nonce: api.edgeAuth.challengeNonce(), verifying: false }
  if (server.upgrade(req, { data: { principal, name, pending } satisfies StreamData })) return undefined
  return new Response('upgrade failed', { status: 400 })
}

/** On open: sends the challenge and arms the timeout. True when the socket is a pending signed stream. */
export function openPendingStream (api: Api, ws: ServerWebSocket): boolean {
  const data = ws.data as unknown as StreamData
  if (data.pending === undefined) return false
  ws.send(JSON.stringify({ type: 'challenge', nonce: data.pending.nonce, hub: api.hubId }))
  data.pending.timer = setTimeout(() => ws.close(4401, 'authentication timeout'), api.streamAuthTimeoutMs)
  return true
}

/** Handles the one frame allowed before authentication. True when the frame was consumed here. */
export async function answerPendingStream (api: Api, ws: ServerWebSocket, raw: string | Buffer): Promise<boolean> {
  const data = ws.data as unknown as StreamData
  const p = data.pending
  if (p === undefined) return false
  if (p.verifying) { ws.close(4401, 'one authentication frame only'); return true }
  p.verifying = true
  try {
    const answer = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    await api.edgeAuth.verifyStream(data.principal, p.keyId, data.name, p.nonce, answer)
  } catch (e) {
    clearTimeout(p.timer)
    ws.close(4401, e instanceof EdgeAuthError ? e.message : 'authentication failed')
    return true
  }
  clearTimeout(p.timer)
  data.pending = undefined
  if (!api.deps.delivery.attach(socketOf(ws), data.principal, data.name)) ws.close(4409, 'binding busy')
  return true
}

/** On close: a pending stream was never attached, so there is nothing to detach. */
export function closePendingStream (ws: ServerWebSocket): boolean {
  const data = ws.data as unknown as StreamData
  if (data.pending === undefined) return false
  clearTimeout(data.pending.timer)
  return true
}
