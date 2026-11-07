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

test('unknown refs send nothing and unanswered joins time out without retaining a pending join', { timeout: 60000 }, async () => {
  const { sa, sb, stop, sentTo } = await pair()
  try {
    const before = sentTo.length
    await assert.rejects(sb.joinConference({ session: 'b', ref: 'f'.repeat(32) }), /no match with that record: read your match events and use the record of one/)
    assert.equal(sentTo.length, before)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    // The holder keeps its transport but has no conference handler answering joins.
    ;(sa as unknown as { conferences: { stop: () => void } }).conferences.stop()
    for (let i = 0; i < 2; i++) {
      const started = Date.now()
      await assert.rejects(sb.joinConference({ session: 'b', ref: a.id }, 500), /join timed out: the holder did not answer/)
      assert.ok(Date.now() - started < 2000)
      assert.deepEqual(sb.conferenceList(), [])
    }
    for (const text of ['', 'é'.repeat(8193)]) {
      await assert.rejects(sb.postToConference({ session: 'b', conference: a.id, text }), /1–16384 bytes/)
    }
    assert.equal(await sb.leaveConference('b', 'f'.repeat(32)), false)
  } finally { await stop() }
})
// Docs: VORTEX_v5.1.md section 9.3

test('a failed conference save reports once with fixed text and conference events survive restart', { timeout: 60000 }, async () => {
  let failMessage = false
  let saved: Snapshot | undefined
  const errors: string[] = []
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', s => {
    if (failMessage && s.events.at(-1)?.kind === 'conference_message') throw new Error('peer text in disk error')
    saved = s
  }, undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sa.start(); await sb.start()
    await sa.dial(sb.info().addrs[0]); await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await until(() => sa.core().read(0).events.some(e => e.kind === 'arrival'))
    failMessage = true
    await sb.postToConference({ session: 'b', conference: a.id, text: 'lost words' })
    await until(() => errors.length > 0)
    assert.deepEqual(errors, ['conference event for ' + a.id + ' could not be saved'])
    assert.ok(!sa.core().read(0).events.some(e => e.body === 'lost words'))
    failMessage = false
    await sb.postToConference({ session: 'b', conference: a.id, text: 'kept words' })
    await until(() => sa.core().read(0).events.some(e => e.body === 'kept words'))
  } finally { await sa.stop(); await sb.stop() }
  const restored = new VortexService(await createNodeTransport(), 'a', () => {}, saved, { embedder: fakeEmbedder() })
  try {
    await restored.start()
    assert.ok(restored.core().read(0).events.some(e => e.body === 'kept words'))
    assert.deepEqual(restored.conferenceList(), [])
  } finally { await restored.stop() }
})
// Docs: VORTEX_v5.1.md section 9.1

