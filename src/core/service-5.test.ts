import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import type { DirectEvent, Embedder, GossipEvent, GossipHandler, Multiaddr, PeerId, Transport, TransportInfo } from '../types.ts'
import { createAnnouncement } from './announcement.ts'
import { Contact, DiscoveryPacket } from './proto/discovery.ts'
import { createNodeTransport } from '../net/node.ts'
import { encodeVector } from '../embed/vector.ts'
import { VortexService } from './service.ts'
import type { Conferences } from './conferences.ts'
import type { Snapshot, RoomSubscription } from './conversations.ts'
import { createDisclosurePolicy } from './disclosure.ts'
import { profile, table, fakeEmbedder, sleep, subjectHex, pair, LEGACY_TOPIC, until, singleService } from './service.testkit.ts'

test('overlapping leaves keep only the winner and never store twice', { timeout: 60000 }, async () => {
  let releaseEmbed!: () => void
  const gate = new Promise<void>(resolve => { releaseEmbed = resolve })
  let blockEmbed = false
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { if (blockEmbed) await gate; return embedder.embed(text) } } })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    const hostKey = sa.conferenceList('a').find(c => c.id === joined.id)!.key
    blockEmbed = true
    const first = sb.leaveConference('b', joined.id,
      { outcomes: [{ participant: hostKey, outcome: 'useful' as const }], statement: 'far' })
    const settled = first.then(() => 'resolved', (error: unknown) => error)
    await sleep(200)
    assert.equal(await sb.leaveConference('b', joined.id), true)
    releaseEmbed()
    blockEmbed = false
    await assert.rejects(first, /membership|changed|left|conference/)
    assert.equal((await settled) instanceof Error, true)
    assert.equal(sb.core().storedPeerMemory().length, 0)
    assert.deepEqual(sb.conferenceList('b'), [])
  } finally { releaseEmbed(); blockEmbed = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('unsubscribe ownership, stats privacy and match ordering', { timeout: 90000 }, async () => {
  let embedded = 0
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { embedded++; return embedder.embed(text) } } })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    for (const s of [sa, sb, sc]) await s.start()
    await sa.dial((await sb.info()).addrs[0])
    await sc.dial((await sa.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    const bInterest = await sb.announceStatement({ session: 'b', statement: 'exact' })
    const cInterest = await sc.announceStatement({ session: 'c', statement: 'tier8' })
    const infoA = await sa.info()
    const infoC = await sc.info()
    await until(() => {
      const peers = sb.matchesFor(bInterest.id).map(m => m.peer)
      return peers.includes(infoA.peerId) && peers.includes(infoC.peerId)
    })
    embedded = 0
    // Unsubscribe without an owned subscription stores nothing and embeds nothing.
    assert.equal(await sb.unsubscribeConference('b', 'f'.repeat(32)), false)
    assert.equal(await sb.unsubscribeConference('b', 'f'.repeat(32),
      { outcomes: [{ participant: 'ab'.repeat(32), outcome: 'useful' as const }] }), false)
    assert.equal(embedded, 0)
    assert.deepEqual(sb.core().storedPeerMemory(), [])
    // Wrong session feedback stores nothing.
    assert.equal(await sb.unsubscribeConference('wrong', 'f'.repeat(32),
      { outcomes: [{ participant: 'ab'.repeat(32), outcome: 'useful' as const }] }), false)
    assert.deepEqual(sb.core().storedPeerMemory(), [])
    // Plant ratings directly: B useful, C misleading, expired/foreign/other-peer neutral.
    const exactHex = Array.from(encodeVector(table.exact), byte => byte.toString(16).padStart(2, '0')).join('')
    const farHex = Array.from(encodeVector(table.far), byte => byte.toString(16).padStart(2, '0')).join('')
    const now = Date.now()
    const stranger = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
    await sb.core().recordPeerOutcomes([
      { peer: infoA.peerId, participant: 'cd'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: exactHex, outcome: 'useful', recordedAt: now - 1000, expires: now + 60000 },
      { peer: infoC.peerId, participant: 'cd'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: exactHex, outcome: 'misleading', recordedAt: now - 1000, expires: now + 60000 },
      { peer: stranger, participant: 'cd'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: exactHex, outcome: 'useful', recordedAt: now - 1000, expires: now + 60000 },
      { peer: infoA.peerId, participant: 'ef'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: farHex, outcome: 'useful', recordedAt: now - 1000, expires: now + 60000 }
    ])
    const ordered = sb.matchesFor(bInterest.id).map(m => m.peer)
    assert.ok(ordered.includes(infoA.peerId) && ordered.includes(infoC.peerId))
    assert.ok(ordered.indexOf(infoA.peerId) < ordered.indexOf(infoC.peerId))
    assert.ok(!ordered.includes(stranger))
    // Stats expose counts only.
    const stats = sb.peerMemoryStats()
    assert.deepEqual(Object.keys(stats).sort(), ['bytes', 'count'])
    assert.equal(stats.count, 4)
    for (const view of [sb.subscriptions(), sb.conferenceList()]) {
      assert.ok(!JSON.stringify(view).includes('cd'.repeat(32)))
    }
    // Expired and other-profile records score neutral through direct lookup.
    assert.equal(sb.core().peerOutcome(infoA.peerId, table.exact, profile), 'useful')
    assert.equal(sb.core().peerOutcome(infoC.peerId, table.exact, profile), 'misleading')
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}); await sc.stop().catch(() => {}) }
})

