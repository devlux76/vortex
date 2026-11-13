// Sub-issue #20 of #3: mesh→hub verified room delivery. A mesh member's
// signed room envelope reaches the hub as a message from the member's
// principal, verified against the key embedded in the envelope's `from`,
// deduplicated on (principal, id), A6-screened in both the bridge and the
// hub, with room scope enforced on both keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { enrollKey } from '../cli/keys.ts'
import { EdgeClient } from '../client/edge.ts'
import { loadOrCreateKey } from '../p2p/identity.ts'
import { signEnvelope } from '../p2p/message.ts'
import { startRelay } from '../p2p/relay.ts'
import { startPeer } from '../p2p/node.ts'
import { startBridge, type Bridge } from './process.ts'
import { edgeKeyFromLibp2p } from './identity.ts'
import { meshIngest, type IngestStats } from './receive.ts'

async function world () {
  const dir = mkdtempSync(join(tmpdir(), 'vx-meshhub-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] })
  const relayAddr = relay.addrs()[0]!.toString()

  // The bridge's key and principal: its libp2p key is its A7 key (#11).
  const bridgeKeyFile = join(dir, 'bridge.key')
  const bridgePriv = await loadOrCreateKey(bridgeKeyFile)
  const bridgeMaterial = await edgeKeyFromLibp2p(bridgePriv)
  const bridgeRow = await enrollKey(hub.store, { principal: 'bridge', spkiB64: bridgeMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
  const edge = new EdgeClient({
    url: `https://127.0.0.1:${hub.tlsPort}`, principal: 'bridge', keyId: bridgeRow.key_id, hubId: hub.fingerprint!,
    alg: 'ed25519', key: await crypto.subtle.importKey('jwk', bridgeMaterial.jwk, { name: 'Ed25519' }, false, ['sign']),
    insecureLoopback: true
  })

  // The mesh member's key and principal (the same identity system).
  const memberKeyFile = join(dir, 'member.key')
  const memberPriv = await loadOrCreateKey(memberKeyFile)
  const memberMaterial = await edgeKeyFromLibp2p(memberPriv)
  const memberRow = await enrollKey(hub.store, { principal: 'mesher', spkiB64: memberMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })

  const bridgeOpts = { keyFile: bridgeKeyFile, relay: relayAddr, hubKeyFile: '', edge, insecureLoopback: true }
  const cleanup = async (): Promise<void> => { await relay.stop(); await hub.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { dir, hub, relayAddr, bridgeOpts, memberKeyFile, memberPriv, memberPrincipal: memberRow.principal, cleanup }
}

test('#20: a mesh member\'s signed envelope reaches the hub from its principal, once; A6 and room scope hold', { timeout: 120_000 }, async () => {
  const w = await world()
  let bridge: Bridge | undefined
  const stats: IngestStats = { relayed: 0, skipped: 0, refused: 0 }
  try {
    // The ingest handler needs the bridge it belongs to: a stable indirection.
    let ingest: ((msg: import('../p2p/message.ts').P2PMessage) => Promise<void>) | undefined
    bridge = await startBridge({ ...w.bridgeOpts, onEnvelope: async msg => { await ingest?.(msg) } })
    ingest = meshIngest(bridge, stats)
    // Join the room (one signed presence post), so the bridge can read its log.
    await bridge.edge.send({ room: 'mesh', text: '[vortex bridge] present' })

    const member = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
    try {
      // A clean room message from the member.
      const envelope = await signEnvelope(w.memberPriv, {
        v: 1, id: 'dedupids000000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'mesh says hi', ts: Date.now()
      })
      const { ack } = await member.sendRaw(bridge.peer.id, envelope)
      assert.equal(ack.ok, true)
      for (let i = 0; i < 30 && stats.relayed === 0; i++) await Bun.sleep(200)
      assert.equal(stats.relayed, 1)
      // The hub stored it from the member's principal (origin verified).
      const log = (await bridge.edge.roomLog('mesh')).filter(m => m.text === 'mesh says hi')
      assert.equal(log.length, 1)
      assert.equal(log[0]!.from, w.memberPrincipal)
      assert.equal(log[0]!.human, false)

      // A repeated send is handled once. At the p2p hop the receiver's own
      // dedup refuses the identical frame:
      const again = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
      try {
        const { ack } = await again.sendRaw(bridge.peer.id, envelope)
        assert.equal(ack.ok, false)
        assert.equal(ack.error, 'duplicate message')
      } finally { await again.stop() }
      // And a bridge-level replay (a crash after the p2p hop, before the hub
      // answer) re-relays the same envelope: the hub dedups on (principal, id)
      // and the room log keeps exactly one copy.
      const before = stats.relayed
      await ingest?.(envelope)
      for (let i = 0; i < 30 && stats.relayed <= before; i++) await Bun.sleep(200)
      assert.equal(stats.relayed, before + 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'mesh says hi').length, 1)

      // A6 in both directions. Bridge first: the credential-shaped envelope
      // is screened at ingest and never relayed.
      const bad = await signEnvelope(w.memberPriv, {
        v: 1, id: 'a6probe000000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'here: sk-ant-test1234test1234test12', ts: Date.now()
      })
      const { ack: ack2 } = await member.sendRaw(bridge.peer.id, bad)
      assert.equal(ack2.ok, true)
      for (let i = 0; i < 30 && stats.skipped === 0; i++) await Bun.sleep(200)
      assert.equal(stats.skipped, 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text.includes('sk-ant-')).length, 0)
      // The hub's own screen is authoritative even for a bridge that skips
      // its screen: relaying the same envelope directly gets 422.
      await assert.rejects(
        bridge.edge.request('POST', '/v1/rooms/mesh/relay', { envelope: bad }),
        /422.*refused: text contains a credential/
      )
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text.includes('sk-ant-')).length, 0)

      // Room scope: the member's unsealed key is limited to `mesh`; an
      // envelope for another room is refused by the hub (403) and not stored.
      const other = await signEnvelope(w.memberPriv, {
        v: 1, id: 'scopeprobe000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'elsewhere', text: 'out of scope', ts: Date.now()
      })
      const { ack: ack3 } = await member.sendRaw(bridge.peer.id, other)
      assert.equal(ack3.ok, true)
      for (let i = 0; i < 30 && stats.refused === 0; i++) await Bun.sleep(200)
      assert.equal(stats.refused, 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'out of scope').length, 0)
    } finally { await member.stop() }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})