test('conference methods require semantic discovery', async () => {
  const service = new VortexService(await createNodeTransport(), 'a', () => {})
  try {
    await service.start()
    await assert.rejects(service.joinConference({ session: 's', ref: 'a'.repeat(32) }), /not enabled/)
    await assert.rejects(service.postToConference({ session: 's', conference: 'a'.repeat(32), text: 'hi' }), /not enabled/)
    await assert.rejects(service.leaveConference('s', 'a'.repeat(32)), /not enabled/)
    assert.throws(() => service.conferenceList(), /not enabled/)
  } finally { await service.stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1, 6.3, 10.6 and 11.2
test('a later service discovers and joins the same hosted room after its forming interest is withdrawn', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, stop } = await pair()
  const tc = await createNodeTransport()
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sc.start()
    await sc.dial(infoA.addrs[0]); await sc.dial(infoB.addrs[0])
    await sleep(2500)
    const first = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: first.id })
    assert.equal(sa.withdrawInterest('a', first.id), true)
    const third = await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.matchesFor(third.id).some(m => m.record === first.id && m.kind === 'conference'))
    const match = sc.matchesFor(third.id).find(m => m.record === first.id)!
    assert.deepEqual(Object.keys(match).sort(), ['addrs', 'admission', 'capacity', 'count', 'expires', 'fullScore', 'host', 'kind', 'peer', 'record', 'score', 'tier'])
    assert.equal(match.count, 2)
    assert.equal(match.host, infoA.peerId)
    assert.deepEqual(sc.conferenceList(), [])
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === first.id))
    const event = sc.core().read(0).events.find(e => e.kind === 'match' && e.record === first.id)!
    assert.equal(event.recordKind, 'conference')
    await assert.rejects(sc.joinConference({ session: 'unknown', ref: first.id }), /no match/)
    const joined = await sc.joinConference({ session: 'c', ref: first.id })
    assert.equal(joined.id, first.id)
    assert.equal(joined.count, 3)
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.kind === 'arrival' && e.participant === joined.key)))
    const posted = await sc.postToConference({ session: 'c', conference: first.id, text: 'later arrival' })
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.message === posted.message)))
    for (const service of [sa, sb]) {
      assert.equal(service.core().read(0).events.filter(e => e.kind === 'arrival' && e.participant === joined.key).length, 1)
      assert.equal(service.core().read(0).events.filter(e => e.message === posted.message).length, 1)
    }
    // The same participant can leave, rediscover the host without its forming interest, and rejoin.
    assert.equal(await sc.leaveConference('c', first.id), true)
    await until(() => sa.conferenceList()[0].count === 2 && sb.conferenceList()[0].count === 2)
    const rediscovered = await sc.announceStatement({ session: 'c', statement: 'tier8', replaces: third.id })
    await until(() => sc.matchesFor(rediscovered.id).some(m => m.record === first.id && m.kind === 'conference'))
    const rejoined = await sc.joinConference({ session: 'c', ref: first.id })
    assert.equal(rejoined.id, first.id)
    assert.notEqual(rejoined.key, joined.key)
    assert.equal(rejoined.count, 3)
    const returned = await sc.postToConference({ session: 'c', conference: first.id, text: 'back again' })
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.message === returned.message)))
    for (const service of [sa, sb]) {
      assert.equal(service.core().read(0).events.find(e => e.message === returned.message)?.participant, rejoined.key)
    }
    await sa.leaveConference('a', first.id)
    const afterClose = await sc.announceStatement({ session: 'c2', statement: 'base' })
    await sleep(500)
    assert.equal(sc.matchesFor(afterClose.id).some(m => m.record === first.id), false)
  } finally { await sc.stop(); await stop() }
})

// Docs: VORTEX_v5.1.md sections 6.2, 6.3 and 10.2
test('an explicitly created group room is discovered without a forming interest, then admits its selected peer', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base', capacity: 2,
      admission: 'group', peers: [infoB.peerId] })
    assert.equal(room.role, 'host')
    assert.equal(room.count, 1)
    assert.equal(room.admission, 'group')
    assert.deepEqual(sa.openInterests(), [])
    await until(() => sa.core().read(0).events.some(event => event.kind === 'formed' && event.conference === room.id))
    await sa.postToConference({ session: 'host', conference: room.id, text: 'before the guest joined' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(match => match.record === room.id))
    const match = sb.matchesFor(interest.id).find(match => match.record === room.id)!
    assert.equal(match.kind, 'conference')
    assert.equal(match.admission, 'group')
    assert.equal(match.peer, infoA.peerId)
    const joined = await sb.joinConference({ session: 'guest', ref: room.id })
    assert.equal(joined.count, 2)
    const cursor = sb.core().read(0).cursor
    const history = await sb.conferenceHistory({ session: 'guest', conference: room.id, limit: 1 })
    assert.equal(history.historyCursor, 1)
    assert.equal('cursor' in history, false)
    assert.equal(history.messages[0].body, 'before the guest joined')
    assert.equal(history.messages[0].service, infoA.peerId)
    assert.equal(sb.core().read(0).cursor, cursor)
    const sent = await sb.postToConference({ session: 'guest', conference: room.id, text: 'explicit room works' })
    await until(() => sa.core().read(0).events.some(event => event.message === sent.message))
    await sb.leaveConference('guest', room.id)
    await assert.rejects(sb.conferenceHistory({ session: 'guest', conference: room.id }), /not in this conference/)
    await until(() => sa.conferenceList()[0].count === 1)
    await sb.joinConference({ session: 'guest', ref: room.id })
  } finally { await stop() }
})

test('explicit creation checks disclosure and input before inference or signing', async () => {
  const transport = await createNodeTransport()
  let embeds = 0, signs = 0
  const embedder = fakeEmbedder()
  const service = new VortexService({ ...transport, sign: async data => { signs++; return transport.sign(data) } },
    'test', () => {}, undefined, { embedder: { ...embedder, embed: async text => { embeds++; return embedder.embed(text) } },
      disclosure: createDisclosurePolicy({ blockedProjectIds: ['blocked'] }) })
  try {
    await service.start()
    const before = { embeds, signs }
    await assert.rejects(service.createConference({ session: 's', statement: 'blocked' }), /disclosure/)
    await assert.rejects(service.createConference({ session: 's', statement: 'base', capacity: 1 }), /capacity/)
    await assert.rejects(service.createConference({ session: '', statement: 'base' }), /session/)
    assert.deepEqual({ embeds, signs }, before)
    assert.deepEqual(service.conferenceList(), [])
  } finally { await service.stop() }
})