test('review: ordinary unsubscribe observes queued subscription creation', { timeout: 30000 }, async () => {
  let blocked = false, hold = false
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { sa, sb, stop } = await pair(undefined, s => {
    if (hold && s.subscriptions && Object.keys(s.subscriptions).length) { blocked = true; return gate }
  })
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    hold = true
    const subscribing = sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await until(() => blocked)
    const removing = sb.unsubscribeConference('guest', room.id)
    hold = false; release()
    await subscribing
    assert.equal(await removing, true)
    assert.deepEqual(sb.subscriptions('guest'), [])
  } finally { hold = false; release(); await stop() }
})

test('review: feedback refuses a vector outside the actual profile', { timeout: 30000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    const embedder = (sb as unknown as { embedder: Embedder }).embedder
    embedder.embed = async () => Float32Array.from([1, 0, 0, 0])
    await assert.rejects(sb.leaveConference('guest', room.id, {
      outcomes: [{ participant: sa.conferenceList('host')[0].key, outcome: 'useful' }], statement: 'base'
    }), /subject|vector|profile/)
    assert.equal(sb.core().storedPeerMemory().length, 0)
    assert.equal(sb.conferenceList('guest').length, 1)
  } finally { await stop() }
})

test('renewal during feedback embedding keeps the renewed subscription', { timeout: 60000 }, async () => {
  let releaseEmbed!: () => void
  const gate = new Promise<void>(resolve => { releaseEmbed = resolve })
  let blockEmbed = false
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { if (blockEmbed) await gate; return embedder.embed(text) } } })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 300 })
    const hostKey = sa.conferenceList('a').find(c => c.id === joined.id)!.key
    blockEmbed = true
    const leaving = sb.leaveConference('b', joined.id,
      { outcomes: [{ participant: hostKey, outcome: 'useful' as const }], statement: 'far' })
    const settled = leaving.then(() => 'resolved', (error: unknown) => error)
    await sleep(200)
    const renewed = await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 600 })
    releaseEmbed()
    blockEmbed = false
    await assert.rejects(leaving, /membership changed during feedback/)
    assert.equal((await settled) instanceof Error, true)
    assert.equal(sb.core().storedSubscriptions()[joined.id].expires, renewed.expires)
    assert.ok(sb.conferenceList('b').some(c => c.id === joined.id))
    assert.deepEqual(sb.core().storedPeerMemory(), [])
  } finally { releaseEmbed(); blockEmbed = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('review: unsubscribe feedback expires after a concurrent engine leave', { timeout: 15000 }, async () => {
  let hold = false, blocked = false
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { sa, sb, stop } = await pair(undefined, s => {
    if (hold && s.peerMemory?.length) { blocked = true; return gate }
  })
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await until(() => !(sb as unknown as { recovery: Map<string, { active: boolean }> }).recovery.get(room.id)?.active)
    const local = sb as unknown as { peerMemoryTtl: number }
    local.peerMemoryTtl = 1
    hold = true
    const leaving = sb.unsubscribeConference('guest', room.id, {
      outcomes: [{ participant: sa.conferenceList('host')[0].key, outcome: 'useful' }]
    })
    await until(() => blocked)
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    await engine.leave(room.id, 'guest')
    hold = false; release()
    await leaving
    await sb.core().flush()
    await until(() => sb.core().storedPeerMemory().length === 0, 2500)
  } finally { hold = false; release(); await stop() }
})

