import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import type { DirectEvent, GossipEvent, GossipHandler, GossipVerdict, PeerId, Transport, TransportInfo } from '../types.ts'
import { openAnnouncement } from './announcement.ts'
import { Discovery } from './discovery.ts'
import { createDescriptor } from './conference-records.ts'
import { Descriptor as WireDescriptor, SignedDescriptor } from './proto/conference.ts'
import { Contact, DiscoveryPacket } from './proto/discovery.ts'
import { announceTopic } from './topics.ts'

import { profile, topic, vBase, vExact, v8, v4, v2, vFar, vR2, table, makeEmbedder, hex, unhex, directPacket, settle, sleep, type TestTransport, createNetwork, verify, hostedRecord, resultPacket, answer, retainedRecord, lastBytes } from './discovery.testkit.ts'

// Docs: VORTEX_v5.1.md sections 5.2, 6.1 and 11.2
test('hosted descriptors match on topic, replace their interest, and share ranking and result caps', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  let rooms: Awaited<ReturnType<typeof hostedRecord>>[] = []
  const dh = new Discovery({ matchWindowMs: 0,  transport: th, embedder: makeEmbedder(), onMatch: () => {}, conferences: () => rooms })
  const hits: string[] = []
  const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: m => { hits.push(m.record.id) } })
  await dh.start()
  await origin.start()
  try {
    const held = await dh.announce({ session: 'host', statement: 'base' })
    await dh.announce({ session: 'host', statement: 'tier8' })
    await dh.announce({ session: 'host', statement: 'tier4' })
    rooms = [await hostedRecord(th, held), await hostedRecord(th, 'cd'.repeat(16), vExact),
      await hostedRecord(th, 'ef'.repeat(16), vFar)]
    const id = await origin.announce({ session: 'origin', statement: 'base' })
    await settle()
    const matches = origin.matches(id)
    assert.equal(matches.length, 3)
    assert.equal(matches.filter(m => m.record.id === held).length, 1)
    assert.equal(matches.find(m => m.record.id === held)?.kind, 'conference')
    assert.deepEqual(matches.map(m => m.tier.tier), ['exact', 'exact', 8])
    assert.equal(matches.some(m => m.record.id === 'ef'.repeat(16)), false)
    const wire = DiscoveryPacket.decode(th.sent.at(-1)!.data.slice(1))
    assert.equal(wire.results.length, 3)
    assert.equal(wire.results.filter(r => r.conference.length > 0).length, 2)
    assert.equal(wire.results.every(r => (r.record.length > 0) !== (r.conference.length > 0)), true)
    assert.equal(hits.length, 3)
  } finally { await dh.stop(); await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1, 10.6 and 11.2
test('descriptor payloads round-trip beside legacy interests and ambiguous results leave valid siblings intact', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const origin = new Discovery({ transport: to, embedder: makeEmbedder(), onMatch: () => {} })
  await origin.start()
  try {
    const id = await origin.announce({ session: 'origin', statement: 'base' })
    const room = await hostedRecord(th)
    const { createAnnouncement } = await import('./announcement.ts')
    const interest = await createAnnouncement({ profile, vector: v8, origin: th.peerId,
      contact: Contact.encode({ addrs: th.info().addrs }), ttl: 60, sign: data => th.sign(data) })
    const legacy = DiscoveryPacket.decode(DiscoveryPacket.encode({ results: [{ announcementId: unhex(id), record: interest.bytes, tier: 8, score: 1 }] }))
    assert.deepEqual(legacy.results[0].record, interest.bytes)
    const conf = { announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }
    assert.deepEqual(DiscoveryPacket.decode(DiscoveryPacket.encode({ results: [conf] })).results[0].conference, room.bytes)
    await th.send(to.peerId, resultPacket([
      { ...conf, record: interest.bytes }, { ...conf, conference: new Uint8Array() }, conf
    ]))
    await settle()
    assert.deepEqual(origin.matches(id).map(m => m.kind), ['conference'])
    await th.send(to.peerId, directPacket(id, interest.bytes, 8, 1))
    await settle()
    assert.deepEqual(origin.matches(id).map(m => m.kind), ['conference', 'interest'])
  } finally { await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 5.2, 6.1 and 10.6
test('descriptor verification refuses forged records and recomputes claimed tiers', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const impostor = await net.node()
  const now = Date.now()
  const origin = new Discovery({ transport: to, embedder: makeEmbedder(), onMatch: () => {}, now: () => now })
  await origin.start()
  try {
    const id = await origin.announce({ session: 'o', statement: 'base' })
    const good = await hostedRecord(th, 'ab'.repeat(16), v8, now)
    const signed = SignedDescriptor.decode(good.bytes)
    const wire = WireDescriptor.decode(signed.descriptor)
    const mutate = async (patch: Partial<typeof wire>): Promise<Uint8Array> => {
      const inner = WireDescriptor.encode({ ...wire, ...patch })
      const prefix = new TextEncoder().encode('vortex-descriptor:1\n')
      const data = new Uint8Array(prefix.length + inner.length)
      data.set(prefix); data.set(inner, prefix.length)
      return SignedDescriptor.encode({ descriptor: inner, signature: await th.sign(data) })
    }
    const invalid = [
      SignedDescriptor.encode({ ...signed, signature: new Uint8Array(64) }),
      await mutate({ namespace: new Uint8Array(32).fill(7) }),
      await mutate({ expiresAt: BigInt(now) }),
      await mutate({ host: impostor.peerId }),
      await mutate({ contact: Contact.encode({ addrs: impostor.info().addrs }) }),
      await mutate({ topicVector: new Uint8Array(4) }),
      (await hostedRecord(th, 'bc'.repeat(16), vFar, now)).bytes
    ]
    for (const bytes of invalid) {
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: bytes, tier: 0, score: 1 }]))
      await settle()
      assert.deepEqual(origin.matches(id), [])
    }
    await impostor.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: good.bytes, tier: 0, score: 1 }]))
    await settle()
    assert.deepEqual(origin.matches(id), [])
    await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: good.bytes, tier: 0, score: 1 }]))
    await settle()
    const match = origin.matches(id)[0]
    assert.equal(match.kind, 'conference')
    assert.equal(match.tier.tier, 8)
    assert.ok(match.fullScore < 1)
  } finally { await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 5.3, 6.1 and 11.2
test('a descriptor replaces its retained interest and refreshes metadata without repeat callbacks', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const host = new Discovery({ matchWindowMs: 0,  transport: th, embedder: makeEmbedder(), onMatch: () => {} })
  let hits = 0
  const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: () => { hits++ }, maxMatchesPerInterest: 1, maxResultsPerAnnouncement: 1 })
  await host.start(); await origin.start()
  try {
    const held = await host.announce({ session: 'h', statement: 'base' })
    const id = await origin.announce({ session: 'o', statement: 'base' })
    await settle()
    assert.equal(origin.matches(id)[0].kind, 'interest')
    const room = await hostedRecord(th, held)
    const send = async (bytes: Uint8Array) => {
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: bytes, tier: 0, score: 1 }]))
      await settle()
    }
    await send(room.bytes)
    assert.equal(origin.matches(id)[0].kind, 'conference')
    assert.equal(hits, 2)
    await send(room.bytes)
    await retainedRecord(origin, id, held)
    const refreshed = await createDescriptor({ id: held, profile, topicVector: vBase, host: th.peerId, addrs: th.info().addrs,
      participantCount: 3, capacity: 8, admission: 'open', revision: 2, createdAt: room.descriptor.createdAt,
      expiresAt: room.descriptor.expiresAt, sign: data => th.sign(data) })
    await send(refreshed.bytes)
    assert.equal(hits, 2)
    const retained = origin.matches(id)[0]
    assert.ok(retained.kind === 'conference')
    assert.equal(retained.record.participantCount, 3)
    await send(room.bytes)
    const afterReplay = origin.matches(id)[0]
    assert.ok(afterReplay.kind === 'conference')
    assert.equal(afterReplay.record.participantCount, 3)
    for (const change of [{ revision: 2, createdAt: room.descriptor.createdAt },
      { revision: 3, createdAt: room.descriptor.createdAt + 1 }]) {
      const conflicting = await createDescriptor({ id: held, profile, topicVector: vBase,
        host: th.peerId, addrs: th.info().addrs, participantCount: 4, capacity: 8,
        admission: 'open', expiresAt: room.descriptor.expiresAt, ...change, sign: data => th.sign(data) })
      await send(conflicting.bytes)
      const unchanged = origin.matches(id)[0]
      assert.ok(unchanged.kind === 'conference')
      assert.equal(unchanged.record.participantCount, 3)
      assert.equal(unchanged.record.revision, 2)
    }
    await th.send(to.peerId, directPacket(id, host.interests()[0].bytes, 0, 1))
    await settle()
    assert.equal(origin.matches(id)[0].kind, 'conference')
    assert.equal(hits, 2)
  } finally { await host.stop(); await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 2.2, 5.3 and 10.7
for (const action of ['withdraw', 'expiry', 'stop', 'restart'] as const) {
  test(`descriptor verification spanning ${action} retains nothing`, async () => {
    const net = createNetwork()
    const th = await net.node()
    const to = await net.node()
    const clock = { now: Date.now() }
    let hits = 0
    const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: () => { hits++ }, now: () => clock.now })
    await origin.start()
    try {
      const id = await origin.announce({ session: 'o', statement: 'base', ttl: 1 })
      const room = await hostedRecord(th, 'ab'.repeat(16), vBase, clock.now)
      let release = () => {}
      let entered = false
      const gate = new Promise<void>(resolve => { release = resolve })
      const verify = to.verify.bind(to)
      to.verify = async (peer, data, sig) => { entered = true; await gate; return verify(peer, data, sig) }
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }]))
      await settle()
      assert.equal(entered, true)
      if (action === 'withdraw') origin.withdraw('o', id)
      if (action === 'expiry') clock.now += 2000
      if (action === 'stop' || action === 'restart') await origin.stop()
      if (action === 'restart') await origin.start()
      release()
      await settle()
      assert.equal(hits, 0)
      assert.deepEqual(origin.matches(id), [])
    } finally { await origin.stop() }
  })
}

