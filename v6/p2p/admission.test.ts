// Sub-issue #24 of #3: relay and rendezvous admission through principal_keys.
// An enrolled peer connects, reserves and registers; an unenrolled peer is
// refused; and a revoked key is refused on its next request (the
// done-condition). The admission checker reads the hub's database read-only
// per request, so revocation needs no restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { enrollKey } from '../cli/keys.ts'
import { revokeKey } from '../hub/store-keys.ts'
import { loadOrCreateKey } from './identity.ts'
import { startPeer, type Peer } from './node.ts'
import { startRelay, type Relay } from './relay.ts'
import { edgeKeyFromLibp2p } from '../bridge/identity.ts'

test('#24: admission gates the relay and rendezvous through principal_keys, and revocation lands on the next request', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-admission-'))
  const stateDir = join(dir, 's')
  const hub = await startHub({ stateDir, configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  // The relay reads the hub's own database read-only
  // (stateDir()/vortex/hub.db per hubRoots()).
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: join(stateDir, 'vortex', 'hub.db') })
  const relayAddr = relay.addrs()[0]!.toString()

  const mkPeer = async (name: string): Promise<{ peer: Peer, keyId: string }> => {
    const keyFile = join(dir, `${name}.key`)
    const priv = await loadOrCreateKey(keyFile)
    const material = await edgeKeyFromLibp2p(priv)
    const row = await enrollKey(hub.store, { principal: name, spkiB64: material.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
    const peer = await startPeer({ keyFile, relay: relayAddr })
    return { peer, keyId: row.key_id }
  }

  let enrolled: Peer | undefined
  try {
    // An enrolled peer: connects, holds a reservation, registers.
    const a = await mkPeer('mesh-a')
    enrolled = a.peer
    assert.ok(a.peer.node.getMultiaddrs().some(addr => addr.toString().includes('/p2p-circuit')))
    assert.ok((await a.peer.register('mesh')) > 0)

    // An unenrolled peer is refused outright.
    const strangerKeyFile = join(dir, 'stranger.key')
    await loadOrCreateKey(strangerKeyFile)
    await assert.rejects(
      startPeer({ keyFile: strangerKeyFile, relay: relayAddr, timeoutMs: 4000 }),
      /reservation/
    )

    // The done-condition: a revoked key is refused on its next request.
    assert.equal(revokeKey(hub.store, a.keyId), true)
    await assert.rejects(a.peer.register('mesh2'), /register refused/)
    // And a fresh connection for the same identity is denied: no new
    // reservation after revocation.
    await a.peer.stop()
    await assert.rejects(
      startPeer({ keyFile: join(dir, 'mesh-a.key'), relay: relayAddr, timeoutMs: 4000 }),
      /reservation/
    )

    // An expired key is refused too: backdate the row and reconnect.
    const b = await mkPeer('mesh-b')
    hub.store.db.prepare('UPDATE principal_keys SET expires = ? WHERE key_id = ?').run(Date.now() - 1000, b.keyId)
    await b.peer.stop()
    await assert.rejects(
      startPeer({ keyFile: join(dir, 'mesh-b.key'), relay: relayAddr, timeoutMs: 4000 }),
      /reservation/
    )
  } finally {
    await enrolled?.stop()
    await relay.stop()
    await hub.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
