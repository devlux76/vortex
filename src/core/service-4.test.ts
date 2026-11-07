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

for (const ending of ['unsubscribe', 'stop'] as const) {
test(`held resume reply aborted by ${ending} never resurrects`, { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sb.stop()
    await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    const saTransport = (sa as unknown as { transport: Transport }).transport
    const origSend = saTransport.send.bind(saTransport)
    const sbTransport = (sb as unknown as { transport: Transport }).transport
    const origDirect = sbTransport.onDirect.bind(sbTransport)
    const lateHandlers: Array<(event: DirectEvent) => void> = []
    sbTransport.onDirect = handler => { lateHandlers.push(handler); return origDirect(handler) }
    const held: Array<{ peer: PeerId, data: Uint8Array, addrs?: Multiaddr[] }> = []
    let hold = false
    saTransport.send = (async (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]) => {
      if (hold) { held.push({ peer, data, addrs }); return }
      return origSend(peer, data, addrs)
    }) as typeof saTransport.send
    const releaseHeld = async (addrs?: Multiaddr[]): Promise<void> => {
      hold = false
      for (const packet of held) await origSend(packet.peer, packet.data, addrs ?? packet.addrs)
      held.length = 0
    }
    try {
      hold = true
      await sb.start()
      await until(() => held.length > 0, 10000)
      assert.deepEqual(sb.conferenceList('guest'), [])
      if (ending === 'unsubscribe') {
        assert.equal(await sb.unsubscribeConference('guest', room.id), true)
        assert.deepEqual(sb.subscriptions('guest'), [])
        await until(() => sa.conferenceList('host')[0]?.count === 1, 2000)
      } else {
        await sb.stop()
        assert.equal(sb.subscriptions('guest').length, 1)
        // Deliver the real signed reply to callbacks captured before stop,
        // as if it were already queued when the handlers were unregistered.
        hold = false
        for (const packet of held) {
          for (const handler of lateHandlers) handler({ from: sa.info().peerId, data: packet.data })
        }
        held.length = 0
        await sleep(1500)
        assert.deepEqual(sb.conferenceList('guest'), [])
        assert.equal(sb.subscriptions('guest').length, 1)
        assert.ok(!sb.core().read(0).events.some(e => e.body === 'missed one'))
        assert.equal((sb as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
        return
      }
      await releaseHeld()
      await sleep(1500)
      assert.deepEqual(sb.conferenceList('guest'), [])
      assert.deepEqual(sb.subscriptions('guest'), [])
      assert.ok(!sb.core().read(0).events.some(e => e.body === 'missed one'))
      assert.equal((sb as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
    } finally {
      hold = false
      saTransport.send = origSend
      sbTransport.onDirect = origDirect
    }
  } finally { await stop() }
})
}

test('delayed recovery page overlaps live events without duplication', { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const subId = sb.core().storedSubscriptions()[room.id].id
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    const origHistory = engine.history.bind(engine)
    let delayOnce = true
    engine.history = (async (request: Parameters<typeof engine.history>[0]) => {
      if (delayOnce) { delayOnce = false; await sleep(1500) }
      return origHistory(request)
    }) as typeof engine.history
    try {
      const m1 = await sa.postToConference({ session: 'host', conference: room.id, text: 'first' })
      await until(() => sb.core().read(0).events.some(e => e.message === m1.message), 10000)
      const renewed = sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
      const settled = renewed.then(() => 'resolved', (error: unknown) => error)
      await sleep(300)
      // Advance the store cursor while the real page awaits: the stale page
      // must neither append nor roll the cursor back.
      const baseline = sb.core().storedSubscriptions()[room.id].historyCursor
      assert.equal(await sb.core().applySubscriptionHistory(room.id, subId, baseline, baseline + 5, []), 0)
      assert.equal(sb.core().storedSubscriptions()[room.id].historyCursor, baseline + 5)
      const m2 = await sa.postToConference({ session: 'host', conference: room.id, text: 'second' })
      assert.equal(await settled, 'resolved')
      await until(() => sb.core().read(0).events.some(e => e.message === m2.message), 10000)
      await sleep(500)
      const events = sb.core().read(0).events
      assert.equal(events.filter(e => e.message === m1.message).length, 1)
      assert.equal(events.filter(e => e.message === m2.message).length, 1)
      assert.equal(sb.core().storedSubscriptions()[room.id].historyCursor, baseline + 5)
    } finally {
      engine.history = origHistory
    }
  } finally { await stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1 and 11.5 — host-only topic revision.
test('host revision policy rejects before inference and keeps the old topic', { timeout: 60000 }, async () => {
  let embedded = 0
  const embedder = fakeEmbedder()
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined,
    { embedder: { ...embedder, embed: async text => { embedded++; return embedder.embed(text) } } })
  try {
    await service.start()
    const room = await service.createConference({ session: 'host', statement: 'base' })
    assert.equal(room.revision, 1)
    embedded = 0
    await assert.rejects(service.reviseConference({ session: 'other', conference: room.id, statement: 'base' }), /host owner|not hosting|member/)
    await assert.rejects(service.reviseConference({ session: 'host', conference: 'f'.repeat(32), statement: 'base' }), /host owner|not hosting|member|conference/)
    await assert.rejects(service.reviseConference({ session: 'host', conference: room.id, statement: '' }), /statement/)
    await assert.rejects(service.reviseConference({ session: 'host', conference: room.id, statement: 'x'.repeat(4097) }), /statement/)
    assert.equal(embedded, 0)
    assert.equal(service.conferenceList('host')[0].revision, 1)
    assert.equal(service.conferenceList('host')[0].count, 1)
  } finally { await service.stop() }
})

test('revision uses the captured approval request', { timeout: 60000 }, async () => {
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const statements: string[] = []
  const embedder = fakeEmbedder()
  let approvals = 0
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined, {
    embedder: { ...embedder, embed: async text => { statements.push(text); return embedder.embed(text) } },
    disclosure: createDisclosurePolicy({ requireApproval: true }, async () => { approvals++; if (approvals === 2) { entered(); await gate } })
  })
  await service.start()
  try {
    const created = await service.createConference({ session: 'host', statement: 'base' })
    const request = { session: 'host', conference: created.id, statement: 'tier8' }
    const pending = service.reviseConference(request)
    await ready
    request.statement = 'far'
    release()
    const revised = await pending
    assert.equal(revised.revision, 2)
    assert.deepEqual(statements.slice(-1), ['tier8'])
  } finally { release(); await service.stop() }
})

test('revision fans out to members and discovery matches the new topic', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'far' })
    const cold = await sb.announceStatement({ session: 'cold', statement: 'exact' })
    await sleep(1500)
    assert.ok(!sb.matchesFor(cold.id).some(m => m.record === room.id && m.kind === 'conference'))
    const revised = await sa.reviseConference({ session: 'host', conference: room.id, statement: 'base' })
    assert.equal(revised.revision, 2)
    assert.equal(revised.id, room.id)
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id && m.kind === 'conference'))
    const joined = await sb.joinConference({ session: 'guest', ref: room.id })
    assert.equal(joined.revision, 3)
    assert.equal(joined.count, 2)
  } finally { await stop() }
})

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — original-query subject retention.
test('join captures the original query despite later interest changes', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    const joining = sb.joinConference({ session: 'guest', ref: room.id })
    sb.withdrawInterest('guest', interest.id)
    const joined = await joining
    assert.equal(joined.id, room.id)
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    assert.deepEqual(engine.membershipSubject(room.id, 'guest'), {
      statement: 'tier8', vector: subjectHex('tier8'), namespace: profile.id, profileVersion: 1 })
    for (const view of [sb.subscriptions(), sb.conferenceList('guest'), sb.core().read()]) {
      assert.ok(!JSON.stringify(view).includes('tier8'))
    }
    assert.throws(() => engine.membershipSubject(room.id, 'wrong'), /not in this conference/)
  } finally { await stop() }
})

