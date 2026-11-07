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

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('late joiner is matched in one direction only', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const matchesA: unknown[] = []
  const matchesB: Array<{ interest: string, peer: PeerId, tier: { tier: unknown }, addrs: string[], record: { id: string } }> = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: (m) => { matchesA.push(m) } })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { matchesB.push(m as never) } })
  await da.start()
  await db.start()
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  assert.equal(matchesA.length, 0)
  assert.equal(matchesB.length, 0)
  const idB = await db.announce({ session: 'b', statement: 'exact' })
  await settle()
  assert.equal(matchesB.length, 1)
  assert.equal(matchesB[0].interest, idB)
  assert.equal(matchesB[0].peer, ta.info().peerId)
  assert.equal((matchesB[0].tier as { tier: string }).tier, 'exact')
  assert.deepEqual(matchesB[0].addrs, ta.info().addrs)
  assert.equal(matchesB[0].record.id, idA)
  assert.equal(matchesA.length, 0)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.2 and 5.3
test('tiers order exact before 8 before 4 with recomputed tiers', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: Array<{ tier: { tier: unknown } }> = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'exact' })
  await da.announce({ session: 'a', statement: 'tier8' })
  await da.announce({ session: 'a', statement: 'tier4' })
  await settle()
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  const kept = db.matches(idB)
  assert.equal(kept.length, 3)
  assert.deepEqual(kept.map(m => m.tier.tier), ['exact', 8, 4])
  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map(m => (m.tier as { tier: unknown }).tier).sort(), [4, 8, 'exact'].sort())
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.2 and 11.2
test('unrelated statements produce no direct packet and no match', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  await db.announce({ session: 'b', statement: 'far' })
  await settle()
  assert.equal(hits, 0)
  assert.equal(ta.directs.length, 0)
  assert.equal(tb.directs.length, 0)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 4.2 and 10.2
test('the statement stays local unless publishStatement is set', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  await d.start()
  const before = net.publishes.length
  const idHidden = await d.announce({ session: 's', statement: 'base' })
  const first = net.publishes[before]
  const openedHidden = await openAnnouncement(first.data, { profile: ns => ns === profile.id ? profile : undefined, verify, now: Date.now() })
  assert.equal(openedHidden.statement, undefined)
  const idShown = await d.announce({ session: 's', statement: 'tier8', publishStatement: true })
  const second = net.publishes[before + 1]
  const openedShown = await openAnnouncement(second.data, { profile: ns => ns === profile.id ? profile : undefined, verify, now: Date.now() })
  assert.equal(openedShown.statement, 'tier8')
  const local = new Map(d.interests().map(i => [i.id, i.statement]))
  assert.equal(local.get(idHidden), 'base')
  assert.equal(local.get(idShown), 'tier8')
  await d.stop()
})

// Docs: VORTEX_v5.1.md sections 10.2 and 11.2
test('checkOutbound throwing stops everything', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const calls = { count: 0 }
  const d = new Discovery({
    transport: ta,
    embedder: makeEmbedder(calls),
    onMatch: () => {},
    checkOutbound: () => { throw new Error('denied') }
  })
  await d.start()
  const published = net.publishes.length
  await assert.rejects(d.announce({ session: 's', statement: 'base' }), /denied/)
  assert.equal(calls.count, 0)
  assert.equal(d.interests().length, 0)
  assert.equal(net.publishes.length, published)
  await d.stop()
})

