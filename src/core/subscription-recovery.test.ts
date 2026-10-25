// Docs: VORTEX_v5.1.md section 6.5 — subscription recovery and replay.
// Real libp2p transports, real engines; loopback only, no model wakes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeProfile } from '../embed/profile.ts'
import type { Embedder, Multiaddr, PeerId, Transport, TransportInfo } from '../types.ts'
import { createNodeTransport } from '../net/node.ts'
import { VortexService } from './service.ts'
import type { Conferences } from './conferences.ts'
import type { Snapshot } from './conversations.ts'

const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2', dims: [8, 4, 2],
  encoding: 'float32le', version: 1, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
const table: Record<string, Float32Array> = {
  base: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]),
  exact: Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0]),
  tier8: Float32Array.from([1, 0.2, 0, 0, 1, 0.3, 0, 0])
}
const fakeEmbedder = (): Embedder => ({
  profile: () => profile,
  embed: async (text: string): Promise<Float32Array> => {
    const found = table[text]
    if (found === undefined) throw new Error(`unknown statement: ${text}`)
    return found
  }
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until (check: () => boolean, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('condition timed out')
    await sleep(20)
  }
}

async function pair (saveA?: (s: Snapshot) => void, saveB?: (s: Snapshot) => void) {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', saveA ?? (() => {}), undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', saveB ?? (() => {}), undefined, { embedder: fakeEmbedder() })
  const infoA = await sa.start()
  const infoB = await sb.start()
  await sa.dial(infoB.addrs[0])
  await sleep(2500)
  return { sa, sb, infoA, infoB, stop: async (): Promise<void> => { await sa.stop(); await sb.stop() } }
}

// Recovery cancelled during engine validation must never send a join: the
// service check runs first, the engine check second, and the abort lands
// while the engine still verifies, before any pending reservation exists.
// Recovery cancelled during engine validation must never send a join: the
// service check runs first, the engine check second, and the abort lands
// while the engine still verifies, before any pending reservation exists.
test('cancelled validation sends no join and leaves no recovery state', { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sb.stop()
    await sa.postToConference({ session: 'host', conference: room.id, text: 'missed' })
    const transport = (sb as unknown as { transport: Transport }).transport
    const sent: PeerId[] = []
    const origSend = transport.send.bind(transport)
    transport.send = (async (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]) => {
      sent.push(peer)
      return origSend(peer, data, addrs)
    }) as typeof transport.send
    let releaseVerify!: () => void
    const gate = new Promise<void>(resolve => { releaseVerify = resolve })
    let calls = 0
    let blocked = false
    const rawVerify = transport.verify.bind(transport)
    transport.verify = (async (peer: PeerId, data: Uint8Array, signature: Uint8Array) => {
      calls += 1
      if (calls > 1) { blocked = true; await gate }
      return rawVerify(peer, data, signature)
    }) as typeof transport.verify
    try {
      await sb.start()
      await until(() => blocked, 10000)
      assert.equal(await sb.unsubscribeConference('guest', room.id), true)
      releaseVerify()
      await sleep(500)
      assert.deepEqual(sent, [])
      assert.deepEqual(sb.conferenceList('guest'), [])
      assert.deepEqual(sb.subscriptions('guest'), [])
      assert.equal((sb as unknown as { conferences: { pending: Map<string, unknown> } }).conferences.pending.size, 0)
      assert.equal((sb as unknown as { recovery: Map<string, unknown> }).recovery.size, 0)
      assert.equal((sb as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
    } finally {
      releaseVerify()
      transport.send = origSend
      transport.verify = rawVerify
    }
  } finally { await stop() }
})

// A renewal committed while a resume is still in flight must survive the
// refresh: only the shorter signed room expiry may clip the durable expiry.
test('renewal racing recovery keeps the renewed expiry within the room bound', { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 10 })
    const before = sb.core().storedSubscriptions()[room.id].expires
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    const origResume = engine.resumeMembership.bind(engine)
    let delay = false
    engine.resumeMembership = (async (session: string,
      saved: { descriptor: Uint8Array, privateKey: Uint8Array },
      options?: { signal?: AbortSignal, refresh?: boolean }) => {
      if (delay) await sleep(1500)
      return origResume(session, saved, options)
    }) as typeof engine.resumeMembership
    try {
      delay = true
      const renewed = await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 60 })
      assert.ok(renewed.expires > before)
      await sleep(2500)
      const stored = sb.core().storedSubscriptions()[room.id]
      assert.equal(stored.expires, renewed.expires)
      assert.ok(renewed.expires <= sa.conferenceList('host')[0].expires)
    } finally {
      engine.resumeMembership = origResume
    }
  } finally { await stop() }
})