test('revision, restart and renewal preserve the original query', { timeout: 90000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sleep(1000)
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    const expected = { statement: 'tier8', vector: subjectHex('tier8'), namespace: profile.id, profileVersion: 1 }
    assert.deepEqual(engine.membershipSubject(room.id, 'guest'), expected)
    assert.deepEqual(sb.core().storedSubscriptions()[room.id].subject, expected)
    await sa.reviseConference({ session: 'host', conference: room.id, statement: 'far' })
    await until(() => engine.get(room.id)?.descriptor.revision === 3, 10000)
    assert.deepEqual(engine.membershipSubject(room.id, 'guest'), expected)
    const roster = engine.certifiedParticipants(room.id, 'guest')
    assert.equal(roster.length, 2)
    assert.ok(roster.some(entry => entry.service === sb.info().peerId))
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    assert.deepEqual(sb.core().storedSubscriptions()[room.id].subject, expected)
    await sb.stop()
    await sb.start()
    await sleep(2000)
    assert.deepEqual(sb.core().storedSubscriptions()[room.id].subject, expected)
    for (const view of [sb.subscriptions(), sb.conferenceList('guest'), sb.core().read()]) {
      assert.ok(!JSON.stringify(view).includes('tier8'))
    }
    await sleep(2000)
  } finally { await stop() }
})

