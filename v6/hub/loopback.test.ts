// A7 §1 (docs/v6-amendment-a7-remote-keys.md), landed ahead of the rest of A7:
// the plain listener is loopback-only, and it refuses requests forwarded by a
// tunnel or reverse proxy. The TLS listener is where remote traffic belongs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub, FORWARDING_HEADERS } from './main.ts'
import { parseHubConfig, isLoopbackHost, localHubUrl } from './config.ts'

test('A7 §1: listen must be a loopback address', () => {
  for (const ok of ['127.0.0.1:7900', '127.0.0.2:1', 'localhost:7900', '[::1]:7900', '7900']) {
    assert.doesNotThrow(() => parseHubConfig({ listen: ok }), ok)
  }
  for (const bad of [':7900', '0.0.0.0:7900', '192.0.2.5:7900', '100.64.0.1:7900', '[::]:7900', 'example.com:7900', '127.0.0.1.evil:7900']) {
    assert.throws(() => parseHubConfig({ listen: bad }), /loopback/, bad)
  }
  assert.equal(isLoopbackHost('LOCALHOST'), true)
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), false)
  assert.equal(isLoopbackHost('128.0.0.1'), false)
})

test('A7 §1: local clients get the address the hub bound, not a hardcoded 127.0.0.1', () => {
  assert.equal(localHubUrl('127.0.0.1:7900'), 'ws://127.0.0.1:7900')
  assert.equal(localHubUrl('127.0.0.2:7910'), 'ws://127.0.0.2:7910')
  assert.equal(localHubUrl('localhost:7900'), 'ws://localhost:7900')
  assert.equal(localHubUrl('[::1]:7900'), 'ws://[::1]:7900')
  assert.equal(localHubUrl('7900'), 'ws://127.0.0.1:7900')
})

test('A7 §1: startHub refuses a non-loopback listen passed programmatically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-loopback-'))
  try {
    await assert.rejects(startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '0.0.0.0:0' } }), /loopback/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('A7 §1: the loopback listener refuses forwarded requests; the TLS listener does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-forwarded-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  const quiet = console.error
  console.error = () => {}
  try {
    const token = (await Bun.file(join(dir, 'c', 'vortex', 'operator.json')).json()).token
    const auth = { authorization: `Bearer ${token}` }
    const plain = `http://127.0.0.1:${hub.port}`
    assert.equal((await fetch(`${plain}/v1/status`, { headers: auth })).status, 200)
    for (const h of FORWARDING_HEADERS) {
      const res = await fetch(`${plain}/v1/status`, { headers: { ...auth, [h]: '203.0.113.7' } })
      assert.equal(res.status, 421, h)
    }
    // A forwarded WebSocket upgrade is refused before authentication or upgrade.
    const up = await fetch(`${plain}/v1/bindings/default/stream`, {
      headers: { ...auth, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'x-forwarded-for': '203.0.113.7' },
    })
    assert.equal(up.status, 421)
    const viaTls = await fetch(`https://127.0.0.1:${hub.tlsPort}/v1/status`, {
      headers: { ...auth, 'x-forwarded-for': '203.0.113.7' },
      tls: { rejectUnauthorized: false },
    } as RequestInit)
    assert.equal(viaTls.status, 200, 'tunnels belong on the TLS listener')
  } finally {
    console.error = quiet
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