// Docs: VORTEX_v5.1.md sections 6.1, 6.3 and 10.6
for (const retainedKind of ['interest', 'conference'] as const) {
  test(`a different host cannot replace a retained ${retainedKind} using its handle`, async () => {
    const net = createNetwork()
    const host = await net.node()
    const attacker = await net.node()
    const to = await net.node()
    let hits = 0
    const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: () => { hits++ } })
    await origin.start()
    try {
      const id = await origin.announce({ session: 'o', statement: 'base' })
      const { createAnnouncement } = await import('./announcement.ts')
      const interest = await createAnnouncement({ profile, vector: vBase, origin: host.peerId,
        contact: Contact.encode({ addrs: host.info().addrs }), ttl: 60, sign: data => host.sign(data) })
      const handle = interest.announcement.id
      const room = await hostedRecord(host, handle)
      if (retainedKind === 'interest') await host.send(to.peerId, directPacket(id, interest.bytes, 0, 1))
      else await host.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }]))
      await settle()
      assert.equal(origin.matches(id)[0].peer, host.peerId)
      const forgedRoom = await hostedRecord(attacker, handle)
      await attacker.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: forgedRoom.bytes, tier: 0, score: 1 }]))
      await settle()
      const kept = origin.matches(id)
      assert.equal(kept.length, 1)
      assert.equal(kept[0].peer, host.peerId)
      assert.equal(kept[0].kind, retainedKind)
      assert.deepEqual(kept[0].addrs, host.info().addrs)
      assert.equal(hits, 1)
    } finally { await origin.stop() }
  })
}

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
for (const stage of ['embed', 'sign', 'publish'] as const) {
  for (const restart of [false, true]) {
    test(`an announcement spanning ${stage} and ${restart ? 'restart' : 'stop'} cannot complete in the old run`, async () => {
      const net = createNetwork()
      const transport = await net.node()
      let release = () => {}
      let entered = () => {}
      const gate = new Promise<void>(resolve => { release = resolve })
      const ready = new Promise<void>(resolve => { entered = resolve })
      const embedder = makeEmbedder()
      const originalEmbed = embedder.embed
      const originalSign = transport.sign
      const originalPublish = transport.publish
      if (stage === 'embed') embedder.embed = async text => { entered(); await gate; return originalEmbed(text) }
      if (stage === 'sign') transport.sign = async data => { entered(); await gate; return originalSign(data) }
      if (stage === 'publish') transport.publish = async (topic, data) => { entered(); await gate; return originalPublish(topic, data) }
      const discovery = new Discovery({ matchWindowMs: 0,  transport, embedder, onMatch: () => {} })
      await discovery.start()
      const outcome = discovery.announce({ session: 'old', statement: 'base' }).then(
        () => undefined, error => error as Error)
      try {
        await ready
        await discovery.stop()
        if (restart) await discovery.start()
        release()
        assert.match((await outcome)?.message ?? 'unexpected success', /discovery stopped/)
        assert.deepEqual(discovery.interests(), [])
        // A transport write already in flight cannot be recalled; earlier stages must never publish.
        assert.equal(net.publishes.length, stage === 'publish' ? 1 : 0)
      } finally { release(); await discovery.stop() }
    })
  }
}

