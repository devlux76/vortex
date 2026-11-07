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

test('a blocked replacement does not spin expiry and session end releases dormant state', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const clock = { now: Date.now() }
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {}, matchWindowMs: 1000, now: () => clock.now })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  await da.start()
  await db.start()
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  try {
    const id = await da.announce({ session: 's', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact', ttl: 1 })
    const recordId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, id, lastBytes(db, 'b'))
    await retainedRecord(da, id, recordId)
    const rawPublish = ta.publish.bind(ta)
    ta.publish = (async (...args: Parameters<typeof rawPublish>) => { entered(); await gate; throw new Error('publish failed') }) as typeof rawPublish
    const pending = da.announce({ session: 's', statement: 'tier8', replaces: id }).catch(error => error)
    await ready
    let expiryCalls = 0
    const stored = da as unknown as { scheduleExpiry: () => void, suspendedWindows: Map<string, unknown>, matchesByInterest: Map<string, unknown> }
    const schedule = stored.scheduleExpiry.bind(da)
    stored.scheduleExpiry = () => { expiryCalls++; schedule() }
    clock.now += 2000
    stored.scheduleExpiry()
    await sleep(80)
    assert.ok(expiryCalls <= 3, `expiry spun ${expiryCalls} times`)
    da.endSession('s')
    assert.equal(stored.suspendedWindows.size, 0)
    release()
    assert.match(((await pending) as Error).message, /publish failed/)
    assert.deepEqual(da.interests('s'), [])
  } finally { release(); await da.stop(); await db.stop() }
})

test('a concurrent fresh announce does not steal the blocked replacement window (T2 success)', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const hits: Array<{ interest: string, record: string }> = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { hits.push({ interest: (m as { interest: string }).interest, record: (m as { record: { id: string } }).record.id }) }, matchWindowMs: 2000 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  try {
    const old = await da.announce({ session: 's', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    const recordId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, old, lastBytes(db, 'b'))
    await retainedRecord(da, old, recordId)
    assert.equal(hits.length, 0)
    const rawPublish = ta.publish.bind(ta)
    let pubs = 0
    ta.publish = (async (...args: Parameters<typeof rawPublish>) => {
      if (pubs++ === 0) { entered(); await gate; throw new Error('publish failed') }
      return rawPublish(...args)
    }) as typeof rawPublish
    const first = da.announce({ session: 's', statement: 'tier8', replaces: old }).catch(error => error)
    await ready
    const second = await da.announce({ session: 's', statement: 'tier4', replaces: old })
    const stored = da as unknown as { windowTimers: Map<string, unknown> }
    release()
    assert.match(((await first) as Error).message, /publish failed/)
    assert.ok(da.interests().some(interest => interest.id === old))
    assert.ok(da.interests().some(interest => interest.id === second))
    assert.equal(da.matches(old).length, 1)
    assert.equal(stored.windowTimers.has(old), true)
    await sleep(2600)
    assert.equal(hits.filter(hit => hit.interest === old && hit.record === recordId).length, 1)
  } finally { release(); await da.stop(); await db.stop() }
})

test('a concurrent failed announce does not steal the blocked replacement window (T2 failure)', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const hits: Array<{ interest: string, record: string }> = []
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: (m) => { hits.push({ interest: (m as { interest: string }).interest, record: (m as { record: { id: string } }).record.id }) }, matchWindowMs: 2000 })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  try {
    const old = await da.announce({ session: 's', statement: 'base' })
    await db.announce({ session: 'b', statement: 'exact' })
    const recordId = db.interests().find(interest => interest.session === 'b')!.id
    await answer(tb, ta, old, lastBytes(db, 'b'))
    await retainedRecord(da, old, recordId)
    assert.equal(hits.length, 0)
    const rawPublish = ta.publish.bind(ta)
    let pubs = 0
    ta.publish = (async (...args: Parameters<typeof rawPublish>) => {
      if (pubs++ === 0) { entered(); await gate; throw new Error('publish failed') }
      throw new Error('publish failed')
    }) as typeof rawPublish
    const first = da.announce({ session: 's', statement: 'tier8', replaces: old }).catch(error => error)
    await ready
    await assert.rejects(da.announce({ session: 's', statement: 'tier4', replaces: old }), /publish failed/)
    const stored = da as unknown as { windowTimers: Map<string, unknown> }
    release()
    assert.match(((await first) as Error).message, /publish failed/)
    assert.ok(da.interests().some(interest => interest.id === old))
    assert.equal(da.matches(old).length, 1)
    assert.equal(stored.windowTimers.has(old), true)
    await sleep(2600)
    assert.equal(hits.filter(hit => hit.interest === old && hit.record === recordId).length, 1)
  } finally { release(); await da.stop(); await db.stop() }
})
