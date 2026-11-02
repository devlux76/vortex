import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from './main.ts'
import { VortexClient } from '../client/client.ts'

async function setup () {
  const dir = mkdtempSync(join(tmpdir(), 'vx-own-dms-'))
  const hub = await startHub({ stateDir: join(dir, 'state'), configDir: join(dir, 'config'), cfg: { listen: '127.0.0.1:0' } })
  const tokens: Record<string, string> = {}
  for (const p of ['alice', 'bob', 'carol']) tokens[p] = hub.store.createPrincipal(p).token
  tokens.operator = (await Bun.file(join(dir, 'config', 'vortex', 'operator.json')).json()).token
  const base = `http://127.0.0.1:${hub.port}`
  const client = (p: string) => new VortexClient({ hub: `ws://127.0.0.1:${hub.port}`, token: tokens[p] })
  const get = (path: string, p?: string) => fetch(`${base}${path}`, { headers: p === undefined ? {} : { authorization: `Bearer ${tokens[p]}` } })
  return { hub, client, get, stop: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('own DM log returns only the authenticated caller’s incoming/outgoing DMs with ordered cursor pagination', async () => {
  const e = await setup()
  try {
    const first = await e.client('alice').send({ scope: 'dm', to: ['bob'], text: 'alice outgoing' })
    await e.client('carol').send({ scope: 'dm', to: ['bob'], text: 'unrelated secret' })
    const last = await e.client('bob').send({ scope: 'dm', to: ['alice'], text: 'alice incoming' })
    await e.client('alice').send({ text: 'room message' })
    const response = await e.get('/v1/dms/mine?principal=carol&limit=1', 'alice')
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).messages.map((m: any) => m.text), ['alice outgoing'])
    const next = await e.get(`/v1/dms/mine?after=${first.seq}&limit=20`, 'alice')
    assert.equal(next.status, 200)
    assert.deepEqual((await next.json()).messages.map((m: any) => [m.seq, m.text]), [[last.seq, 'alice incoming']])
  } finally { await e.stop() }
})

test('own DM log requires authentication and does not grant access to the operator’s assembled log', async () => {
  const e = await setup()
  try {
    await e.client('alice').send({ scope: 'dm', to: ['bob'], text: 'pair secret' })
    assert.equal((await e.get('/v1/dms/mine')).status, 401)
    assert.equal((await e.get('/v1/dms', 'alice')).status, 403)
    const own = await e.get('/v1/dms/mine', 'operator')
    assert.equal(own.status, 200)
    assert.deepEqual((await own.json()).messages, [], 'operator own endpoint is still own, not assembled')
    assert.equal((await e.get('/v1/dms', 'operator')).status, 200)
  } finally { await e.stop() }
})