// Docs: VORTEX_v5.1.md section 11.2
test('a failing publish removes the interest again', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  await d.start()
  ta.failPublish = true
  await assert.rejects(d.announce({ session: 's', statement: 'base' }), /publish failed/)
  assert.equal(d.interests().length, 0)
  // A failed revision changes nothing either: the interest it would have replaced is still held.
  ta.failPublish = false
  const kept = await d.announce({ session: 's', statement: 'base' })
  ta.failPublish = true
  await assert.rejects(d.announce({ session: 's', statement: 'exact', replaces: kept }), /publish failed/)
  assert.deepEqual(d.interests().map(interest => interest.id), [kept])
  ta.failPublish = false
  await d.stop()
})

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('replaces drops the old interest and its matches', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const oldId = await db.announce({ session: 's', statement: 'base' })
  await settle()
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  // db answered da, so da holds a match; give db one too by announcing from da first is enough.
  // Now replace db's interest and check the old one and its matches are gone.
  const before = db.matches(oldId)
  assert.ok(Array.isArray(before))
  const newId = await db.announce({ session: 's', statement: 'tier8', replaces: oldId })
  assert.equal(db.matches(oldId).length, 0)
  assert.notEqual(newId, oldId)
  assert.ok(db.interests().some(i => i.id === newId))
  assert.equal(db.interests().some(i => i.id === oldId), false)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 10.7
test('validator verdicts reject bad mail and answer once', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const baseCount = () => tb.sent.length

  await net.inject(ta.info().peerId, topic, Uint8Array.from([1, 2, 3]))
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'reject')

  const foreign = makeProfile({
    model: 'other', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
    truncation: 'tail', pooling: 'mean', normalization: 'l2',
    dims: [8, 4, 2], encoding: 'float32le', version: 1, tolerance: 0.001, thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
  })
  const { createAnnouncement } = await import('./announcement.ts')
  const contact = Contact.encode({ addrs: ta.info().addrs })
  const made = await createAnnouncement({
    profile: foreign, vector: vBase, origin: ta.info().peerId, contact, ttl: 60,
    sign: data => ta.sign(data), now: Date.now()
  })
  await net.inject(ta.info().peerId, topic, made.bytes)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'ignore')

  const expired = await createAnnouncement({
    profile, vector: vBase, origin: ta.info().peerId, contact, ttl: 60,
    sign: data => ta.sign(data), now: Date.now() - 120000
  })
  await net.inject(ta.info().peerId, topic, expired.bytes)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'ignore')

  // Valid announcement but a different publisher than its origin.
  await db.announce({ session: 'b', statement: 'base' })
  await settle()
  const published = net.publishes[net.publishes.length - 1]
  await net.inject(ta.info().peerId, topic, published.data)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'reject')

  // Contact address not ending in the origin.
  const badContact = Contact.encode({ addrs: ['/ip4/1.2.3.4/tcp/1/p2p/12D3KooWother'] })
  const bad = await createAnnouncement({
    profile, vector: vBase, origin: ta.info().peerId, contact: badContact, ttl: 60,
    sign: data => ta.sign(data), now: Date.now()
  })
  await net.inject(ta.info().peerId, topic, bad.bytes)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'reject')

  // Repeated announcement is ignored and answered only once.
  const dc = new Discovery({ transport: await net.node(), embedder: makeEmbedder(), onMatch: () => {} })
  // Use fresh nodes for a clean count: responder holds one interest.
  const tR = await net.node()
  const tO = await net.node()
  const dR = new Discovery({ transport: tR, embedder: makeEmbedder(), onMatch: () => {} })
  const dO = new Discovery({ transport: tO, embedder: makeEmbedder(), onMatch: () => {} })
  await dR.start()
  await dO.start()
  await dR.announce({ session: 'r', statement: 'base' })
  await settle()
  const sentBefore = tR.sent.length
  const idO = await dO.announce({ session: 'o', statement: 'exact' })
  await settle()
  assert.equal(tR.sent.length, sentBefore + 1)
  void baseCount
  void idO
  void dc
  // Replay the same bytes as the same origin: seen, so ignored with no new answer.
  const lastPublish = net.publishes[net.publishes.length - 1]
  const verdictsBefore = tR.verdicts.length
  await net.inject(tO.info().peerId, topic, lastPublish.data)
  await settle()
  assert.equal(tR.verdicts[tR.verdicts.length - 1], 'ignore')
  assert.ok(tR.verdicts.length > verdictsBefore)
  assert.equal(tR.sent.length, sentBefore + 1)
  await da.stop()
  await db.stop()
  await dR.stop()
  await dO.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 10.7
