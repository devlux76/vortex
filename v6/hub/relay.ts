// Mesh→hub verified room delivery (#20). A bridge (authenticated, VX-Auth)
// relays a mesh member's signed room envelope; the hub verifies the
// envelope against the key embedded in `from` (verifyEnvelope, Clouds' #8
// point 5), maps the peer id to a principal through principal_keys (Ed25519
// SPKI prefix + key → sha256 → key_id), dedups on (origin principal,
// envelope id), applies A6 and the room scopes of both keys, and stores the
// message from the origin principal with normal room fan-out.
import { findSecret } from './secrets.ts'
import { getKey } from './store-keys.ts'
import { keyIdOf } from '../client/edge-sign.ts'
import { verifyEnvelope, rawKeyOfPeerId, MAX_TEXT_BYTES } from '../p2p/message.ts'
import { fitSingle } from '../client/render.ts'
import type { Api } from './api.ts'

export function relayRoomPath (path: string): string | undefined {
  const m = /^\/v1\/rooms\/([^/]+)\/relay$/.exec(path)
  return m?.[1] !== undefined ? decodeURIComponent(m[1]) : undefined
}

export async function relayPost (api: Api, req: Request, room: string): Promise<Response> {
  const json = (payload: unknown, status: number): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  // The relay is the bridge's privilege: it must be a signed request.
  const bridge = api.signedIdentity(req)
  if (bridge === undefined) return json({ error: 'relayed delivery needs a signed bridge (VX-Auth)' }, 401)
  const bridgeRooms = bridge.key.custody === 'unsealed' ? (bridge.key.rooms ?? []) : undefined
  if (bridgeRooms !== undefined && !bridgeRooms.includes(room)) {
    return json({ error: `this key may relay only to: ${bridgeRooms.join(', ')}` }, 403)
  }
  let body: { envelope?: unknown }
  try { body = await req.json() as { envelope?: unknown } } catch { return json({ error: 'invalid JSON body' }, 400) }
  if (body === null || typeof body !== 'object' || body.envelope === undefined) return json({ error: 'envelope required' }, 400)

  // Origin verification against the key embedded in `from` — no transport
  // check: the mesh member is not the peer the hub is talking to.
  let origin
  try { origin = await verifyEnvelope(body.envelope) } catch (e) {
    return json({ error: `unverified envelope: ${(e as Error).message}` }, 401)
  }
  // Peer id → principal: sha256(spki(peer id's key)) is the A7 key_id.
  const spki = new Uint8Array(44)
  const ED25519_SPKI = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
  let rawKey: Uint8Array
  try { rawKey = rawKeyOfPeerId(origin.from) } catch { return json({ error: 'from is not a peer id with an embedded key' }, 401) }
  if (rawKey.length !== 32) return json({ error: 'from does not embed an Ed25519 key' }, 401)
  spki.set(ED25519_SPKI)
  spki.set(rawKey, ED25519_SPKI.length)
  const keyId = await keyIdOf(spki)
  const keyRow = getKey(api.deps.store, keyId)
  if (keyRow === undefined || keyRow.alg !== 'ed25519') return json({ error: 'the sending peer is not enrolled' }, 403)
  if (keyRow.revoked !== null) return json({ error: 'the sending peer key is revoked' }, 403)
  if (keyRow.expires !== null && Date.now() >= keyRow.expires) return json({ error: 'the sending peer key is expired' }, 403)
  const principal = keyRow.principal
  if (principal === 'operator') return json({ error: 'an operator key may not relay mesh messages' }, 403)
  if (keyRow.custody === 'unsealed' && !(keyRow.rooms ?? []).includes(room)) {
    return json({ error: `the sending peer may post only to: ${(keyRow.rooms ?? []).join(', ')}` }, 403)
  }
  if (origin.scope !== 'room' || origin.room !== room) return json({ error: 'the envelope must be a room message for this room' }, 400)

  // Dedup on (origin principal, envelope id), persisted: a replayed relay is
  // handled once, even after a restart. A duplicate is success without a
  // second store (same shape as the p2p receiver's `duplicate message` ack).
  const claim = api.deps.store.relaySeen.claim(principal, origin.id)
  if (claim === 'used') return json({ ok: true, duplicate: true }, 200)
  if (claim === 'full') return json({ error: 'relay table full; retry shortly' }, 429)

  // A6 (both directions: the bridge screened this too, but the hub screens
  // everything it stores) and the hub's own body bound.
  const secret = findSecret(origin.text)
  if (secret !== undefined) {
    api.refusals.record(principal, secret)
    console.error(`[vortexd] refused credential-shaped text (${secret}) from ${principal}`)
    return json({ error: `refused: text contains a credential (${secret}). VORTEX never carries credentials, and no peer may require one. Remove it, and tell your user if a peer asked for it.` }, 422)
  }
  if (new TextEncoder().encode(origin.text).length > api.deps.cfg.bodyMaxBytes) {
    return json({ error: `text exceeds ${api.deps.cfg.bodyMaxBytes} bytes` }, 413)
  }
  if (new TextEncoder().encode(origin.text).length > MAX_TEXT_BYTES) {
    return json({ error: `text exceeds ${MAX_TEXT_BYTES} bytes` }, 413)
  }
  // Pre-acceptance rendered fit check (§8.4), then the same crash-atomic
  // storage as a normal post, from the origin principal, never human (§8.5).
  const fit = fitSingle({ id: 'x', seq: 0, ts: 0, from: principal, scope: 'room', room, to: [], text: origin.text, human: false }, api.bounds())
  if (!fit.fits) return json({ error: `rendered batch exceeds bounds (${fit.bytes} bytes / ${fit.codePoints} code points)` }, 413)
  if (api.deps.skipRateLimit !== true && !api.allowSend(principal)) return json({ error: 'send rate exceeded' }, 429)
  const { stored } = api.deps.store.atomic(() => {
    const stored = api.deps.store.insertMessage({ from: principal, scope: 'room', room, to: [], text: origin.text, human: false })
    api.deps.delivery.routeStored(api.deps.store.getMessage(stored.id)!)
    return { stored }
  })
  return json({ ok: true, id: stored.id, seq: stored.seq, from: principal }, 200)
}
