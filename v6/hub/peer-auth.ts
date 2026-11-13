// Per-room peer authorization for mesh delivery (#36, Sun's QA): the bridge
// asks the hub whether a discovered peer may receive a room's messages.
// The hub maps the peer id to its enrolled key (peer id → SPKI → sha256 →
// key_id → principal_keys, the same binding as the relay route in #20) and
// checks the key's room scope: an unsealed key only reaches its named rooms;
// a sealed key is authorized pending later wiring. Everything else — not
// enrolled, revoked, expired — is refused. Discovery alone must never grant
// room reads.
//
// The peer-id → SPKI derivation is inlined here (base58btc identity
// multihash, zero dependencies) because this branch predates
// v6/client/relay-envelope.ts; it switches to that import when #37 lands.
import { keyIdOf } from '../client/edge-sign.ts'
import { getKey } from './store-keys.ts'
import type { HubStore } from './store.ts'
import type { Api } from './api.ts'

const ED25519_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function spkiFromPeerId (peerId: string): Uint8Array {
  const bytes: number[] = [0]
  for (const ch of peerId) {
    const v = B58.indexOf(ch)
    if (v < 0) throw new Error('not base58')
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  for (const ch of peerId) { if (ch !== '1') break; bytes.push(0) }
  const mh = new Uint8Array(bytes.reverse())
  if (mh.length !== 38 || mh[0] !== 0x00 || mh[1] !== 0x24 ||
    mh[2] !== 0x08 || mh[3] !== 0x01 || mh[4] !== 0x12 || mh[5] !== 0x20) {
    throw new Error('not an Ed25519 identity peer id')
  }
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32)
  spki.set(ED25519_SPKI_PREFIX)
  spki.set(mh.subarray(6), ED25519_SPKI_PREFIX.length)
  return spki
}

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
