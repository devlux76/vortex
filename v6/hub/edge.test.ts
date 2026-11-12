// A7 §3–§4 (docs/v6-amendment-a7-remote-keys.md): signed HTTP edge requests on
// a real hub with its TLS listener. Enrollment moves only a public key; each
// request is signed and bound to this hub; unsealed keys stay in named rooms.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub, type HubHandles } from './main.ts'
import { enrollKey } from '../cli/keys.ts'
import { addKey, revokeKey } from './store-keys.ts'
import { EdgeClient, generateEdgeKey } from '../client/edge.ts'
import { ALGS, AUTH_HEADER, signRequest, type KeyAlg } from '../client/edge-sign.ts'

interface Env { hub: HubHandles; base: string; operator: string; stop: () => Promise<void> }

async function setup (tls = true): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'vx-edge-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', ...(tls ? { tlsListen: '127.0.0.1:0' } : {}) } })
  const operator = (await Bun.file(join(dir, 'c', 'vortex', 'operator.json')).json()).token
  return {
    hub, operator,
    base: tls ? `https://127.0.0.1:${hub.tlsPort}` : `http://127.0.0.1:${hub.port}`,
    stop: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }) },
  }
}

async function edgePeer (e: Env, opts: { principal?: string; alg?: KeyAlg; rooms?: string[] } = {}) {
  const alg = opts.alg ?? 'ed25519'
  const k = await generateEdgeKey(alg)
  const row = await enrollKey(e.hub.store, { principal: opts.principal ?? 'clouds', spkiB64: k.spkiB64, alg, custody: 'unsealed', rooms: opts.rooms ?? ['edge'] })
  const key = await crypto.subtle.importKey('jwk', k.jwk, ALGS[alg].importParams, false, ['sign'])
  const client = new EdgeClient({ url: e.base, principal: row.principal, keyId: row.key_id, hubId: e.hub.fingerprint ?? 'none', alg, key, insecureLoopback: true })
  return { client, key, row, alg }
}

/** A raw signed fetch, so tests can tamper with what was signed. */
async function raw (e: Env, p: Awaited<ReturnType<typeof edgePeer>>, o: { method?: string; path?: string; signBody?: string; sendBody?: string; now?: number; hub?: string; extra?: Record<string, string> } = {}) {
  const method = o.method ?? 'POST'
  const path = o.path ?? '/v1/messages'
  const signBody = o.signBody ?? JSON.stringify({ room: 'edge', text: 'hi' })
  const auth = await signRequest(p.key, p.alg, { principal: p.row.principal, key_id: p.row.key_id, hub: o.hub ?? e.hub.fingerprint! }, method, path, new TextEncoder().encode(signBody), o.now)
  const res = await fetch(`${e.base}${path}`, {
    method,
    headers: { [AUTH_HEADER]: auth, 'content-type': 'application/json', ...o.extra },
    body: method === 'GET' ? undefined : (o.sendBody ?? signBody),
    tls: { rejectUnauthorized: false },
  } as RequestInit)
  return { res, auth }
}

const opGet = (e: Env, path: string) => fetch(`http://127.0.0.1:${e.hub.port}${path}`, { headers: { authorization: `Bearer ${e.operator}` } }).then(r => r.json() as Promise<any>)

test('A7 §3: an enrolled edge key sends and reads over signed HTTPS; no bearer token exists for it', async () => {
  const e = await setup()
  try {
    for (const alg of ['ed25519', 'p256'] as const) {
      const p = await edgePeer(e, { principal: `edge-${alg}`, alg })
      const { id } = await p.client.send({ room: 'edge', text: `hello vortex from ${alg}` })
      const log = await p.client.roomLog('edge')
      assert.ok(log.some(m => m.id === id && m.from === `edge-${alg}` && m.human === false))
    }
    const all = await opGet(e, '/v1/rooms/edge/log')
    assert.deepEqual(all.messages.map((m: any) => m.text), ['hello vortex from ed25519', 'hello vortex from p256'])
  } finally { await e.stop() }
})

test('A7 §2: an unsealed key is held to its rooms, sends no DMs and opens no bindings', async () => {
  const e = await setup()
  try {
    const p = await edgePeer(e)
    await assert.rejects(p.client.send({ room: 'all', text: 'x' }), /403.*may post only to: edge/)
    await assert.rejects(p.client.request('POST', '/v1/messages', { scope: 'dm', to: ['operator'], text: 'x' }), /403.*DMs/)
    await assert.rejects(p.client.request('PUT', '/v1/bindings/default', { rooms: ['edge'] }), /403.*bindings/)
    // A model-driven edge client cannot claim a human turn (§8.5).
    await p.client.request('POST', '/v1/messages', { room: 'edge', text: 'claims human', human_turn: true })
    assert.equal((await p.client.roomLog('edge')).at(-1).human, false)
  } finally { await e.stop() }
})

