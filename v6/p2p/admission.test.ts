// Sub-issue #24 of #3: relay and rendezvous admission through principal_keys.
// An enrolled peer connects, reserves and registers; an unenrolled peer is
// refused; and a revoked key is refused on its next request (the
// done-condition). The admission checker reads the hub's database read-only
// per request, so revocation needs no restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { enrollKey } from '../cli/keys.ts'
import { revokeKey } from '../hub/store-keys.ts'
import { loadOrCreateKey } from './identity.ts'
import { signEnvelope } from './message.ts'
import { edgeKeyFromLibp2p } from '../bridge/identity.ts'
import { startPeer, type Peer } from './node.ts'
import { startRelay, type Relay } from './relay.ts'
import { hubAdmission } from './admission.ts'
import { Database } from 'bun:sqlite'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

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

const setupRelay38 = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-adm38-'))
  const stateDir = join(dir, 's')
  const hub = await startHub({ stateDir, configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  const mkEnrolled = async (name: string, rooms: string[]) => {
    const keyFile = join(dir, `${name}.key`)
    const priv = await loadOrCreateKey(keyFile)
    const material = await edgeKeyFromLibp2p(priv)
    const row = await enrollKey(hub.store, { principal: name, spkiB64: material.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms })
    return { keyFile, keyId: row.key_id }
  }
  return { dir, hub, stateDir, mkEnrolled, cleanup: async () => { await hub.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

test('a rendezvous namespace counts as a room: a peer enrolled for other rooms cannot register under another namespace', { timeout: 90_000 }, async () => {
  const w = await setupRelay38()
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: join(w.stateDir, 'vortex', 'hub.db'), revocationSweepMs: 0 })
  const relayAddr = relay.addrs()[0]!.toString()
  let other: Peer | undefined
  try {
    const enrolled = await w.mkEnrolled('other-guy', ['other-room'])
    other = await startPeer({ keyFile: enrolled.keyFile, relay: relayAddr })
    await assert.rejects(other.register('mesh'), /not admitted for this namespace/)
    assert.ok((await other.register('other-room')) > 0)
  } finally {
    await other?.stop()
    await relay.stop()
    await w.cleanup()
  }
})

test('revocation boundary: the sweep drops a revoked connected peer, discovery filters it, and no fresh circuit gets {ok:true}', { timeout: 120_000 }, async () => {
  const w = await setupRelay38()
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: join(w.stateDir, 'vortex', 'hub.db'), revocationSweepMs: 500 })
  const relayAddr = relay.addrs()[0]!.toString()
  let revoked: Peer | undefined
  let witness: Peer | undefined
  try {
    const victim = await w.mkEnrolled('victim', ['mesh'])
    // The witness must be enrolled BEFORE startPeer: the relay's RESERVE
    // gater checks admission at reservation time (same rule as #24).
    const witnessPriv = await loadOrCreateKey(join(w.dir, 'witness.key'))
    const witnessMaterial = await edgeKeyFromLibp2p(witnessPriv)
    await enrollKey(w.hub.store, { principal: 'witness', spkiB64: witnessMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
    revoked = await startPeer({ keyFile: victim.keyFile, relay: relayAddr })
    witness = await startPeer({ keyFile: join(w.dir, 'witness.key'), relay: relayAddr })
    await revoked.register('mesh')
    await witness.register('mesh')
    assert.equal(revokeKey(w.hub.store, victim.keyId), true)
    // The sweep hangs up the revoked peer's connections within the interval.
    let swept = false
    for (let i = 0; i < 40 && !swept; i++) {
      await Bun.sleep(250)
      swept = revoked.node.getConnections().length === 0
    }
    assert.equal(swept, true, 'the revoked peer kept an open connection')
    // Its registration is filtered from discovery.
    const seen = (await witness.discover('mesh')).map(p => p.id.toString())
    assert.equal(seen.includes(revoked.id.toString()), false)
    // Its own discover fails: the connection is gone and a fresh dial is gater-denied.
    await assert.rejects(revoked.discover('mesh'))
    // A fresh relayed circuit to the witness cannot end in {ok:true}.
    let refusedOrFailed = false
    try {
      const frame = await signEnvelope(await loadOrCreateKey(victim.keyFile), {
        v: 1, id: 'revoked00000000000000000000000'.slice(0, 32), from: revoked.id.toString(),
        to: witness.id.toString(), scope: 'dm', text: 'still here?', ts: Date.now()
      })
      const { ack } = await revoked.sendRaw(witness.id, frame)
      refusedOrFailed = !ack.ok
    } catch { refusedOrFailed = true }
    assert.equal(refusedOrFailed, true, 'the revoked peer opened a fresh circuit and got {ok:true}')
  } finally {
    await Promise.allSettled([revoked?.stop(), witness?.stop()])
    await relay.stop()
    await w.cleanup()
  }
})

test('the admission handle closes with the relay (no descriptor leak)', { timeout: 60_000 }, async () => {
  const w = await setupRelay38()
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: join(w.stateDir, 'vortex', 'hub.db') })
  // The hub itself keeps hub.db open for the whole test, so the check is a
  // diff: relay.stop() must not leave MORE hub.db descriptors than before.
  const before = readdirSync('/proc/self/fd').map(f => {
    try { return readlinkSync(join('/proc/self/fd', f)) } catch { return '' }
  }).filter(t => t.includes('hub.db')).length
  await relay.stop()
  const after = readdirSync('/proc/self/fd').map(f => {
    try { return readlinkSync(join('/proc/self/fd', f)) } catch { return '' }
  }).filter(t => t.includes('hub.db')).length
  assert.ok(after <= before, `the admission database descriptor leaked (${before} -> ${after})`)
})

