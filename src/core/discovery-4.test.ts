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

test('withdrawing a replacement during publication prevents rollback restoration', async () => {
  const net = createNetwork()
  const transport = await net.node()
  const discovery = new Discovery({ transport, embedder: makeEmbedder(), onMatch: () => {} })
  await discovery.start()
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  try {
    const old = await discovery.announce({ session: 's', statement: 'base' })
    transport.publish = async () => { entered(); await gate; throw new Error('publish failed') }
    const outcome = discovery.announce({ session: 's', statement: 'exact', replaces: old }).catch(error => error)
    await ready
    assert.equal(discovery.withdraw('s', discovery.interests('s')[0].id), true)
    release()
    assert.match((await outcome).message, /publish failed/)
    assert.deepEqual(discovery.interests('s'), [])
  } finally { release(); await discovery.stop() }
})

test('a fresh result batch waits for the collection window', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: Array<{ record: { id: string } }> = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) }, matchWindowMs: 120 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    const recordId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, recordId)
    assert.equal(da.matches(id).length, 1)
    assert.equal(seen.length, 0)
    await sleep(300)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].record.id, da.matches(id)[0].record.id)
  } finally { await da.stop(); await db.stop() }
})

test('a stronger later result displaces the weaker before the deadline', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tc = await net.node()
  const seen: Array<{ record: { id: string } }> = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) },
    matchWindowMs: 200, maxMatchesPerInterest: 1 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  const dc = new Discovery({ transport: tc, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await dc.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'tier4' })
    await dc.announce({ session: 'c', statement: 'exact' })
    const weakId = db.interests().find(interest => interest.session === 'b')!.id
    const strongId = dc.interests().find(interest => interest.session === 'c')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, weakId)
    await answer(tc, ta, id, lastBytes(dc, 'c'))
    await retainedRecord(da, id, strongId)
    await sleep(400)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].record.id, strongId)
    assert.notEqual(seen[0].record.id, weakId)
    // The evicted weaker handle stays silent even after the window.
    await db.announce({ session: 'b2', statement: 'tier4' })
    await answer(tb, ta, id, lastBytes(db, 'b2'))
    await sleep(400)
    assert.equal(seen.length, 1)
  } finally { await da.stop(); await db.stop(); await dc.stop() }
})

test('arrivals never extend a fixed collection deadline', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tc = await net.node()
  const td = await net.node()
  const seen: Array<{ record: { id: string } }> = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) }, matchWindowMs: 150 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  const dc = new Discovery({ transport: tc, embedder: makeEmbedder(), onMatch: () => {} })
  const dd = new Discovery({ transport: td, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await dc.start()
  await dd.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'tier4' })
    await dc.announce({ session: 'c', statement: 'exact' })
    await dd.announce({ session: 'd', statement: 'tier8' })
    const first = db.interests().find(interest => interest.session === 'b')!.id
    const second = dc.interests().find(interest => interest.session === 'c')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, first)
    await sleep(100)
    await answer(tc, ta, id, lastBytes(dc, 'c'))
    await retainedRecord(da, id, second)
    await sleep(160)
    // The first fixed window flushed exactly its first two arrivals, ranked;
    // a later arrival could not have extended it into a single batch.
    assert.deepEqual(seen.map(s => s.record.id), [second, first])
    await answer(td, ta, id, lastBytes(dd, 'd'))
    await sleep(300)
    assert.equal(seen.length, 3)
  } finally { await da.stop(); await db.stop(); await dc.stop(); await dd.stop() }
})