test('explicit creation cannot survive service stop during embedding', async () => {
  const embedder = fakeEmbedder()
  let release = () => {}, entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined,
    { embedder: { ...embedder, embed: async text => { entered(); await gate; return embedder.embed(text) } } })
  await service.start()
  const pending = service.createConference({ session: 's', statement: 'base' }).catch(error => error)
  try {
    await ready
    await service.stop()
    release()
    assert.match((await pending).message, /stopped/)
    assert.deepEqual(service.conferenceList(), [])
  } finally { release(); await service.stop() }
})

test('explicit creation uses captured options across operator approval', async () => {
  let release = () => {}, entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const statements: string[] = []
  const embedder = fakeEmbedder()
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined, {
    embedder: { ...embedder, embed: async text => { statements.push(text); return embedder.embed(text) } },
    disclosure: createDisclosurePolicy({ requireApproval: true }, async () => { entered(); await gate })
  })
  const request = { session: 'original', statement: 'base', capacity: 3, admission: 'group' as const, peers: [peer] }
  await service.start()
  const pending = service.createConference(request)
  try {
    await ready
    request.session = 'changed'; request.statement = 'far'; request.capacity = 1; request.peers[0] = 'invalid'
    release()
    const room = await pending
    assert.equal(room.session, 'original')
    assert.equal(room.capacity, 3)
    assert.equal(room.admission, 'group')
    assert.deepEqual(statements, ['base'])
  } finally { release(); await service.stop() }
})

test('subscribe validates membership, session ownership, ttl bounds and clips to room expiry', async () => {
  const service = await singleService()
  try {
    const room = await service.createConference({ session: 'host', statement: 'base' })
    const request = { session: 'host', conference: room.id, ttl: 3600 }
    const sub = await service.subscribeConference(request)
    request.ttl = 1
    assert.deepEqual(Object.keys(sub).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session'])
    assert.equal(sub.conference, room.id)
    assert.equal(sub.session, 'host')
    assert.ok(sub.expires <= Date.now() + 3600 * 1000 && sub.expires > Date.now())
    await assert.rejects(service.subscribeConference({ session: 'host', conference: room.id, ttl: 0 }), /ttl|expiry|range/)
    await assert.rejects(service.subscribeConference({ session: 'host', conference: room.id, ttl: 86401 }), /ttl|expiry|range/)
    await assert.rejects(service.subscribeConference({ session: 'other', conference: room.id, ttl: 60 }), /member|session|conference/)
    await assert.rejects(service.subscribeConference({ session: 'host', conference: 'f'.repeat(32), ttl: 60 }), /member|conference/)
    await assert.rejects(service.subscribeConference({ session: 'host', conference: 'bad', ttl: 60 }), /conference|invalid/)
    assert.throws(() => new VortexService(service.info() as never, 'x', () => {}, undefined, { embedder: fakeEmbedder(), subscriptions: { maxCount: 0 } } as never), /subscri/)
    assert.throws(() => new VortexService(service.info() as never, 'x', () => {}, undefined, { embedder: fakeEmbedder(), subscriptions: { maxTtl: 604801 } } as never), /subscri|ttl/)
  } finally { await service.stop() }
})

test('host omits membership privately while participant stores hex, and public outputs stay private', async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const hostSub = await sa.subscribeConference({ session: 'host', conference: room.id, ttl: 120 })
    assert.deepEqual(Object.keys(hostSub).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session'])
    const hostStored = sa.core().storedSubscriptions()[room.id]
    assert.equal(hostStored.membership, undefined)
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    const joined = await sb.joinConference({ session: 'guest', ref: room.id })
    const guestSub = await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 120 })
    assert.deepEqual(Object.keys(guestSub).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session'])
    const stored = sb.core().storedSubscriptions()[room.id]
    assert.match(stored.membership!.descriptor, /^[0-9a-f]+$/)
    assert.match(stored.membership!.privateKey, /^[0-9a-f]+$/)
    assert.ok(!JSON.stringify(guestSub).includes(stored.membership!.privateKey))
    assert.ok(!JSON.stringify(sb.core().read().events).includes(stored.membership!.privateKey))
    assert.ok(!JSON.stringify(sb.subscriptions()).includes(stored.id))
    void joined
  } finally { await stop() }
})