test('fresh instance keeps the original query across a host revision', { timeout: 90000 }, async () => {
  const ta = await createNodeTransport()
  const tbRaw = await createNodeTransport()
  let savedB: Snapshot | undefined
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tbRaw, 'b', s => { savedB = s }, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start()
    const infoB = await sb.start()
    await sa.dial(infoB.addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyBefore = sb.conferenceList('guest')[0].key
    const expected = { statement: 'tier8', vector: subjectHex('tier8'), namespace: profile.id, profileVersion: 1 }
    const exported = (sb as unknown as { transport: { exportKey: () => Uint8Array } }).transport.exportKey()
    await sb.stop()
    await sa.reviseConference({ session: 'host', conference: room.id, statement: 'far' })
    const missed = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    assert.ok(savedB !== undefined)
    const restored = JSON.parse(JSON.stringify(savedB)) as Snapshot
    const tb2 = await createNodeTransport({ key: exported })
    const sb2 = new VortexService(tb2, 'b', () => {}, restored, { embedder: fakeEmbedder() })
    try {
      const infoB2 = await sb2.start()
      assert.equal(infoB2.peerId, infoB.peerId)
      await until(() => sb2.core().read(0).events.some(e => e.message === missed.message), 30000)
      await sleep(500)
      assert.equal(sb2.conferenceList('guest')[0].key, keyBefore)
      assert.equal(sb2.core().read(0).events.filter(e => e.message === missed.message).length, 1)
      assert.equal(sa.conferenceList('host')[0].count, 2)
      const engine = (sb2 as unknown as { conferences: Conferences }).conferences
      assert.deepEqual(engine.membershipSubject(room.id, 'guest'), expected)
      for (const view of [sb2.subscriptions(), sb2.conferenceList('guest'), sb2.core().read()]) {
        assert.ok(!JSON.stringify(view).includes('tier8'))
      }
      void infoA
    } finally { await sb2.stop().catch(() => {}) }
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — private feedback on leave.
test('leave feedback defaults to the original query and honors overrides', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 300 })
    await sa.reviseConference({ session: 'a', conference: joined.id, statement: 'tier8' })
    assert.equal(sb.withdrawInterest('b', match.interest!), true)
    const hostKey = sa.conferenceList('a').find(c => c.id === joined.id)!.key
    assert.equal(await sb.leaveConference('b', joined.id, { outcomes: [{ participant: hostKey, outcome: 'useful' }] }), true)
    const stored = sb.core().storedPeerMemory()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].participant, hostKey)
    assert.equal(stored[0].peer, infoA.peerId)
    assert.equal(stored[0].statement, 'exact')
    assert.equal(stored[0].outcome, 'useful')
    assert.equal(stored[0].namespace, profile.id)
    assert.deepEqual(sb.conferenceList('b'), [])
  } finally { await stop() }
})

