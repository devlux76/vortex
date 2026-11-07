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

test('failed orphan host cleanup retries after saves recover, participant subs remain', { timeout: 20000 }, async () => {  const errors: string[] = []
  let fail = false
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    await service.core().setSubscription({ conference: 'f'.repeat(32), session: 'p', host: 'h',
      expires: Date.now() + 300000, membership: { descriptor: 'aa', privateKey: 'bb' } })
    await service.stop()
    fail = true
    await service.start()
    await until(() => errors.some(m => m === 'subscription close could not be saved'), 8000)
    assert.equal(service.subscriptions('s').length, 1)
    fail = false
    await until(() => service.subscriptions('s').length === 0, 8000)
    assert.equal(service.subscriptions('p').length, 1)
  } finally { fail = false; await service.stop().catch(() => {}) }
})

test('unsubscribe removes durably then leaves, and ordinary leave removes same-session subscription', async () => {
  const service = await singleService()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 120 })
    assert.equal(await service.unsubscribeConference('s', room.id), true)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.deepEqual(service.conferenceList('s'), [])
    assert.equal(await service.unsubscribeConference('s', room.id), false)
    const room2 = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room2.id, ttl: 120 })
    assert.equal(await service.leaveConference('s', room2.id), true)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.equal(await service.leaveConference('wrong', room2.id), false)
  } finally { await service.stop() }
})

test('stop preserves subscriptions and same-instance restart retains participant state while ending orphan host rooms', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    await sa.subscribeConference({ session: 'host', conference: room.id, ttl: 300 })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sb.stop()
    await sb.start()
    assert.equal(sb.subscriptions('guest').length, 1)
    await sa.stop()
    await sa.start()
    await until(() => sa.subscriptions('host').length === 0, 8000)
    void infoA
  } finally { await stop() }
})

test('closed room ends its subscription durably', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    assert.equal(sb.subscriptions('guest').length, 1)
    await sa.leaveConference('host', room.id)
    await until(() => sb.subscriptions('guest').length === 0, 10000)
  } finally { await stop() }
})

test('blocked leave spanning stop/restart throws without touching the new run', { timeout: 20000 }, async () => {
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
    const settled = leaving.then(() => 'resolved', (error: unknown) => error)
    await sleep(100)
    const stopping = service.stop()
    await sleep(100)
    release()
    await stopping
    await service.start()
    block = false
    assert.match((await settled as Error).message, /stopped during leave/)
    await sleep(200)
    assert.equal((service as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
    assert.deepEqual(service.conferenceList('s'), [])
  } finally { release(); await service.stop().catch(() => {}) }
})

test('failing expiry backs off while unrelated renews reschedule', { timeout: 20000 }, async () => {
  const errors: string[] = []
  let fail = false
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    const expiring = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: expiring.id, ttl: 1 })
    const other = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: other.id, ttl: 300 })
    fail = true
    const expiryErrors = (): string[] => errors.filter(m => m === 'subscription expiry could not be saved')
    await until(() => expiryErrors().length >= 1, 8000)
    fail = false
    await service.subscribeConference({ session: 's', conference: other.id, ttl: 300 })
    fail = true
    const atRenew = expiryErrors().length
    await sleep(25)
    assert.equal(expiryErrors().length, atRenew, 'no retry within 25ms of an unrelated reschedule')
    await sleep(1500)
    assert.ok(expiryErrors().length - atRenew <= 2, 'bounded retries, no spin')
    fail = false
    await until(() => service.subscriptions('s').find(s => s.conference === expiring.id) === undefined, 8000)
    assert.equal(service.subscriptions('s').length, 1)
  } finally { fail = false; await service.stop().catch(() => {}) }
})

test('subscribe save spanning room close rejects without leaving an orphan', async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    block = true
    const pending = service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    const settled = pending.then(() => 'resolved', (error: unknown) => error)
    await sleep(100)
    // Close at the engine level without touching the subscription store.
    const engine = (service as unknown as { conferences: { leave: (c: string, s: string) => Promise<boolean> } }).conferences
    await engine.leave(room.id, 's')
    release()
    assert.match(((await settled) as Error).message, /closed during subscribe/)
    await until(() => service.subscriptions('s').length === 0, 5000)
  } finally { release(); await service.stop().catch(() => {}) }
})

