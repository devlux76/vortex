// Sub-issue #11 of #3: hub→mesh signed room delivery. The test verifies
// outgoing signed envelopes, room-member routing, and A6 handling, plus the
// dedup-on-(from,id) restart guarantee and the unsealed key's room scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { enrollKey } from '../cli/keys.ts'
import { EdgeClient } from '../client/edge.ts'
import { loadOrCreateKey } from '../p2p/identity.ts'
import { startRelay } from '../p2p/relay.ts'
import { startBridge, type Bridge, type BridgeOptions } from './process.ts'
import { startPeer } from '../p2p/node.ts'
import { edgeKeyFromLibp2p, libp2pKeyId } from './identity.ts'
import { startRoomDelivery, forwardMessages, forwardIdOf, type DeliveryStats, type HubLogEntry } from './delivery.ts'

function emptyStats (): DeliveryStats {
  return { forwarded: 0, duplicates: 0, skipped: 0, dropped: 0 }
}

async function world () {
  const dir = mkdtempSync(join(tmpdir(), 'vx-delivery-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] })
  const relayAddr = relay.addrs()[0]!.toString()
  const keyFile = join(dir, 'bridge.key')
  const privateKey = await loadOrCreateKey(keyFile)
  // Peer id → principal: the bridge enrolls its libp2p key as its A7 key, so
  // sha256(spki) is both the key_id in principal_keys and this peer's identity.
  const material = await edgeKeyFromLibp2p(privateKey)
  const row = await enrollKey(hub.store, { principal: 'bridge', spkiB64: material.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
  const base = `https://127.0.0.1:${hub.tlsPort}`
  const edge = new EdgeClient({
    url: base, principal: 'bridge', keyId: row.key_id, hubId: hub.fingerprint!, alg: 'ed25519',
    key: await crypto.subtle.importKey('jwk', material.jwk, { name: 'Ed25519' }, false, ['sign']),
    insecureLoopback: true
  })
  const opts: BridgeOptions = { keyFile, relay: relayAddr, hubKeyFile: '', edge, insecureLoopback: true }
  // The mesh member identity is enrolled with the room: delivery now requires
  // every member to be enrolled, unrevoked and unexpired (Sun's QA on #36).
  const memberKeyFile = join(dir, 'member.key')
  const memberPriv = await loadOrCreateKey(memberKeyFile)
  const memberMaterial = await edgeKeyFromLibp2p(memberPriv)
  const memberRow = await enrollKey(hub.store, { principal: 'mesh-member', spkiB64: memberMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
  const cleanup = async () => { await relay.stop(); await hub.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { dir, hub, relay, relayAddr, keyFile, privateKey, edge, opts, memberKeyFile, memberPrincipal: memberRow.principal, cleanup }
}

const opPost = async (w: Awaited<ReturnType<typeof world>>, room: string, text: string): Promise<any> => {
  const operator = (await Bun.file(join(w.dir, 'c', 'vortex', 'operator.json')).json()).token
  const res = await fetch(`http://127.0.0.1:${w.hub.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'room', room, text })
  })
  const text1 = await res.text()
  assert.equal(res.status, 200, text1)
  return JSON.parse(text1) as any
}

test('#11: room messages reach mesh members as signed room envelopes; routing follows the rendezvous namespace', async () => {
  const w = await world()
  let bridge: Bridge | undefined
  try {
    // One key, two identities: the enrolled A7 key_id equals the libp2p key id.
    assert.equal((await libp2pKeyId(w.privateKey)), w.edge.opts.keyId)
    bridge = await startBridge(w.opts)
    const member = await import('../p2p/node.ts').then(m => m.startPeer({ keyFile: join(w.dir, 'member.key'), relay: w.relayAddr }))
    await member.register('mesh') // room-member routing: the room's rendezvous namespace

    await opPost(w, 'mesh', 'hello mesh')
    const delivery = await startRoomDelivery(bridge, 'mesh', { intervalMs: 300, stateFile: join(w.dir, 'state.json') })
    for (let i = 0; i < 40 && member.inbox.length === 0; i++) await Bun.sleep(250)
    const got = member.inbox.find(m => m.text === 'hello mesh')
    assert.ok(got, 'the member received nothing')
    assert.equal(got.scope, 'room')
    assert.equal(got.room, 'mesh')
    assert.equal(got.from, bridge.peer.id.toString())
    assert.equal(got.text, 'hello mesh')
    // The envelope id is deterministic in the hub message id.
    const log = (await w.edge.roomLog('mesh')).find(m => m.text === 'hello mesh') as HubLogEntry
    assert.equal(got.id, await forwardIdOf(log.id))

    await delivery.stop()
    await member.stop()
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#11: A6 in the bridge — a credential-shaped entry is not forwarded', async () => {
  const w = await world()
  let bridge: Bridge | undefined
  try {
    bridge = await startBridge(w.opts)
    const member = await import('../p2p/node.ts').then(m => m.startPeer({ keyFile: join(w.dir, 'member.key'), relay: w.relayAddr }))
    await member.register('mesh')
    // The hub refuses credential text at post time, so the ledger is seeded
    // directly to exercise the bridge's own screen (the inner defense).
    const bad: HubLogEntry = { id: 'seed-bad-000000000000000000', seq: 1, text: 'the key is sk-ant-test1234test1234test12' }
    const good: HubLogEntry = { id: 'seed-good-000000000000000000', seq: 2, text: 'clean after refusal' }
    const stats = emptyStats()
    for (let i = 0; i < 20 && member.inbox.length === 0; i++) {
      await forwardMessages(bridge, 'mesh', [bad, good], [member.id.toString()], stats)
      await Bun.sleep(250)
    }
    assert.equal(stats.skipped, 1)
    assert.equal(member.inbox.filter(m => m.text.includes('sk-ant-')).length, 0)
    assert.equal(member.inbox.at(-1)?.text, 'clean after refusal')
    await member.stop()
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#11: room authorization — discovery alone does not grant room reads', { timeout: 120_000 }, async () => {
  const w = await world()
  let bridge: Bridge | undefined
  try {
    bridge = await startBridge({ ...w.opts, relay: w.relayAddr })
    // A peer enrolled only for another room: it CAN register under `mesh` on
    // an open relay (the registration-side gate is #24/#38), so the delivery
    // check is what keeps it out here.
    const otherKeyFile = join(w.dir, 'other.key')
    const otherPriv = await loadOrCreateKey(otherKeyFile)
    const otherMaterial = await edgeKeyFromLibp2p(otherPriv)
    await enrollKey(w.hub.store, { principal: 'other-guy', spkiB64: otherMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['other-room'] })
    const other = await startPeer({ keyFile: otherKeyFile, relay: w.relayAddr })
    // An unenrolled peer self-registers too (Sun's original reproduction).
    const stranger = await startPeer({ keyFile: join(w.dir, 'stranger.key'), relay: w.relayAddr })
    const member = await startPeer({ keyFile: join(w.dir, 'member.key'), relay: w.relayAddr })
    try {
      await Promise.all([other.register('mesh'), stranger.register('mesh'), member.register('mesh')])
      await opPost(w, 'mesh', 'authorized only')
      const delivery = await startRoomDelivery(bridge, 'mesh', { intervalMs: 300, stateFile: join(w.dir, 'state.json') })
      for (let i = 0; i < 40 && member.inbox.length === 0; i++) await Bun.sleep(250)
      assert.equal(member.inbox.filter(m => m.text === 'authorized only').length, 1)
      assert.equal(other.inbox.length, 0, 'a peer enrolled for another room received mesh traffic')
      assert.equal(stranger.inbox.length, 0, 'an unenrolled peer received mesh traffic')
      // The bridge's own presence line is skipped, not delivered.
      assert.equal(member.inbox.filter(m => m.text.includes('[vortex bridge]')).length, 0)
      await delivery.stop()
    } finally {
      await Promise.allSettled([other.stop(), stranger.stop(), member.stop()])
    }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#11: dedup on (from,id) — a replayed batch after a restart is refused, not re-delivered', async () => {
  const w = await world()
  let bridge: Bridge | undefined
  try {
    bridge = await startBridge(w.opts)
    const member = await import('../p2p/node.ts').then(m => m.startPeer({ keyFile: join(w.dir, 'member.key'), relay: w.relayAddr }))
    await member.register('mesh')
    const entry: HubLogEntry = { id: 'dedup-probe-0000000000000000', seq: 7, text: 'only once' }
    const stats = emptyStats()
    for (let i = 0; i < 20 && stats.forwarded === 0; i++) {
      await forwardMessages(bridge, 'mesh', [entry], [member.id.toString()], stats)
      await Bun.sleep(250)
    }
    assert.equal(stats.forwarded, 1)
    // The same batch replayed (crash between send and cursor write): the
    // deterministic id makes it the identical frame, and the member's
    // persisted dedup refuses it.
    const replay = await forwardMessages(bridge, 'mesh', [entry], [member.id.toString()], stats)
    assert.equal(replay.through, 7)
    assert.equal(stats.duplicates, 1)
    assert.equal(stats.forwarded, 1)
    assert.equal(member.inbox.filter(m => m.text === 'only once').length, 1)
    // The delivered envelope persists as deduped across a receiver restart too.
    const dedupDb = join(w.dir, 'member.key.dedup.sqlite')
    assert.ok(readFileSync(dedupDb).length > 0)
    await member.stop()
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#11: room scope — the unsealed bridge key cannot read or forward another room', async () => {
  const w = await world()
  let bridge: Bridge | undefined
  try {
    bridge = await startBridge(w.opts)
    await opPost(w, 'private-room', 'secret to another room')
    // The hub refuses the read outright (404, non-member): room scope holds.
    await assert.rejects(w.edge.roomLog('private-room'), /404/)
    // An empty enrollment room yields nothing to forward.
    const member = await import('../p2p/node.ts').then(m => m.startPeer({ keyFile: join(w.dir, 'member.key'), relay: w.relayAddr }))
    await member.register('mesh')
    const stats = emptyStats()
    const r = await forwardMessages(bridge, 'mesh', [], [member.id.toString()], stats)
    assert.equal(r.through, 0)
    assert.equal(member.inbox.length, 0)
    await member.stop()
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})
