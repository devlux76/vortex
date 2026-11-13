// A7 §3 signed delivery streams: challenge-response over the hub's TLS
// WebSocket. Nothing is attached or delivered before a valid answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub, type HubHandles } from './main.ts'
import { enrollKey } from '../cli/keys.ts'
import { revokeKey } from './store-keys.ts'
import { generateEdgeKey } from '../client/edge.ts'
import { ALGS, AUTH_HEADER, STREAM_AUTH_HEADER, answerChallenge, signRequest, type KeyAlg } from '../client/edge-sign.ts'
import type { Custody } from './store-keys.ts'

interface Env { hub: HubHandles; operator: string; stop: () => Promise<void> }

async function setup (): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'vx-edge-stream-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0', wakeCoalesceMs: 0, wakeMinIntervalMs: 0 } })
  hub.api.streamAuthTimeoutMs = 300
  const operator = (await Bun.file(join(dir, 'c', 'vortex', 'operator.json')).json()).token
  return { hub, operator, stop: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

async function device (e: Env, principal: string, custody: Custody = 'hardware', alg: KeyAlg = 'ed25519') {
  const k = await generateEdgeKey(alg)
  const row = await enrollKey(e.hub.store, { principal, spkiB64: k.spkiB64, alg, custody, rooms: custody === 'unsealed' ? ['edge'] : null })
  const key = await crypto.subtle.importKey('jwk', k.jwk, ALGS[alg].importParams, false, ['sign'])
  const ids = { principal, key_id: row.key_id, hub: e.hub.fingerprint! }
  // Create the binding with a signed HTTP request (no bearer token exists for this principal).
  if (custody !== 'unsealed') {
    const body = new TextEncoder().encode(JSON.stringify({ rooms: ['all'] }))
    const res = await fetch(`https://127.0.0.1:${e.hub.tlsPort}/v1/bindings/default`, {
      method: 'PUT', headers: { [AUTH_HEADER]: await signRequest(key, alg, ids, 'PUT', '/v1/bindings/default', body), 'content-type': 'application/json' },
      body, tls: { rejectUnauthorized: false },
    } as RequestInit)
    assert.equal(res.status, 200, await res.text())
  }
  return { key, alg, ids, row }
}

interface Socket { ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }>; next: () => Promise<any> }

function connect (e: Env, header: string | undefined, extra: Record<string, string> = {}, port = e.hub.tlsPort!, scheme = 'wss'): Socket {
  const headers: Record<string, string> = { ...extra }
  if (header !== undefined) headers[STREAM_AUTH_HEADER] = header
  const ws = new WebSocket(`${scheme}://127.0.0.1:${port}/v1/bindings/default/stream`, { headers, tls: { rejectUnauthorized: false } } as any)
  const frames: any[] = []
  const waiters: Array<() => void> = []
  ws.onmessage = ev => { frames.push(JSON.parse(String(ev.data))); waiters.splice(0).forEach(w => w()) }
  const closed = new Promise<{ code: number; reason: string }>(r => { ws.onclose = ev => r({ code: ev.code, reason: ev.reason }) })
  let consumed = 0
  const next = async () => {
    const deadline = Date.now() + 3000
    while (frames.length <= consumed) {
      if (Date.now() > deadline) throw new Error('no frame')
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50) })
    }
    return frames[consumed++]
  }
  return { ws, frames, closed, next }
}