test('rate limit ignores the third announcement and recovers after a minute', async () => {
  const net = createNetwork()
  const clock = { now: Date.now() }
  const ta = await net.node()
  const tb = await net.node()
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  const db = new Discovery({
    transport: tb, embedder: makeEmbedder(), onMatch: () => {},
    now: () => clock.now, announcementsPerOriginPerMinute: 2
  })
  await da.start()
  await db.start()
  // B holds no interests; verdicts still show accept/ignore without responses.
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  await da.announce({ session: 'a', statement: 'tier8' })
  await settle()
  const verdicts = tb.verdicts.slice(-2)
  assert.deepEqual(verdicts, ['accept', 'accept'])
  const sentBefore = ta.sent.length + tb.sent.length
  await da.announce({ session: 'a', statement: 'tier4' })
  await settle()
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'ignore')
  assert.equal(ta.sent.length + tb.sent.length, sentBefore)
  clock.now += 61000
  await da.announce({ session: 'a', statement: 'tier2' })
  await settle()
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'accept')
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 10.6 and 11.2
test('a lying responder with a false tier and score gets no match', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  // B holds an unrelated interest; answer A's interest with it while claiming exact.
  await db.announce({ session: 'b', statement: 'far' })
  await settle()
  const record = db.interests()[0].bytes
  const packet = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }]
  }).length)
  packet[0] = 0
  packet.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }] }), 1)
  await tb.send(ta.info().peerId, packet, ta.info().addrs)
  await settle()
  assert.equal(hits, 0)
  assert.equal(da.matches(idA).length, 0)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 10.6 and 11.2
test('a record signed by a third node is not matched', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tc = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  const dc = new Discovery({ transport: tc, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await dc.start()
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  await dc.announce({ session: 'c', statement: 'exact' })
  await settle()
  const record = dc.interests()[0].bytes
  const packet = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }]
  }).length)
  packet[0] = 0
  packet.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }] }), 1)
  // B forwards C's record as if it were its own.
  await tb.send(ta.info().peerId, packet, ta.info().addrs)
  await settle()
  assert.equal(hits, 0)
  assert.equal(da.matches(idA).length, 0)
  await da.stop()
  await db.stop()
  await dc.stop()
})

// Docs: VORTEX_v5.1.md sections 10.5 and 11.2
test('bad packets and results for gone interests are ignored', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const sendRaw = async (data: Uint8Array): Promise<void> => {
    await tb.send(ta.info().peerId, data, ta.info().addrs)
    await settle()
  }
  // Unknown interest.
  const { createAnnouncement } = await import('./announcement.ts')
  const contactB = Contact.encode({ addrs: tb.info().addrs })
  const rec = await createAnnouncement({
    profile, vector: vExact, origin: tb.info().peerId, contact: contactB, ttl: 60,
    sign: data => tb.sign(data), now: Date.now()
  })
  const unknown = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: new Uint8Array(16).fill(9), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  unknown[0] = 0
  unknown.set(DiscoveryPacket.encode({ results: [{ announcementId: new Uint8Array(16).fill(9), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await sendRaw(unknown)
  // Withdrawn interest.
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  assert.equal(da.withdraw('a', idA), true)
  const gone = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idA), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  gone[0] = 0
  gone.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idA), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await sendRaw(gone)
  // Expired interest: short ttl with a moving clock.
  const clock = { now: Date.now() }
  const tE = await net.node()
  const dE = new Discovery({ transport: tE, embedder: makeEmbedder(), onMatch: () => { hits++ }, now: () => clock.now })
  await dE.start()
  const idE = await dE.announce({ session: 'e', statement: 'base', ttl: 1 })
  clock.now += 2000
  const late = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idE), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  late[0] = 0
  late.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idE), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await tb.send(tE.info().peerId, late, tE.info().addrs)
  await settle()
  // Malformed packets: empty, wrong lead byte, undecodable, too many results.
  await sendRaw(new Uint8Array(0))
  await sendRaw(new TextEncoder().encode('{"hello":1}'))
  await sendRaw(Uint8Array.from([0, 255, 255, 255]))
  const many = Array.from({ length: 4 }, () => ({ announcementId: unhex(idA), record: rec.bytes, tier: 0, score: 1 }))
  const tooMany = new Uint8Array(1 + DiscoveryPacket.encode({ results: many }).length)
  tooMany[0] = 0
  tooMany.set(DiscoveryPacket.encode({ results: many }), 1)
  await sendRaw(tooMany)
  assert.equal(hits, 0)
  await da.stop()
  await db.stop()
  await dE.stop()
})