// Inspect retained storage directly: public getters lazily prune and would hide a missing timer.
test('idle interest expiry releases statements and matches without another operation', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: () => {} })
  await responder.start(); await origin.start()
  try {
    await responder.announce({ session: 'host', statement: 'base' })
    const short = await origin.announce({ session: 'guest', statement: 'exact', ttl: 1 })
    const long = await origin.announce({ session: 'guest', statement: 'tier8', ttl: 2 })
    await settle()
    const stored = origin as unknown as {
      registry: { interests: Map<string, unknown> }, matchesByInterest: Map<string, unknown>
    }
    assert.equal(stored.matchesByInterest.size, 2)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.deepEqual([...stored.registry.interests.keys()], [long])
    assert.equal(stored.matchesByInterest.has(short), false)
    assert.equal(stored.matchesByInterest.has(long), true)
    await new Promise(resolve => setTimeout(resolve, 1000))
    assert.equal(stored.registry.interests.size, 0)
    assert.equal(stored.matchesByInterest.size, 0)
  } finally { await responder.stop(); await origin.stop() }
})

test('a failed replacement publish after restart cannot resurrect an old session interest', async () => {
  const net = createNetwork()
  const transport = await net.node()
  const discovery = new Discovery({ transport, embedder: makeEmbedder(), onMatch: () => {} })
  await discovery.start()
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const publish = transport.publish
  try {
    const old = await discovery.announce({ session: 'old', statement: 'base' })
    transport.publish = async () => { entered(); await gate; throw new Error('publish failed') }
    const failed = discovery.announce({ session: 'old', statement: 'exact', replaces: old }).catch(error => error)
    await ready
    await discovery.stop(); await discovery.start()
    transport.publish = publish
    const fresh = await discovery.announce({ session: 'fresh', statement: 'tier8' })
    release()
    assert.match((await failed).message, /publish failed/)
    assert.deepEqual(discovery.interests().map(interest => interest.id), [fresh])
  } finally { release(); await discovery.stop() }
})

