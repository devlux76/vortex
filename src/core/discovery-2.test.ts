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

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('caps keep the best and bound one peer', async () => {
  const net = createNetwork()
  const tO = await net.node()
  const t1 = await net.node()
  const t2 = await net.node()
  const t3 = await net.node()
  const seen: Array<{ peer: PeerId }> = []
  const dO = new Discovery({ matchWindowMs: 0,
    transport: tO, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) },
    maxMatchesPerInterest: 2
  })
  const d1 = new Discovery({ matchWindowMs: 0,  transport: t1, embedder: makeEmbedder(), onMatch: () => {} })
  const d2 = new Discovery({ matchWindowMs: 0,  transport: t2, embedder: makeEmbedder(), onMatch: () => {} })
  const d3 = new Discovery({ matchWindowMs: 0,  transport: t3, embedder: makeEmbedder(), onMatch: () => {} })
  await dO.start()
  await d1.start()
  await d2.start()
  await d3.start()
  // Three responders at different tiers for one interest.
  await d1.announce({ session: 'r', statement: 'exact' })
  await d2.announce({ session: 'r', statement: 'tier8' })
  await d3.announce({ session: 'r', statement: 'tier4' })
  await settle()
  const idO = await dO.announce({ session: 'o', statement: 'base' })
  await settle()
  const kept = dO.matches(idO)
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map(m => m.tier.tier), ['exact', 8])
  assert.equal(seen.length, 2)
  // One peer cannot exceed maxResultsPerAnnouncement kept matches for one interest.
  const tS = await net.node()
  const dS = new Discovery({ matchWindowMs: 0,  transport: tS, embedder: makeEmbedder(), onMatch: () => {}, maxResultsPerAnnouncement: 1 })
  await dS.start()
  await dS.announce({ session: 's', statement: 'exact' })
  await dS.announce({ session: 's', statement: 'tier8' })
  await settle()
  const tT = await net.node()
  const dT = new Discovery({ matchWindowMs: 0,  transport: tT, embedder: makeEmbedder(), onMatch: () => {}, maxResultsPerAnnouncement: 1 })
  await dT.start()
  const idT = await dT.announce({ session: 't', statement: 'base' })
  await settle()
  // dS answers with at most one record per announcement, so dT keeps at most one from dS.
  const fromS = dT.matches(idT).filter(m => m.peer === tS.info().peerId)
  assert.ok(fromS.length <= 1)
  await dO.stop()
  await d1.stop()
  await d2.stop()
  await d3.stop()
  await dS.stop()
  await dT.stop()
})

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('the same record twice calls onMatch once', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await db.announce({ session: 'b', statement: 'exact' })
  await settle()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  assert.equal(hits, 1)
  // Replay the exact packet the responder sent.
  const replay = tb.sent[tb.sent.length - 1].data
  await tb.send(ta.info().peerId, replay, ta.info().addrs)
  await settle()
  assert.equal(hits, 1)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('a node accepts its own announcement and never matches itself', async () => {
  const net = createNetwork()
  const ta = await net.node()
  let hits = 0
  const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  await d.start()
  await d.announce({ session: 's', statement: 'base' })
  await settle()
  const before = ta.sent.length
  const idOwn = await d.announce({ session: 's', statement: 'exact' })
  await settle()
  assert.ok(ta.verdicts.includes('accept'))
  assert.equal(ta.sent.length, before)
  assert.equal(hits, 0)
  assert.equal(d.matches(idOwn).length, 0)
  await d.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 11.2
test('stop leaves later announcements and packets untouched', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hitsB = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => { hitsB++ } })
  await da.start()
  await db.start()
  const stoppedId = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  await db.stop()
  const verdictsBefore = tb.verdicts.length
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  assert.equal(tb.verdicts.length, verdictsBefore)
  assert.equal(hitsB, 0)
  // A direct packet after stop changes nothing.
  const { createAnnouncement } = await import('./announcement.ts')
  const contactA = Contact.encode({ addrs: ta.info().addrs })
  const rec = await createAnnouncement({
    profile, vector: vExact, origin: ta.info().peerId, contact: contactA, ttl: 60,
    sign: data => ta.sign(data), now: Date.now()
  })
  assert.deepEqual(db.interests(), [])
  const packet = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(stoppedId), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  packet[0] = 0
  packet.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(stoppedId), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await ta.send(tb.info().peerId, packet, tb.info().addrs)
  await settle()
  assert.equal(hitsB, 0)
  await da.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('matches sharing a tier order by fullScore, not tier score', async () => {
  const net = createNetwork()
  const tO = await net.node()
  const tA = await net.node()
  const tB = await net.node()
  const dO = new Discovery({ transport: tO, embedder: makeEmbedder(), onMatch: () => {} })
  const dA = new Discovery({ transport: tA, embedder: makeEmbedder(), onMatch: () => {} })
  const dB = new Discovery({ transport: tB, embedder: makeEmbedder(), onMatch: () => {} })
  await dO.start()
  await dA.start()
  await dB.start()
  // A holds tier4 (prefix 1.0, full 0.5); B holds tier4 with lower prefix but higher full.
  await dA.announce({ session: 'a', statement: 'tier4' })
  await dB.announce({ session: 'b', statement: 'other' })
  await settle()
  const idO = await dO.announce({ session: 'o', statement: 'base' })
  await settle()
  const kept = dO.matches(idO)
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map(m => m.tier.tier), [4, 4])
  // B has the lower tier.score but the higher fullScore, so it comes first.
  assert.ok(kept[0].tier.score < kept[1].tier.score)
  assert.ok(kept[0].fullScore > kept[1].fullScore)
  assert.equal(kept[0].peer, tB.info().peerId)
  await dO.stop()
  await dA.stop()
  await dB.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('expired kept matches do not block a fresh match under the interest cap', async () => {
  const net = createNetwork()
  const clock = { now: Date.now() }
  const ta1 = await net.node()
  const tb = await net.node()
  const ta2 = await net.node()
  const seen: PeerId[] = []
  const da1 = new Discovery({ matchWindowMs: 0,  transport: ta1, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.peer) },
    now: () => clock.now, maxMatchesPerInterest: 1
  })
  const da2 = new Discovery({ matchWindowMs: 0,  transport: ta2, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  await da1.start()
  await db.start()
  await da2.start()
  await da1.announce({ session: 'a1', statement: 'exact', ttl: 1 })
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  assert.deepEqual(seen, [ta1.info().peerId])
  // Let the first record expire without reading matches.
  clock.now += 2000
  await da2.announce({ session: 'a2', statement: 'tier8' })
  await settle()
  const record = da2.interests()[0].bytes
  await ta2.send(tb.info().peerId, directPacket(idB, record, 8, 0.95), tb.info().addrs)
  await settle()
  assert.deepEqual(seen, [ta1.info().peerId, ta2.info().peerId])
  assert.deepEqual(db.matches(idB).map(m => m.peer), [ta2.info().peerId])
  await da1.stop()
  await db.stop()
  await da2.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('an expired kept match does not use up its peer slot', async () => {
  const net = createNetwork()
  const clock = { now: Date.now() }
  const ta1 = await net.node()
  const tb = await net.node()
  const seen: string[] = []
  const da1 = new Discovery({ matchWindowMs: 0,  transport: ta1, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.record.id) },
    now: () => clock.now, maxResultsPerAnnouncement: 1
  })
  await da1.start()
  await db.start()
  await da1.announce({ session: 'a1', statement: 'exact', ttl: 1 })
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  assert.equal(seen.length, 1)
  clock.now += 2000
  await da1.announce({ session: 'a1', statement: 'tier8' })
  await settle()
  const fresh = da1.interests().find(i => i.statement === 'tier8')
  assert.ok(fresh !== undefined)
  await ta1.send(tb.info().peerId, directPacket(idB, fresh.bytes, 8, 0.95), tb.info().addrs)
  await settle()
  assert.equal(seen.length, 2)
  assert.deepEqual(db.matches(idB).map(m => m.record.id), [fresh.id])
  await da1.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test("a peer's better record replaces its weaker one within the peer cap", async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tiers: unknown[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { tiers.push(m.tier.tier) },
    maxResultsPerAnnouncement: 1
  })
  await da.start()
  await db.start()
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await da.announce({ session: 'a', statement: 'tier4' })
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  const byStatement = new Map(da.interests().map(i => [i.statement, i]))
  const broad = byStatement.get('tier4')
  const narrow = byStatement.get('exact')
  assert.ok(broad !== undefined && narrow !== undefined)
  await ta.send(tb.info().peerId, directPacket(idB, broad.bytes, 4, 1), tb.info().addrs)
  await settle()
  await ta.send(tb.info().peerId, directPacket(idB, narrow.bytes, 0, 1), tb.info().addrs)
  await settle()
  assert.deepEqual(tiers, [4, 'exact'])
  assert.deepEqual(db.matches(idB).map(m => m.tier.tier), ['exact'])
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test("a peer's weaker record does not displace its better one", async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tiers: unknown[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { tiers.push(m.tier.tier) },
    maxResultsPerAnnouncement: 1
  })
  await da.start()
  await db.start()
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await da.announce({ session: 'a', statement: 'tier4' })
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  const byStatement = new Map(da.interests().map(i => [i.statement, i]))
  const broad = byStatement.get('tier4')
  const narrow = byStatement.get('exact')
  assert.ok(broad !== undefined && narrow !== undefined)
  await ta.send(tb.info().peerId, directPacket(idB, narrow.bytes, 0, 1), tb.info().addrs)
  await settle()
  await ta.send(tb.info().peerId, directPacket(idB, broad.bytes, 4, 1), tb.info().addrs)
  await settle()
  assert.deepEqual(tiers, ['exact'])
  assert.deepEqual(db.matches(idB).map(m => m.tier.tier), ['exact'])
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 10.7
test('a validation that spans a stop and start leaves no state behind', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: PeerId[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.peer) } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  // Gate A's verification only from here on, so setup mail is unaffected.
  let releaseGate: () => void = () => {}
  let enteredGate = false
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const rawVerify = ta.verify.bind(ta)
  ta.verify = (async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
    enteredGate = true
    await gate
    return rawVerify(peer, data, sig)
  }) as typeof ta.verify
  const announcing = db.announce({ session: 'b', statement: 'exact' })
  const gateEnd = Date.now() + 5000
  while (!enteredGate) {
    if (Date.now() > gateEnd) throw new Error('validator did not reach the gate')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await da.stop()
  await da.start()
  releaseGate()
  await announcing
  const bytes = net.publishes[net.publishes.length - 1].data
  // The stale validation changed nothing: ignored, unanswered, uncounted.
  assert.equal(ta.verdicts[ta.verdicts.length - 1], 'ignore')
  assert.deepEqual(seen, [])
  // A new run must reopen its interest before it can answer a replay.
  await da.announce({ session: 'a', statement: 'base' })
  await net.inject(tb.info().peerId, topic, bytes)
  await settle()
  assert.equal(ta.verdicts[ta.verdicts.length - 1], 'accept')
  assert.deepEqual(seen, [ta.info().peerId])
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('a result verified across a stop and start is not kept by the new run', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: PeerId[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.peer) } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  // Hold B's verification of records signed by A; B's own announcement passes straight through.
  let releaseGate: () => void = () => {}
  let enteredGate = false
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const rawVerify = tb.verify.bind(tb)
  tb.verify = (async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
    if (peer === ta.info().peerId) {
      enteredGate = true
      await gate
    }
    return rawVerify(peer, data, sig)
  }) as typeof tb.verify
  const first = await db.announce({ session: 'b', statement: 'exact' })
  const gateEnd = Date.now() + 5000
  while (!enteredGate) {
    if (Date.now() > gateEnd) throw new Error('result handler did not reach the gate')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await db.stop()
  await db.start()
  releaseGate()
  await settle()
  // The old run's result and its session interest both ended with that run.
  assert.deepEqual(seen, [])
  assert.deepEqual(db.matches(first), [])
  assert.equal(db.interests().length, 0)
  // The new run collects results as usual.
  const second = await db.announce({ session: 'b', statement: 'exact' })
  await settle()
  assert.deepEqual(seen, [ta.info().peerId])
  assert.equal(db.matches(second).length, 1)
  await da.stop()
  await db.stop()
})
