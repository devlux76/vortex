// Per-room peer authorization for mesh delivery (#36, Sun's QA): the bridge
// asks the hub whether a discovered peer may receive a room's messages.
// The hub maps the peer id to its enrolled key (peer id → SPKI → sha256 →
// key_id → principal_keys, the same binding as the relay route in #20) and
// checks the key's room scope: an unsealed key only reaches its named rooms;
// a sealed key is authorized pending later wiring. Everything else — not
// enrolled, revoked, expired — is refused. Discovery alone must never grant
// room reads.
//
// The peer-id → SPKI derivation comes from v6/client/relay-envelope.ts
// (dependency-free; landed with #37), shared with the relay route.
import { spkiFromPeerId } from '../client/relay-envelope.ts'
import { keyIdOf } from '../client/edge-sign.ts'
import { getKey } from './store-keys.ts'
import type { HubStore } from './store.ts'
import type { Api } from './api.ts'

export async function peerAuthorized (store: HubStore, room: string, peerId: string): Promise<boolean> {
  let keyId: string
  try {
    keyId = await keyIdOf(spkiFromPeerId(peerId))
  } catch {
    return false // not an Ed25519 identity peer id
  }
  const row = getKey(store, keyId)
  if (row === undefined) return false
  if (row.revoked !== null) return false
  if (row.expires !== null && Date.now() >= row.expires) return false
  if (row.custody === 'unsealed') return (row.rooms ?? []).includes(room)
  return true
}

function json (payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** `GET /v1/rooms/:room/peer-authorized?peer=<peer-id>` — the bridge's per-room delivery check (#36). */
export async function peerAuthorizedRoute (api: Api, req: Request, url: URL, path: string): Promise<Response> {
  const bridge = api.signedIdentity(req)
  if (bridge === undefined) return json({ error: 'peer authorization needs a signed bridge (VX-Auth)' }, 401)
  const room = decodeURIComponent(path.slice('/v1/rooms/'.length, -'/peer-authorized'.length))
  if (bridge.key.custody === 'unsealed' && !(bridge.key.rooms ?? []).includes(room)) {
    return json({ error: `this key may query only: ${(bridge.key.rooms ?? []).join(', ')}` }, 403)
  }
  const peer = url.searchParams.get('peer')
  if (peer === null || peer === '') return json({ error: 'peer required' }, 400)
  return json({ authorized: await peerAuthorized(api.deps.store, room, peer) }, 200)
}