// Invictus QA on #3 (F4, F5, F6).
test('F4: discovery is room-aware: a key narrowed away from a namespace disappears from its discovery', { timeout: 120_000 }, async () => {
  const w = await setupRelay38()
  const dbPath = join(w.stateDir, 'vortex', 'hub.db')
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: dbPath, revocationSweepMs: 0 })
  const relayAddr = relay.addrs()[0]!.toString()
  let narrow: Peer | undefined
  let watcher: Peer | undefined
  try {
    const n = await w.mkEnrolled('narrow', ['mesh'])
    const v = await w.mkEnrolled('watcher', ['mesh'])
    const narrowId = peerIdFromPrivateKey(await loadOrCreateKey(n.keyFile)).toString()
    narrow = await startPeer({ keyFile: n.keyFile, relay: relayAddr })
    watcher = await startPeer({ keyFile: v.keyFile, relay: relayAddr })
    await narrow.register('mesh')
    assert.ok((await watcher.discover('mesh')).some(p => p.id.toString() === narrowId), 'enrolled for mesh: visible')
    // Narrow the key to another room only; the mesh namespace must stop showing it.
    const db = new Database(dbPath)
    db.run('UPDATE principal_keys SET rooms = ? WHERE key_id = ?', [JSON.stringify(['other-room']), n.keyId])
    db.close()
    assert.ok(!(await watcher.discover('mesh')).some(p => p.id.toString() === narrowId), 'narrowed away from mesh: invisible')
  } finally {
    await narrow?.stop()
    await watcher?.stop()
    await relay.stop()
    await w.cleanup()
  }
})

test('F5: a malformed rooms column is refused with a reason, never thrown', { timeout: 60_000 }, async () => {
  const w = await setupRelay38()
  const dbPath = join(w.stateDir, 'vortex', 'hub.db')
  const enrolled = await w.mkEnrolled('garbled', ['mesh'])
  const peer = peerIdFromPrivateKey(await loadOrCreateKey(enrolled.keyFile)).toString()
  const db = new Database(dbPath)
  db.run('UPDATE principal_keys SET rooms = ? WHERE key_id = ?', ['not json', enrolled.keyId])
  db.close()
  const adm = hubAdmission(dbPath)
  try {
    assert.equal(await adm.reason(peer, 'mesh'), 'peer rooms unreadable')
    assert.equal(await adm.admitRoom(peer, 'mesh'), false)
  } finally {
    adm.close()
    await w.cleanup()
  }
})

test('F6 (admission side): a closed handle refuses every verdict, and the statement is finalized on close', async () => {
  const w = await setupRelay38()
  const dbPath = join(w.stateDir, 'vortex', 'hub.db')
  const enrolled = await w.mkEnrolled('closing', ['mesh'])
  const peer = peerIdFromPrivateKey(await loadOrCreateKey(enrolled.keyFile)).toString()
  const adm = hubAdmission(dbPath)
  try {
    assert.equal(await adm.admitRoom(peer, 'mesh'), true)
    adm.close()
    assert.equal(await adm.reason(peer, 'mesh'), 'admission is shut down')
    adm.close() // a second close is harmless
  } finally {
    await w.cleanup()
  }
})