test('duplicate arrivals notify once with the latest retained metadata', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const hits: Array<{ kind: string, record: { id: string, revision?: number, participantCount?: number } }> = []
  const host = new Discovery({ transport: th, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: to, embedder: makeEmbedder(), onMatch: (m) => { hits.push(m as never) }, matchWindowMs: 150 })
  await host.start(); await origin.start()
  try {
    const held = await host.announce({ session: 'h', statement: 'base' })
    const id = await origin.announce({ session: 'o', statement: 'base' })
    await settle()
    const room = await hostedRecord(th, held)
    const send = async (bytes: Uint8Array) => {
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: bytes, tier: 0, score: 1 }]))
      await settle()
    }
    await send(room.bytes)
    await retainedRecord(origin, id, held)
    const refreshed = await createDescriptor({ id: held, profile, topicVector: vBase, host: th.peerId, addrs: th.info().addrs,
      participantCount: 3, capacity: 8, admission: 'open', revision: 2, createdAt: room.descriptor.createdAt,
      expiresAt: room.descriptor.expiresAt, sign: data => th.sign(data) })
    await send(refreshed.bytes)
    await retainedRecord(origin, id, held)
    await send(refreshed.bytes)
    await sleep(400)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, 'conference')
    assert.equal(hits[0].record.revision, 2)
    assert.equal(hits[0].record.participantCount, 3)
  } finally { await host.stop(); await origin.stop() }
})

test('an interest upgraded to a conference before first flush notifies once', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const hits: Array<{ kind: string, record: { id: string } }> = []
  const host = new Discovery({ transport: th, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: to, embedder: makeEmbedder(), onMatch: (m) => { hits.push(m as never) }, matchWindowMs: 150 })
  await host.start(); await origin.start()
  try {
    const held = await host.announce({ session: 'h', statement: 'base' })
    const id = await origin.announce({ session: 'o', statement: 'base' })
    await settle()
    await th.send(to.peerId, directPacket(id, host.interests()[0].bytes, 0, 1))
    await settle()
    await retainedRecord(origin, id, held)
    assert.equal(origin.matches(id).length, 1)
    assert.equal(origin.matches(id)[0].kind, 'interest')
    const room = await hostedRecord(th, held)
    await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }]))
    await settle()
    await retainedRecord(origin, id, held)
    await sleep(400)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].kind, 'conference')
    assert.equal(hits[0].record.id, held)
  } finally { await host.stop(); await origin.stop() }
})

test('a zero window keeps immediate callbacks', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ }, matchWindowMs: 0 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    const firstId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, firstId)
    assert.equal(hits, 1)
    await db.announce({ session: 'b2', statement: 'tier8' })
    const secondId = db.interests().find(interest => interest.session === 'b2')!.id
    await answer(tb, ta, id, lastBytes(db, 'b2'))
    await retainedRecord(da, id, secondId)
    assert.equal(hits, 2)
  } finally { await da.stop(); await db.stop() }
})

test('matchWindowMs rejects fractional, negative and unbounded values', async () => {
  const net = createNetwork()
  const ta = await net.node()
  for (const value of [-1, 1.5, NaN, Infinity, 60001]) {
    assert.throws(() => new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {}, matchWindowMs: value }),
      /matchWindowMs/)
  }
  for (const value of [0, 1, 60000]) {
    const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {}, matchWindowMs: value })
    await d.stop()
  }
})

test('withdrawal, expiry, stop and reentrant callbacks drop pending notifications', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tc = await net.node()
  const clock = { now: Date.now() }
  let hits = 0
  let withdrawnId = ''
  let da: Discovery
  da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {
    hits++
    if (withdrawnId !== '') da.withdraw('a', withdrawnId)
  }, matchWindowMs: 200, now: () => clock.now })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  const dc = new Discovery({ transport: tc, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await dc.start()
  try {
    // Plain withdrawal drops the pending batch.
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, db.interests().find(interest => interest.session === 'b')!.id)
    assert.equal(hits, 0)
    assert.equal(da.withdraw('a', id), true)
    await sleep(400)
    assert.equal(hits, 0)
    // A reentrant withdrawal inside the first callback drops the rest.
    const id2 = await da.announce({ session: 'a', statement: 'base' })
    withdrawnId = id2
    await db.announce({ session: 'b2', statement: 'tier8' })
    await dc.announce({ session: 'c2', statement: 'tier4' })
    await answer(tb, ta, id2, lastBytes(db, 'b2'))
    await retainedRecord(da, id2, db.interests().find(interest => interest.session === 'b2')!.id)
    await answer(tc, ta, id2, lastBytes(dc, 'c2'))
    await retainedRecord(da, id2, dc.interests().find(interest => interest.session === 'c2')!.id)
    await sleep(400)
    assert.equal(hits, 1)
    withdrawnId = ''
    // Expiry drops the pending batch without emitting.
    const id3 = await da.announce({ session: 'a', statement: 'base', ttl: 5 })
    await db.announce({ session: 'b3', statement: 'exact' })
    await answer(tb, ta, id3, lastBytes(db, 'b3'))
    await retainedRecord(da, id3, db.interests().find(interest => interest.session === 'b3')!.id)
    clock.now += 10000
    await sleep(400)
    assert.equal(hits, 1)
    assert.deepEqual(da.matches(id3), [])
    // Stop drops the pending batch; a restart emits nothing stale.
    const id4 = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b4', statement: 'exact' })
    await answer(tb, ta, id4, lastBytes(db, 'b4'))
    await retainedRecord(da, id4, db.interests().find(interest => interest.session === 'b4')!.id)
    await da.stop()
    await da.start()
    await sleep(400)
    assert.equal(hits, 1)
    assert.deepEqual(da.matches(id4), [])
  } finally { await da.stop(); await db.stop(); await dc.stop() }
})