const opPost = (e: Env, body: unknown) => fetch(`http://127.0.0.1:${e.hub.port}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${e.operator}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('A7 §3: a signed stream answers the challenge, then receives batches like any binding', async () => {
  const e = await setup()
  try {
    for (const alg of ['ed25519', 'p256'] as const) {
      const d = await device(e, `winds-${alg}`, 'hardware', alg)
      const s = connect(e, `${d.ids.principal} ${d.ids.key_id}`)
      const challenge = await s.next()
      assert.equal(challenge.type, 'challenge')
      assert.equal(challenge.hub, e.hub.fingerprint)
      s.ws.send(JSON.stringify(await answerChallenge(d.key, d.alg, d.ids, 'default', challenge.nonce)))
      await new Promise(r => setTimeout(r, 100))
      assert.equal((await opPost(e, { to: [d.ids.principal], text: `wake ${alg}` })).status, 200)
      const batch = await s.next()
      assert.equal(batch.type, 'batch')
      assert.ok(batch.messages.some((m: any) => m.text === `wake ${alg}`))
      s.ws.close()
    }
  } finally { await e.stop() }
})

test('A7 §3: wrong answers, early frames, timeouts and replayed answers close with 4401 before anything is delivered', async () => {
  const e = await setup()
  try {
    const d = await device(e, 'winds')
    const header = `${d.ids.principal} ${d.ids.key_id}`
    // Signature for the wrong binding.
    let s = connect(e, header)
    let c = await s.next()
    s.ws.send(JSON.stringify(await answerChallenge(d.key, d.alg, d.ids, 'other', c.nonce)))
    assert.equal((await s.closed).code, 4401)
    // A delivery frame before authenticating.
    s = connect(e, header)
    await s.next()
    s.ws.send(JSON.stringify({ type: 'pull', kind: 'passive' }))
    assert.equal((await s.closed).code, 4401)
    // No answer at all.
    s = connect(e, header)
    await s.next()
    assert.match((await s.closed).reason, /timeout/)
    // An answer captured from one connection is useless on the next (fresh nonce).
    s = connect(e, header)
    c = await s.next()
    const captured = await answerChallenge(d.key, d.alg, d.ids, 'default', c.nonce)
    s.ws.close()
    s = connect(e, header)
    await s.next()
    s.ws.send(JSON.stringify(captured))
    assert.equal((await s.closed).code, 4401)
    // Stale timestamp.
    s = connect(e, header)
    c = await s.next()
    s.ws.send(JSON.stringify(await answerChallenge(d.key, d.alg, d.ids, 'default', c.nonce, Date.now() - 120_000)))
    assert.equal((await s.closed).code, 4401)
    // Revoked between upgrade and answer.
    s = connect(e, header)
    c = await s.next()
    revokeKey(e.hub.store, d.row.key_id)
    s.ws.send(JSON.stringify(await answerChallenge(d.key, d.alg, d.ids, 'default', c.nonce)))
    const closed = await s.closed
    assert.equal(closed.code, 4401)
    assert.match(closed.reason, /revoked/)
    assert.ok(s.frames.every(f => f.type === 'challenge'), 'only the challenge was ever sent')
  } finally { await e.stop() }
})

test('A7 §3: upgrade refusals — unsealed keys, unknown keys, mixed schemes, and the plaintext listener', async () => {
  const e = await setup()
  const quiet = console.error
  console.error = () => {}
  try {
    const u = await device(e, 'clouds', 'unsealed')
    const status = async (headers: Record<string, string>, port = e.hub.tlsPort!, scheme = 'https') => (await fetch(`${scheme}://127.0.0.1:${port}/v1/bindings/default/stream`, {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
      tls: { rejectUnauthorized: false },
    } as RequestInit)).status
    assert.equal(await status({ [STREAM_AUTH_HEADER]: `clouds ${u.row.key_id}` }), 403, 'unsealed keys hold no streams')
    assert.equal(await status({ [STREAM_AUTH_HEADER]: `clouds ${'0'.repeat(64)}` }), 401, 'unknown key')
    assert.equal(await status({ [STREAM_AUTH_HEADER]: 'clouds' }), 401, 'malformed header')
    assert.equal(await status({ [STREAM_AUTH_HEADER]: `clouds ${u.row.key_id}`, authorization: `Bearer ${e.operator}` }), 400, 'mixed schemes')
    assert.equal(await status({ [STREAM_AUTH_HEADER]: `clouds ${u.row.key_id}` }, e.hub.port, 'http'), 421, 'plaintext listener')
  } finally {
    console.error = quiet
    await e.stop()
  }
})