// Docs: VORTEX_v5.1.md section 6.5 — automatic subscription recovery and replay.
test('restarted participant resumes same key and replays missed history', { timeout: 90000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyBefore = sb.conferenceList('guest')[0].key
    const privateHex = sb.core().storedSubscriptions()[room.id].membership!.privateKey
    await sb.stop()
    const m1 = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    const m2 = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed two' })
    await sb.start()
    await until(() => sb.core().read(0).events.some(e => e.message === m1.message), 30000)
    await until(() => sb.core().read(0).events.some(e => e.message === m2.message), 30000)
    assert.equal(sb.conferenceList('guest')[0].key, keyBefore)
    assert.equal(sa.conferenceList('host')[0].count, 2)
    // Renew during recovery must not duplicate; live posts arrive exactly once.
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const m3 = await sa.postToConference({ session: 'host', conference: room.id, text: 'live after' })
    await until(() => sb.core().read(0).events.some(e => e.message === m3.message), 30000)
    await sleep(500)
    assert.equal(sb.core().read(0).events.filter(e => e.message === m3.message).length, 1)
    assert.equal(sb.core().read(0).events.filter(e => e.message === m1.message).length, 1)
    const pub = JSON.stringify({ subs: sb.subscriptions(), events: sb.core().read(0).events })
    assert.ok(!pub.includes(privateHex))
  } finally { await stop() }
})

test('recovery save failure keeps cursor and retries after saves recover', { timeout: 90000 }, async () => {
  const errors: string[] = []
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
    await sb.stop()
    await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    fail = true
    await sb.start()
    await until(() => errors.some(m => m === 'subscription recovery failed'), 20000)
    assert.equal(sb.core().storedSubscriptions()[room.id].historyCursor, 0)
    assert.deepEqual(sb.core().read(0).events.filter(e => e.kind === 'conference_message'), [])
    assert.ok(!errors.some(m => m.includes('disk')))
    fail = false
    await until(() => sb.core().read(0).events.some(e => e.body === 'missed one'), 20000)
  } finally { fail = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('wrong-room and malformed private cache cause no sends', async () => {
  const sent: string[] = []
  const raw = await createNodeTransport()
  const transport = { ...raw,
    send: async (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]): Promise<void> => {
      sent.push(peer)
      return raw.send(peer, data, addrs)
    } }
  const hostKey = await generateKeyPair('Ed25519')
  const hostPeer = peerIdFromPrivateKey(hostKey).toString()
  const mismatched = '0f'.repeat(16)
  const { createDescriptor } = await import('./conference-records.ts')
  const { bytes } = await createDescriptor({ id: mismatched, profile, topicVector: table.exact,
    host: hostPeer, addrs: [`/ip4/127.0.0.1/tcp/1/p2p/${hostPeer}`], participantCount: 1, capacity: 8,
    admission: 'open', createdAt: Date.now() - 1000, expiresAt: Date.now() + 3600000,
    sign: async data => hostKey.sign(data), now: Date.now() })
  const descriptorHex = Buffer.from(bytes).toString('hex')
  const sub = (conference: string, host: string, membership: { descriptor: string, privateKey: string }): RoomSubscription => ({
    id: 'sub-' + conference.slice(0, 8), conference, session: 's', host,
    expires: Date.now() + 300000, historyCursor: 0, membership
  })
  const errors: string[] = []
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [subConfWrongRoom()]: sub(subConfWrongRoom(), hostPeer, { descriptor: descriptorHex, privateKey: 'aa' }),
      [subConfMalformed()]: sub(subConfMalformed(), hostPeer, { descriptor: 'zz', privateKey: 'aa' }),
      [subConfUndecodable()]: sub(subConfUndecodable(), hostPeer, { descriptor: 'aa'.repeat(10), privateKey: 'aa' })
    } }
  const service = new VortexService(transport, 'b', () => {}, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await sleep(1500)
    assert.deepEqual(sent, [])
    assert.deepEqual(service.conferenceList('s'), [])
    assert.equal(service.subscriptions('s').length, 3)
    assert.ok(errors.length >= 1)
    assert.ok(errors.every(m => m === 'subscription recovery failed'))
  } finally { await service.stop().catch(() => {}) }
  function subConfWrongRoom (): string { return 'aa'.repeat(16) }
  function subConfMalformed (): string { return 'bb'.repeat(16) }
  function subConfUndecodable (): string { return 'cc'.repeat(16) }
})