test('an idle expired result is released while its local interest remains open', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: () => {} })
  await responder.start(); await origin.start()
  try {
    await responder.announce({ session: 'host', statement: 'base', ttl: 1 })
    const id = await origin.announce({ session: 'guest', statement: 'exact', ttl: 3 })
    await settle()
    const stored = origin as unknown as {
      registry: { interests: Map<string, unknown> }, matchesByInterest: Map<string, unknown>
    }
    assert.equal(stored.matchesByInterest.size, 1)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(stored.registry.interests.has(id), true)
    assert.equal(stored.matchesByInterest.size, 0)
  } finally { await responder.stop(); await origin.stop() }
})

test('withdrawal, session end and stop release the last expiry timer', async () => {
  const net = createNetwork()
  const transport = await net.node()
  const discovery = new Discovery({ transport, embedder: makeEmbedder(), onMatch: () => {} })
  const stored = discovery as unknown as { expiryTimer: unknown }
  await discovery.start()
  try {
    const first = await discovery.announce({ session: 's', statement: 'base' })
    assert.notEqual(stored.expiryTimer, undefined)
    assert.equal(discovery.withdraw('s', first), true)
    assert.equal(stored.expiryTimer, undefined)
    const second = await discovery.announce({ session: 's', statement: 'exact' })
    assert.notEqual(stored.expiryTimer, undefined)
    assert.deepEqual(discovery.endSession('s'), [second])
    assert.equal(stored.expiryTimer, undefined)
    await discovery.announce({ session: 's', statement: 'tier8' })
    assert.notEqual(stored.expiryTimer, undefined)
    await discovery.stop()
    assert.equal(stored.expiryTimer, undefined)
    assert.deepEqual(discovery.interests(), [])
    await discovery.start()
    assert.equal(stored.expiryTimer, undefined)
    assert.deepEqual(discovery.interests(), [])
  } finally { await discovery.stop() }
})

test('a failed replacement restores the original interest and its retained matches', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: () => {} })
  await responder.start(); await origin.start()
  try {
    const record = await responder.announce({ session: 'host', statement: 'base' })
    const original = await origin.announce({ session: 'guest', statement: 'exact' })
    await settle()
    assert.deepEqual(origin.matches(original).map(match => match.record.id), [record])
    guest.failPublish = true
    await assert.rejects(origin.announce({ session: 'guest', statement: 'tier8', replaces: original }), /publish failed/)
    assert.deepEqual(origin.interests().map(interest => interest.id), [original])
    assert.deepEqual(origin.matches(original).map(match => match.record.id), [record])
  } finally { await responder.stop(); await origin.stop() }
})

for (const stage of ['embed', 'publish', 'successful publish'] as const) {
  test(`ending a session during ${stage} prevents an announcement from restoring that session`, async () => {
    const net = createNetwork()
    const transport = await net.node()
    const embedder = makeEmbedder()
    const discovery = new Discovery({ transport, embedder, onMatch: () => {} })
    await discovery.start()
    let release = () => {}
    let entered = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    try {
      const old = await discovery.announce({ session: 's', statement: 'base' })
      if (stage === 'embed') {
        const embed = embedder.embed
        embedder.embed = async text => { entered(); await gate; return embed(text) }
      } else {
        const publish = transport.publish
        transport.publish = async (topic, data) => {
          entered(); await gate
          if (stage === 'publish') throw new Error('publish failed')
          return publish(topic, data)
        }
      }
      const outcome = discovery.announce({ session: 's', statement: 'exact', replaces: old }).catch(error => error)
      await ready
      discovery.endSession('s')
      release()
      assert.ok(await outcome instanceof Error)
      assert.deepEqual(discovery.interests('s'), [])
    } finally { release(); await discovery.stop() }
  })
}