test('A7 §3: tampering, replay, skew, a foreign hub id, revocation and expiry are all refused', async () => {
  const e = await setup()
  try {
    const p = await edgePeer(e)
    const ok = await raw(e, p)
    assert.equal(ok.res.status, 200)
    const replay = await fetch(`${e.base}/v1/messages`, { method: 'POST', headers: { [AUTH_HEADER]: ok.auth, 'content-type': 'application/json' }, body: JSON.stringify({ room: 'edge', text: 'hi' }), tls: { rejectUnauthorized: false } } as RequestInit)
    assert.equal(replay.status, 401, 'replayed header')
    assert.match((await replay.json()).error, /nonce/)
    assert.equal((await raw(e, p, { sendBody: JSON.stringify({ room: 'edge', text: 'changed' }) })).res.status, 401, 'body altered after signing')
    assert.equal((await raw(e, p, { now: Date.now() - 120_000 })).res.status, 401, 'stale timestamp')
    assert.equal((await raw(e, p, { hub: 'f'.repeat(64) })).res.status, 401, 'signed for another hub')
    assert.equal((await raw(e, p, { extra: { authorization: `Bearer ${e.operator}` } })).res.status, 400, 'both schemes')
    const up = await raw(e, p, { method: 'GET', path: '/v1/bindings/default/stream', extra: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
    assert.equal(up.res.status, 401, 'signed stream auth is not built yet')
    // Another principal cannot use this key id.
    const other = { ...p, row: { ...p.row, principal: 'winds' } }
    assert.equal((await raw(e, other)).res.status, 401, 'key owned by someone else')
    assert.ok(revokeKey(e.hub.store, p.row.key_id))
    assert.match((await (await raw(e, p)).res.json()).error, /revoked/)
    const q = await edgePeer(e, { principal: 'clouds-2' })
    e.hub.store.db.prepare('UPDATE principal_keys SET expires = ? WHERE key_id = ?').run(Date.now() - 1, q.row.key_id)
    assert.match((await (await raw(e, q)).res.json()).error, /expired/)
    const status = JSON.stringify(await opGet(e, '/v1/status'))
    assert.ok(!status.includes(ok.auth.split(' ')[4]), 'status never shows signatures')
  } finally { await e.stop() }
})

test('A7 §4: enrollment validates the key and the unsealed limits', async () => {
  const e = await setup()
  try {
    const k = await generateEdgeKey()
    await assert.rejects(enrollKey(e.hub.store, { principal: 'x', spkiB64: 'AAAA', alg: 'ed25519', custody: 'unsealed', rooms: ['edge'] }), /SubjectPublicKeyInfo/)
    await assert.rejects(enrollKey(e.hub.store, { principal: 'x', spkiB64: k.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: null }), /named rooms/)
    await assert.rejects(enrollKey(e.hub.store, { principal: 'x', spkiB64: k.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['edge'], ttlHours: 200 }), /168 hours/)
    await assert.rejects(enrollKey(e.hub.store, { principal: 'operator', spkiB64: k.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['edge'] }), /operator/)
    assert.throws(() => addKey(e.hub.store, { key_id: 'a'.repeat(64), principal: 'x', alg: 'ed25519', spki: k.spkiB64, custody: 'unsealed', rooms: ['edge'], expires: null }), /7 days/)
    const row = await enrollKey(e.hub.store, { principal: 'x', spkiB64: k.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['edge'] })
    assert.equal(row.key_id, k.keyId, 'key id is the SHA-256 of the SPKI on both sides')
    assert.ok(row.expires !== null && row.expires - Date.now() <= 24 * 3_600_000 + 1000, 'unsealed default lifetime is 24 h')
  } finally { await e.stop() }
})

test('A7 §3: without a TLS listener there is no hub id and signed requests are refused', async () => {
  const e = await setup(false)
  try {
    const p = await edgePeer(e)
    const res = await fetch(`${e.base}/v1/messages`, { method: 'POST', headers: { [AUTH_HEADER]: 'x', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(res.status, 401)
    assert.match((await res.json()).error, /TLS listener/)
    assert.equal(p.row.custody, 'unsealed')
  } finally { await e.stop() }
})