test('subscription count limit, renewal preserves cursor and reschedules expiry', async () => {
  const service = await singleService({ subscriptions: { maxCount: 2, maxTtl: 3600 } })
  try {
    const r1 = await service.createConference({ session: 's', statement: 'base' })
    const r2 = await service.createConference({ session: 's', statement: 'base' })
    const r3 = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: r1.id, ttl: 100 })
    await service.subscribeConference({ session: 's', conference: r2.id, ttl: 100 })
    await assert.rejects(service.subscribeConference({ session: 's', conference: r3.id, ttl: 100 }), /too many|subscri/)
    const first = service.subscriptions('s').find(s => s.conference === r1.id)!
    const renewed = await service.subscribeConference({ session: 's', conference: r1.id, ttl: 200 })
    assert.equal(renewed.historyCursor, first.historyCursor)
    assert.ok(renewed.expires >= first.expires)
    assert.equal(service.subscriptions('s').length, 2)
  } finally { await service.stop() }
})

test('expired subscription is removed durably and membership is left', { timeout: 15000 }, async () => {
  const service = await singleService()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 1 })
    assert.equal(service.subscriptions('s').length, 1)
    await until(() => service.subscriptions('s').length === 0, 8000)
    assert.deepEqual(service.conferenceList('s'), [])
  } finally { await service.stop() }
})

test('failed subscription save preserves membership and retries expiry without spinning', { timeout: 15000 }, async () => {
  const errors: string[] = []
  let fail = true
  let saves = 0
  const service = new VortexService(await createNodeTransport(), 'test', () => { saves++; if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    fail = true
    await assert.rejects(service.subscribeConference({ session: 's', conference: room.id, ttl: 60 }), /disk full/)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.equal(service.conferenceList('s').length, 1)
    fail = false
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 1 })
    fail = true
    await until(() => errors.some(m => m === 'subscription expiry could not be saved'), 8000)
    const expiryErrors = (): string[] => errors.filter(m => m === 'subscription expiry could not be saved')
    const seen = expiryErrors().length
    await sleep(1500)
    assert.ok(expiryErrors().length - seen <= 2, 'bounded retries, no spin')
    assert.ok(!expiryErrors().some(m => m.includes('disk')), 'generic error, no cache detail')
    fail = false
    await until(() => service.subscriptions('s').length === 0, 8000)
  } finally { await service.stop() }
})

test('blocked renewal queued ahead of stale expiry keeps the renewed subscription', { timeout: 15000 }, async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 1 })
    block = true
    const renewal = service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    await sleep(1300)
    release()
    await renewal
    await sleep(300)
    assert.equal(service.subscriptions('s').length, 1)
    assert.equal(service.conferenceList('s').length, 1)
    assert.ok(service.subscriptions('s')[0].expires > Date.now() + 200 * 1000)
  } finally { release(); await service.stop() }
})

test('pending leave spanning stop settles without recreating maintenance work', { timeout: 15000 }, async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    block = true
    const leaving = service.leaveConference('s', room.id)
    await sleep(100)
    const stopping = service.stop()
    await sleep(100)
    release()
    await leaving.catch(() => {})
    await stopping
    await sleep(1300)
    assert.equal((service as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
  } finally { release(); await service.stop().catch(() => {}) }
})

test('failed close retries and removes the subscription without spinning', { timeout: 60000 }, async () => {  const errors: string[] = []
  let fail = false
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  try {
    await sa.start()
    await sb.start()
    await sa.dial(sb.info().addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyHex = sb.core().storedSubscriptions()[room.id].membership!.privateKey
    fail = true
    await sa.leaveConference('host', room.id)
    await until(() => errors.some(m => m === 'subscription close could not be saved'), 10000)
    assert.equal(sb.subscriptions('guest').length, 1)
    const closeErrors = (): string[] => errors.filter(m => m === 'subscription close could not be saved')
    const seen = closeErrors().length
    await sleep(1500)
    assert.ok(closeErrors().length - seen <= 2, 'bounded retries, no spin')
    assert.ok(!errors.some(m => m.includes(keyHex)), 'no key material in errors')
    fail = false
    await until(() => sb.subscriptions('guest').length === 0, 10000)
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})