// Three real services: the subscriber's transport drops while its service
// and engine stay active, a newcomer joins, and on reconnect the roster
// refresh delivers the newcomer's next live post exactly once.
test('reconnect refreshes a stale roster and delivers live posts once', { timeout: 90000 }, async () => {
  const { sa, sb, stop } = await pair()
  const tc = await createNodeTransport()
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sc.start()
    await sc.dial((await sa.info()).addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyBefore = sb.conferenceList('guest')[0].key
    const transport = (sb as unknown as { transport: Transport }).transport
    await transport.stop()
    const cInterest = await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.matchesFor(cInterest.id).some(m => m.record === room.id))
    await sc.joinConference({ session: 'c', ref: room.id })
    await transport.start()
    await sb.dial((await sa.info()).addrs[0])
    const cKey = sc.conferenceList('c')[0].key
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    await until(() => (engine.get(room.id)?.participants ?? []).includes(cKey), 20000)
    const posted = await sc.postToConference({ session: 'c', conference: room.id, text: 'hello newcomer' })
    await until(() => sb.core().read(0).events.some(e => e.message === posted.message), 10000)
    await sleep(500)
    assert.equal(sb.core().read(0).events.filter(e => e.message === posted.message).length, 1)
    assert.equal(sb.conferenceList('guest')[0].key, keyBefore)
    assert.equal(sb.conferenceList('guest')[0].session, 'guest')
    assert.deepEqual([...sa.conferenceList('host')[0].participants].sort(),
      [...engine.get(room.id)!.participants].sort())
    assert.equal(sa.conferenceList('host')[0].count, 3)
  } finally { await sc.stop().catch(() => {}); await stop() }
})

// Fresh process-equivalent restart: preserved transport key plus a
// JSON-roundtripped owner snapshot. Missed mail queues once under the same
// participant key; ack dedup survives another restart.
test('fresh instance restart resumes key, replays once, and keeps ack dedup', { timeout: 90000 }, async () => {
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
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyBefore = sb.conferenceList('guest')[0].key
    const exported = (sb as unknown as { transport: { exportKey: () => Uint8Array } }).transport.exportKey()
    await sb.stop()
    const missed = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    assert.ok(savedB !== undefined)
    const restored = JSON.parse(JSON.stringify(savedB)) as Snapshot
    const tb2 = await createNodeTransport({ key: exported })
    let savedB2: Snapshot | undefined
    const sb2 = new VortexService(tb2, 'b', s => { savedB2 = s }, restored, { embedder: fakeEmbedder() })
    try {
      const infoB2 = await sb2.start()
      assert.equal(infoB2.peerId, infoB.peerId)
      await until(() => sb2.core().read(0).events.some(e => e.message === missed.message), 30000)
      await sleep(500)
      assert.equal(sb2.conferenceList('guest')[0].key, keyBefore)
      assert.equal(sb2.core().read(0).events.filter(e => e.message === missed.message).length, 1)
      assert.equal(sa.conferenceList('host')[0].count, 2)
      const pub = JSON.stringify({ subs: sb2.subscriptions(), events: sb2.core().read(0).events })
      const privateHex = (restored.subscriptions?.[room.id]?.membership as { privateKey: string } | undefined)?.privateKey
      assert.ok(privateHex !== undefined && !pub.includes(privateHex))
      await sb2.core().ack(sb2.core().read().cursor)
      await sb2.stop()
      assert.ok(savedB2 !== undefined)
      const acknowledged = JSON.parse(JSON.stringify(savedB2)) as Snapshot
      // Request already-acknowledged history again after a fresh restart.
      acknowledged.subscriptions![room.id].historyCursor = 0
      const sb3 = new VortexService(await createNodeTransport({ key: exported }), 'b', () => {},
        acknowledged, { embedder: fakeEmbedder() })
      try {
        await sb3.start()
        await until(() => sb3.core().storedSubscriptions()[room.id].historyCursor > 0, 30000)
        assert.equal(sb3.conferenceList('guest')[0].key, keyBefore)
        assert.deepEqual(sb3.core().read().events, [])
      } finally { await sb3.stop() }
    } finally { await sb2.stop().catch(() => {}) }
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

// A host that closed while the participant was offline answers unknown: the
// subscription ends, and a failing durable removal retries once saving works.
test('unknown room ends the subscription with retry on save failure', { timeout: 90000 }, async () => {
  let fail = false
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const errors: string[] = []
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  try {
    const infoA = await sa.start()
    const infoB = await sb.start()
    await sa.dial(infoB.addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const privateHex = sb.core().storedSubscriptions()[room.id].membership!.privateKey
    await sb.stop()
    // Restart only the host conference engine: rooms and closed-room memory
    // are gone while transport identity and addresses stay stable, so the
    // participant's resume reaches a host with no record of the room.
    const saEngine = (sa as unknown as { conferences: { stop: () => void, start: () => void } }).conferences
    saEngine.stop()
    saEngine.start()
    fail = true
    await sb.start()
    await until(() => errors.some(m => m === 'subscription close could not be saved'), 15000)
    assert.equal(sb.subscriptions('guest').length, 1)
    fail = false
    await until(() => sb.subscriptions('guest').length === 0, 20000)
    assert.deepEqual(sb.conferenceList('guest'), [])
    assert.ok(errors.every(m => m === 'subscription close could not be saved'))
    assert.ok(!errors.some(m => m.includes(privateHex)))
    void infoA
  } finally { fail = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})