test('failed replacement keeps the pending batch of the old interest', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const hits: string[] = []
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: (m) => { hits.push((m as { record: { id: string } }).record.id) }, matchWindowMs: 200 })
  await responder.start(); await origin.start()
  try {
    await responder.announce({ session: 'host', statement: 'base' })
    const original = await origin.announce({ session: 'guest', statement: 'exact' })
    await answer(host, guest, original, lastBytes(responder, 'host'))
    await retainedRecord(origin, original, responder.interests().find(interest => interest.session === 'host')!.id)
    assert.equal(hits.length, 0)
    guest.failPublish = true
    await assert.rejects(origin.announce({ session: 'guest', statement: 'tier8', replaces: original }), /publish failed/)
    guest.failPublish = false
    await sleep(400)
    assert.deepEqual(hits, origin.matches(original).map(m => m.record.id))
    assert.equal(hits.length, 1)
  } finally { await responder.stop(); await origin.stop() }
})

test('the default window batches without an explicit option', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, db.interests().find(interest => interest.session === 'b')!.id)
    assert.equal(hits, 0)
    await sleep(700)
    assert.equal(hits, 1)
  } finally { await da.stop(); await db.stop() }
})

test('a rejected replacement keeps the original pending window', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const hits: string[] = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { hits.push((m as { record: { id: string } }).record.id) }, matchWindowMs: 150 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    const recordId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, recordId)
    assert.equal(hits.length, 0)
    await assert.rejects(da.announce({ session: 'foreign', statement: 'tier8', replaces: id }), /another session/)
    await assert.rejects(da.announce({ session: '', statement: 'tier8', replaces: id }), /session and statement/)
    await sleep(400)
    assert.equal(hits.length, 1)
    assert.equal(hits[0], recordId)
    assert.equal(da.matches(id).length, 1)
  } finally { await da.stop(); await db.stop() }
})

test('a failed replacement after flush notifies only novel handles', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tc = await net.node()
  const hits: string[] = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { hits.push((m as { record: { id: string } }).record.id) }, matchWindowMs: 150 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  const dc = new Discovery({ transport: tc, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await dc.start()
  try {
    const id = await da.announce({ session: 'a', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    const firstId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, firstId)
    await sleep(400)
    assert.deepEqual(hits, [firstId])
    ta.failPublish = true
    await assert.rejects(da.announce({ session: 'a', statement: 'tier8', replaces: id }), /publish failed/)
    ta.failPublish = false
    assert.deepEqual(da.interests().map(interest => interest.id), [id])
    await dc.announce({ session: 'c', statement: 'tier4' })
    const novelId = dc.interests().find(interest => interest.session === 'c')!.id
    await answer(tc, ta, id, lastBytes(dc, 'c'))
    await retainedRecord(da, id, novelId)
    await sleep(400)
    assert.equal(hits.length, 2)
    assert.deepEqual(hits, [firstId, novelId])
    assert.equal(hits.filter(x => x === firstId).length, 1)
  } finally { await da.stop(); await db.stop(); await dc.stop() }
})