test('host feedback defaults to the current topic and honors overrides', { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sa.reviseConference({ session: 'a', conference: joined.id, statement: 'tier8' })
    const guestKey = sb.conferenceList('b').find(c => c.id === joined.id)!.key
    assert.equal(await sa.leaveConference('a', joined.id, { outcomes: [{ participant: guestKey, outcome: 'misleading' }] }), true)
    const stored = sa.core().storedPeerMemory()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].participant, guestKey)
    assert.equal(stored[0].peer, infoB.peerId)
    assert.equal(stored[0].statement, 'tier8')
    assert.equal(stored[0].outcome, 'misleading')
    void joined
  } finally { await stop() }
})

test('feedback proof rejects unknown, self and malformed batches before inference', { timeout: 60000 }, async () => {
  let embedded = 0
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { embedded++; return embedder.embed(text) } } })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    const ownKey = sb.conferenceList('b').find(c => c.id === joined.id)!.key
    const unknownKey = 'ff'.repeat(32)
    const bad = { outcomes: [{ participant: unknownKey, outcome: 'useful' as const }] }
    embedded = 0
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: 'x' } as never), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: unknownKey, outcome: 'useful' as const },
      { participant: unknownKey, outcome: 'neutral' as const }] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: 'zz', outcome: 'useful' as const }] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: unknownKey, outcome: 'great' as never }] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: ownKey, outcome: 'useful' as const }] }), /own key|feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, bad), /no proof|feedback/);
    await assert.rejects(sb.leaveConference('wrong', joined.id, bad), /feedback|session|member/);
    await assert.rejects(sb.leaveConference('b', 'f'.repeat(32), bad), /feedback|member|conference/);
    await assert.rejects(sb.leaveConference('b', joined.id,
      { outcomes: [{ participant: unknownKey, outcome: 'useful' as const }], statement: '' }), /feedback|statement/);
    assert.equal(embedded, 0)
    assert.deepEqual(sb.core().storedPeerMemory(), [])
    assert.ok(sb.conferenceList('b').some(c => c.id === joined.id))
  } finally { await sa.stop(); await sb.stop() }
})

test('departed authors prove by message events; save failure rolls everything back', { timeout: 90000 }, async () => {
  let fail = false
  let embedded = 0
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => { if (fail) throw new Error('disk full') }, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined,
    { embedder: { ...embedder, embed: async (text: string) => { embedded++; return embedder.embed(text) } } })
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
    await sb.postToConference({ session: 'b', conference: joined.id, text: 'guest words' })
    await until(() => sa.core().read(0).events.some(e => e.kind === 'conference_message' && e.body === 'guest words'))
    const guestKey = sb.conferenceList('b').find(c => c.id === joined.id)!.key
    assert.equal(await sb.leaveConference('b', joined.id), true)
    await until(() => sa.core().read(0).events.some(e => e.kind === 'departure'))
    embedded = 0
    await sa.subscribeConference({ session: 'a', conference: joined.id, ttl: 300 })
    fail = true
    await assert.rejects(sa.leaveConference('a', joined.id,
      { outcomes: [{ participant: guestKey, outcome: 'useful' as const }] }), /disk full/)
    assert.equal(sa.core().storedPeerMemory().length, 0)
    assert.ok(sa.conferenceList('a').some(c => c.id === joined.id))
    assert.ok(sa.core().storedSubscriptions()[joined.id] !== undefined)
    fail = false
    assert.equal(await sa.leaveConference('a', joined.id,
      { outcomes: [{ participant: guestKey, outcome: 'useful' as const }] }), true)
    const stored = sa.core().storedPeerMemory()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].participant, guestKey)
    assert.deepEqual(sa.conferenceList('a'), [])
    // Restart retains the committed private feedback.
    await sa.stop()
    await sa.start()
    assert.equal(sa.core().storedPeerMemory().length, 1)
    assert.equal(embedded, 0)
  } finally { fail = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})
