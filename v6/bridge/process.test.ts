// Sub-issue #13 of #3: the bridge process starts and stops cleanly, on a real
// TLS hub and a real relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { enrollKey } from '../cli/keys.ts'
import { generateEdgeKey, writeKeyFile } from '../client/edge.ts'
import { startRelay } from '../p2p/relay.ts'
import { startBridge, type BridgeOptions } from './process.ts'

async function hubKeyOn (hub: Awaited<ReturnType<typeof startHub>>, dir: string): Promise<BridgeOptions> {
  // Enroll the bridge's hub key (public key only moves) and write the key file.
  const k = await generateEdgeKey('ed25519')
  const row = await enrollKey(hub.store, { principal: 'bridge', spkiB64: k.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
  const hubKeyFile = join(dir, 'bridge.hub-key.json')
  writeKeyFile(hubKeyFile, {
    v: 1, principal: 'bridge', alg: 'ed25519', key_id: row.key_id, custody: 'unsealed',
    hub_url: `https://127.0.0.1:${hub.tlsPort}`, hub_id: hub.fingerprint!, jwk: k.jwk
  })
  return {
    keyFile: join(dir, 'bridge.key'),
    relay: '',
    hubKeyFile,
    insecureLoopback: true
  }
}

test('bridge #13: starts holding a hub principal and a libp2p peer, stops cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-bridge-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] })
  try {
    const base = await hubKeyOn(hub, dir)
    const bridge = await startBridge({ ...base, relay: relay.addrs()[0]!.toString() })
    assert.ok(bridge.peer.id.toString().length > 20)
    // The mesh half holds its circuit reservation.
    assert.ok(bridge.peer.node.getMultiaddrs().some(a => a.toString().includes('/p2p-circuit')))
    // The hub half is the enrolled principal; the signed handshake went through
    // the TLS listener with this hub's fingerprint (startBridge throws otherwise).
    assert.equal(bridge.edge.opts.principal, 'bridge')

    await bridge.stop()
    // Stopping twice is safe (idempotent lifecycle).
    await assert.doesNotReject(bridge.stop())
    // The mesh half is down; the hub half is stateless.
    assert.notEqual(bridge.peer.node.status, 'running')
  } finally {
    await relay.stop()
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge #13: a wrong hub id fails the signed handshake at start, before anything runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-bridge-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] })
  try {
    const base = await hubKeyOn(hub, dir)
    // A key file pointing at a different hub id: the hub refuses the signature
    // (401), so the bridge never starts its mesh half.
    await assert.rejects(
      startBridge({ ...base, relay: relay.addrs()[0]!.toString(), hubId: 'deadbeef' }),
      /401/
    )
  } finally {
    await relay.stop()
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