test('unsubscribe and stop cancel pending recovery without resurrection', { timeout: 30000 }, async () => {
  const errors: string[] = []
  const conf = 'dd'.repeat(16)
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [conf]: { id: 'sub-id', conference: conf, session: 's', host: 'h',
        expires: Date.now() + 300000, historyCursor: 0,
        membership: { descriptor: 'aa'.repeat(10), privateKey: 'bb' } }
    } }
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await until(() => errors.length >= 1, 8000)
    assert.deepEqual(errors, ['subscription recovery failed'])
    assert.equal(await service.unsubscribeConference('s', conf), true)
    await sleep(2000)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.deepEqual(errors, ['subscription recovery failed'])
    await service.stop()
    await sleep(1200)
    assert.deepEqual(errors, ['subscription recovery failed'])
    assert.equal((service as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
  } finally { await service.stop().catch(() => {}) }
})

test('wrong-session and failed-save unsubscribe keep owner recovery alive', { timeout: 30000 }, async () => {
  const errors: string[] = []
  let fail = false
  const conf = 'ee'.repeat(16)
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [conf]: { id: 'sub-id', conference: conf, session: 's', host: 'h',
        expires: Date.now() + 300000, historyCursor: 0,
        membership: { descriptor: 'aa'.repeat(10), privateKey: 'bb' } }
    } }
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (fail) throw new Error('disk full') }, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await until(() => errors.length >= 1, 8000)
    assert.equal(await service.unsubscribeConference('wrong', conf), false)
    assert.equal(service.subscriptions('s').length, 1)
    await until(() => errors.length >= 2, 8000)
    fail = true
    await assert.rejects(service.unsubscribeConference('s', conf), /disk full/)
    assert.equal(service.subscriptions('s').length, 1)
    fail = false
    await until(() => errors.length >= 3, 10000)
    assert.equal(await service.unsubscribeConference('s', conf), true)
    const settled = errors.length
    await sleep(1500)
    assert.equal(errors.length, settled)
    assert.deepEqual(service.subscriptions('s'), [])
  } finally { fail = false; await service.stop().catch(() => {}) }
})

test('reconnect during backoff waits for the retry deadline', { timeout: 30000 }, async () => {
  const errors: string[] = []
  const conf = 'ef'.repeat(16)
  const tc = await createNodeTransport()
  await tc.start()
  const hostPeer = tc.info().peerId
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [conf]: { id: 'sub-id', conference: conf, session: 's', host: hostPeer,
        expires: Date.now() + 300000, historyCursor: 0,
        membership: { descriptor: 'aa'.repeat(10), privateKey: 'bb' } }
    } }
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await until(() => errors.length >= 1, 8000)
    await tc.dial(service.info().addrs[0])
    const atConnect = errors.length
    await sleep(300)
    assert.equal(errors.length, atConnect)
    await until(() => errors.length > atConnect, 8000)
    assert.ok(errors.every(m => m === 'subscription recovery failed'))
  } finally { await tc.stop().catch(() => {}); await service.stop().catch(() => {}) }
})

test('transport reconnect replays missed posts without restarting room membership', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sa.postToConference({ session: 'host', conference: room.id, text: 'before disconnect' })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await until(() => sb.core().storedSubscriptions()[room.id].historyCursor === 1)
    const key = sb.conferenceList('guest')[0].key
    const transport = (sb as unknown as { transport: Transport }).transport
    await transport.stop()
    const missed = await sa.postToConference({ session: 'host', conference: room.id, text: 'during disconnect' })
    assert.ok(!sb.core().read(0).events.some(e => e.message === missed.message))
    await transport.start()
    await sb.dial(infoA.addrs[0])
    await until(() => sb.core().read(0).events.some(e => e.message === missed.message), 20000)
    await until(() => sb.core().storedSubscriptions()[room.id].historyCursor === 2)
    assert.equal(sb.conferenceList('guest')[0].key, key)
    assert.equal(sb.core().read(0).events.filter(e => e.message === missed.message).length, 1)
  } finally { await stop() }
})