test('explicit feedback override stores its private source and vector', { timeout: 30000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    let embedded = 0
    const embedder = (sb as unknown as { embedder: Embedder }).embedder
    const embed = embedder.embed.bind(embedder)
    embedder.embed = async text => { embedded++; return embed(text) }
    assert.equal(await sb.leaveConference('guest', room.id, {
      outcomes: [{ participant: sa.conferenceList('host')[0].key, outcome: 'useful' }], statement: 'far'
    }), true)
    assert.equal(embedded, 1)
    const record = sb.core().storedPeerMemory()[0]
    assert.equal(record.statement, 'far')
    assert.equal(record.vector, subjectHex('far'))
    assert.equal(record.namespace, profile.id)
    assert.ok(!JSON.stringify(sb.core().read(0)).includes('far'))
  } finally { await stop() }
})

test('review: restored memory bounds retry a failed durable save', { timeout: 10000 }, async () => {
  const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const now = Date.now()
  const record = { peer, participant: 'aa'.repeat(32), namespace: profile.id, profileVersion: 1,
    statement: 'base', vector: subjectHex('base'), outcome: 'useful' as const,
    recordedAt: now - 1000, expires: now + 3600000 }
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    peerMemory: [record, { ...record, participant: 'bb'.repeat(32), recordedAt: now }] }
  let fail = true
  const errors: string[] = []
  const s = new VortexService(await createNodeTransport(), 'bounds', () => {
    if (fail) throw new Error('disk full')
  }, restored, { embedder: fakeEmbedder(), peerMemory: { maxCount: 1 }, onError: m => errors.push(m) })
  try {
    await s.start()
    await until(() => errors.length > 0, 1000)
    assert.equal(s.core().storedPeerMemory().length, 2)
    fail = false
    await until(() => s.core().storedPeerMemory().length === 1, 3500)
  } finally { fail = false; await s.stop() }
})

test('review: peer memory expiry backs off and saves when storage recovers', { timeout: 10000 }, async () => {
  const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const now = Date.now()
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0, peerMemory: [{
    peer, participant: 'aa'.repeat(32), namespace: profile.id, profileVersion: 1,
    statement: 'base', vector: subjectHex('base'), outcome: 'useful',
    recordedAt: now - 1000, expires: now + 150 }] }
  let fail = true, saves = 0
  const errors: string[] = []
  const s = new VortexService(await createNodeTransport(), 'expiry', () => {
    saves++; if (fail) throw new Error('disk full')
  }, restored, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  try {
    await s.start()
    await until(() => errors.length > 0, 1500)
    await sleep(200)
    assert.equal(s.core().storedPeerMemory().length, 1)
    assert.equal(saves, 1)
    fail = false
    await until(() => s.core().storedPeerMemory().length === 0, 3500)
    assert.equal(saves, 2)
  } finally { fail = false; await s.stop() }
})

// Docs: VORTEX_v5.1.md §§4–5; skills/vortex/SKILL.md (one topic = one thread).
test('a direct message about an owned conference topic is routed to it; others and embed failures stay plain', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base', capacity: 2 })
    const direct = await sb.core().invite(infoA.peerId)
    await sa.core().wait(undefined, 10000)
    await sa.core().accept(direct)
    await sb.core().wait(undefined, 10000)
    for (const body of ['exact', 'far', 'not in the embedder table']) await sb.core().send(direct, body)
    await until(() => sa.core().read(0).events.filter(event => event.kind === 'message').length === 3)
    const messages = sa.core().read(0).events.filter(event => event.kind === 'message')
    assert.deepEqual(messages.map(event => [event.body, event.room, event.routingConference, event.tier]), [
      ['exact', direct, room.id, 'exact'],
      ['far', direct, undefined, undefined],
      ['not in the embedder table', direct, undefined, undefined]
    ])
    // The sender holds no conference: nothing to route against, so its events carry no routing.
    await sa.core().send(direct, 'exact')
    await until(() => sb.core().read(0).events.some(event => event.kind === 'message'))
    assert.equal(sb.core().read(0).events.find(event => event.kind === 'message')?.routingConference, undefined)
  } finally { await stop() }
})
