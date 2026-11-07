import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import type { DirectEvent, PeerId, Transport, TransportInfo } from '../types.ts'
import { Conferences, ConferenceRoomUnknownError } from './conferences.ts'
import type { ConferenceEvent, Formable } from './conferences.ts'
import { Admission, ConferencePacket, Descriptor as WireDescriptor, SignedDescriptor } from './proto/conference.ts'
import { encodeVector } from '../embed/vector.ts'
import { encodeContact } from './contact.ts'
import { createDescriptor } from './conference-records.ts'

import { profile, vector, settle, unhex, frame, DESCRIPTOR_PREFIX, joinedBytes, type TestTransport, createNetwork, type Node, makeNode, nextRef, freshRef, formable, replayBarrier, revisedVector, subjectHex, querySubject } from './conferences.testkit.ts'

test('participant restart resumes the same key in a full invitation room without a new grant', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const guest = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector,
      capacity: 2, admission: 'invitation', peers: [guest.peerId] })
    const joined = await guest.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = (guest.conf as unknown as { exportMembership: (c: string, s: string) => { descriptor: Uint8Array, privateKey: Uint8Array } }).exportMembership(room.id, 'guest')
    const arrivalsBefore = host.events.filter(e => e.kind === 'arrival').length
    assert.equal(host.conf.get(room.id)?.participants.length, 2)
    // Restart only the participant engine; the host keeps its roster and used grant.
    guest.conf.stop()
    guest.conf.start()
    const resumed = await (guest.conf as unknown as { resumeMembership: (s: string, v: unknown) => Promise<{ key: string, participants: string[], descriptor: { participantCount: number } }> }).resumeMembership('guest', { descriptor: saved.descriptor.slice(), privateKey: saved.privateKey.slice() })
    assert.equal(resumed.key, joined.key)
    assert.deepEqual([...resumed.participants].sort(), [...host.conf.get(room.id)!.participants].sort())
    assert.equal(resumed.descriptor.participantCount, 2)
    assert.equal(host.conf.get(room.id)?.participants.length, 2)
    assert.equal(host.events.filter(e => e.kind === 'arrival').length, arrivalsBefore)
    // A stranger claiming the member key cannot steal the refresh, and the room stays full.
    const stranger = await makeNode(net)
    try {
      const rogueBytes = net.sent.find(s => s.from === guest.peerId && s.data[0] === 1)!
      net.sendRaw(stranger.peerId, host.peerId, rogueBytes.data)
      await settle()
      assert.equal(host.conf.get(room.id)?.participants.length, 2)
    } finally { stranger.conf.stop() }
  } finally { host.conf.stop(); guest.conf.stop() }
})

test('resume with a forged or expired descriptor sends nothing', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const guest = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await guest.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = (guest.conf as unknown as { exportMembership: (c: string, s: string) => { descriptor: Uint8Array, privateKey: Uint8Array } }).exportMembership(room.id, 'guest')
    guest.conf.stop()
    guest.conf.start()
    const sentBefore = net.sent.filter(s => s.from === guest.peerId).length
    const forged = saved.descriptor.slice()
    forged[forged.length - 1] ^= 1
    await assert.rejects((guest.conf as unknown as { resumeMembership: (s: string, v: unknown) => Promise<unknown> }).resumeMembership('guest2', { descriptor: forged, privateKey: saved.privateKey.slice() }))
    guest.clock.now += 86400001
    host.clock.now += 86400001
    await assert.rejects((guest.conf as unknown as { resumeMembership: (s: string, v: unknown) => Promise<unknown> }).resumeMembership('guest3', { descriptor: saved.descriptor.slice(), privateKey: saved.privateKey.slice() }))
    await settle()
    assert.equal(net.sent.filter(s => s.from === guest.peerId).length, sentBefore)
    assert.deepEqual(guest.conf.list(), [])
  } finally { host.conf.stop(); guest.conf.stop() }
})

test('resume cannot replace a room already owned by another local session', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const guest = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    const joined = await guest.conf.join({ session: 'original', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = guest.conf.exportMembership(room.id, 'original')
    const before = net.sent.length
    await assert.rejects(guest.conf.resumeMembership('other', saved), /already in this conference/)
    assert.equal(guest.conf.get(room.id)!.session, 'original')
    assert.equal(guest.conf.get(room.id)!.key, joined.key)
    assert.equal(net.sent.length, before)
  } finally { host.conf.stop(); guest.conf.stop() }
})

test('aborted resume sends nothing and leaves no pending join', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const guest = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await guest.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = guest.conf.exportMembership(room.id, 'guest')
    guest.conf.stop()
    guest.conf.start()
    const sentBefore = net.sent.filter(s => s.from === guest.peerId).length
    let releaseVerify!: () => void
    const gate = new Promise<void>(resolve => { releaseVerify = resolve })
    let holdVerify = true
    const rawVerify = guest.transport.verify.bind(guest.transport)
    guest.transport.verify = (async (peer, data, sig) => {
      if (holdVerify) await gate
      return rawVerify(peer, data, sig)
    }) as typeof guest.transport.verify
    try {
      const controller = new AbortController()
      const pending = guest.conf.resumeMembership('guest',
        { descriptor: saved.descriptor.slice(), privateKey: saved.privateKey.slice() },
        { signal: controller.signal })
      const settled = pending.then(() => 'resolved', (error: unknown) => error)
      await settle()
      assert.ok(holdVerify, 'resume is still inside descriptor verification')
      assert.equal((guest.conf as unknown as { pending: Map<string, unknown> }).pending.size, 0)
      controller.abort()
      holdVerify = false
      releaseVerify()
      await assert.rejects(pending)
      assert.equal(await settled instanceof Error, true)
      await settle()
      assert.equal(net.sent.filter(s => s.from === guest.peerId).length, sentBefore)
      assert.equal((guest.conf as unknown as { pending: Map<string, unknown> }).pending.size, 0)
      assert.deepEqual(guest.conf.list(), [])
    } finally {
      holdVerify = false
      guest.transport.verify = rawVerify
    }
  } finally { host.conf.stop(); guest.conf.stop() }
})

test('explicit refresh updates roster in place without a new seat or arrival', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    const joinedA = await a.conf.join({ session: 'sa', ref: room.id, host: host.peerId, addrs: host.addrs })
    // Detach A's direct handler so B's arrival never lands: A's roster goes stale.
    const directs = (a.transport as unknown as { __directs: Array<(event: { from: string, data: Uint8Array }) => void> }).__directs
    const held = directs.splice(0, directs.length)
    await b.conf.join({ session: 'sb', ref: room.id, host: host.peerId, addrs: host.addrs })
    for (const handler of held) directs.push(handler)
    assert.ok(!a.conf.get(room.id)!.participants.includes(b.conf.get(room.id)!.key))
    const saved = a.conf.exportMembership(room.id, 'sa')
    const arrivalsBefore = host.events.filter(e => e.kind === 'arrival').length
    const refreshed = await a.conf.resumeMembership('sa', saved, { refresh: true })
    assert.equal(refreshed.key, joinedA.key)
    assert.ok(refreshed.participants.includes(b.conf.get(room.id)!.key))
    assert.equal(host.conf.get(room.id)?.participants.length, 3)
    assert.equal(host.events.filter(e => e.kind === 'arrival').length, arrivalsBefore)
    // Default resume still rejects a currently joined room.
    await assert.rejects(a.conf.resumeMembership('sa', saved), /already in this conference/)
  } finally { host.conf.stop(); a.conf.stop(); b.conf.stop() }
})

test('refresh rejects mismatched sessions and keys, and abort keeps membership without leave', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await a.conf.join({ session: 'sa', ref: room.id, host: host.peerId, addrs: host.addrs })
    await b.conf.join({ session: 'sb', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = a.conf.exportMembership(room.id, 'sa')
    const foreign = b.conf.exportMembership(room.id, 'sb')
    await assert.rejects(a.conf.resumeMembership('other', saved, { refresh: true }), /no matching membership/)
    await assert.rejects(a.conf.resumeMembership('sa',
      { descriptor: saved.descriptor, privateKey: foreign.privateKey }, { refresh: true }), /refreshed key does not match/)
    await assert.rejects(a.conf.resumeMembership('sa',
      { descriptor: saved.descriptor, privateKey: new Uint8Array(64) }, { refresh: true }), /invalid session private key/)
    // Abort mid-validation: no join, no leave, membership intact.
    let releaseVerify!: () => void
    const gate = new Promise<void>(resolve => { releaseVerify = resolve })
    let holdVerify = true
    const rawVerify = a.transport.verify.bind(a.transport)
    a.transport.verify = (async (peer, data, sig) => {
      if (holdVerify) await gate
      return rawVerify(peer, data, sig)
    }) as typeof a.transport.verify
    try {
      const controller = new AbortController()
      const pending = a.conf.resumeMembership('sa', saved, { signal: controller.signal, refresh: true })
      const settled = pending.then(() => 'resolved', (error: unknown) => error)
      await settle()
      controller.abort()
      holdVerify = false
      releaseVerify()
      await assert.rejects(pending)
      assert.equal(await settled instanceof Error, true)
      await settle()
      assert.equal(host.conf.get(room.id)?.participants.length, 3)
      const posted = await a.conf.post(room.id, 'sa', { type: 'text', content: new TextEncoder().encode('still here') })
      await settle()
      assert.ok(host.events.some(e => e.kind === 'message' && (e as unknown as { message: { id: string } }).message.id === posted.id))
    } finally {
      holdVerify = false
      a.transport.verify = rawVerify
    }
  } finally { host.conf.stop(); a.conf.stop(); b.conf.stop() }
})

test('authenticated unknown refresh ends the captured local membership', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const guest = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await guest.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = guest.conf.exportMembership(room.id, 'guest')
    host.conf.stop()
    host.conf.start()
    await assert.rejects(guest.conf.resumeMembership('guest', saved, { refresh: true }),
      (error: unknown) => error instanceof ConferenceRoomUnknownError && error.conference === room.id)
    assert.deepEqual(guest.conf.list(), [])
    assert.ok(guest.events.some(event => event.kind === 'closed' && event.conference === room.id))
  } finally { host.conf.stop(); guest.conf.stop() }
})

test('host revises topic in place without a new seat, and recipients follow', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const room = await h.conf.create({ session: 'sh', namespace: profile.id, topicVector: vector,
      statement: 'flood warnings' })
    const joined = await a.conf.join({ session: 'sa', ref: room.id, host: h.peerId, addrs: h.addrs })
    assert.equal(room.descriptor.revision, 1)
    const revised = await h.conf.reviseTopic({ conference: room.id, session: 'sh',
      topicVector: revisedVector, statement: 'river flood warnings' })
    assert.equal(revised.id, room.id)
    assert.equal(revised.key, room.key)
    assert.deepEqual(revised.participants, [room.key, joined.key])
    assert.equal(revised.descriptor.revision, 3)
    assert.deepEqual(revised.descriptor.topicVector, revisedVector)
    await settle(30)
    const seen = a.conf.get(room.id)
    assert.ok(seen !== undefined)
    assert.equal(seen.descriptor.revision, 3)
    assert.deepEqual(seen.descriptor.topicVector, revisedVector)
    assert.deepEqual(seen.participants, revised.participants)
    assert.equal(h.conf.get(room.id)?.descriptor.participantCount, 2)
    // The source text never travels: no wire packet carries it.
    for (const packet of net.sent) {
      assert.ok(!Buffer.from(packet.data).toString('utf8').includes('flood warnings'))
    }
    void joined
  } finally { h.conf.stop(); a.conf.stop() }
})

test('non-host and wrong-session revision is refused before any send', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const room = await h.conf.create({ session: 'sh', namespace: profile.id, topicVector: vector })
    await a.conf.join({ session: 'sa', ref: room.id, host: h.peerId, addrs: h.addrs })
    const before = net.sent.length
    await assert.rejects(a.conf.reviseTopic({ conference: room.id, session: 'sa',
      topicVector: revisedVector, statement: 'revised words' }), /not hosting/)
    await assert.rejects(h.conf.reviseTopic({ conference: room.id, session: 'nope',
      topicVector: revisedVector, statement: 'revised words' }), /not hosting/)
    await assert.rejects(h.conf.reviseTopic({ conference: 'f'.repeat(32), session: 'sh',
      topicVector: revisedVector, statement: 'revised words' }), /not hosting|unknown/)
    assert.equal(net.sent.length, before)
    assert.equal(h.conf.get(room.id)?.descriptor.revision, 2)
  } finally { h.conf.stop(); a.conf.stop() }
})

test('forged, wrong-room and stale topic updates are ignored', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const stranger = await makeNode(net)
  try {
    const room = await h.conf.create({ session: 'sh', namespace: profile.id, topicVector: vector })
    await a.conf.join({ session: 'sa', ref: room.id, host: h.peerId, addrs: h.addrs })
    const oldBytes = h.conf.hostedRecords()[0].bytes.slice()
    await h.conf.reviseTopic({ conference: room.id, session: 'sh', topicVector: revisedVector, statement: 'revised words' })
    await settle(30)
    assert.equal(a.conf.get(room.id)?.descriptor.revision, 3)
    // Stale: the previous revision replays nothing.
    net.sendRaw(h.peerId, a.peerId, frame({ topicUpdate: { conferenceId: unhex(room.id), descriptor: oldBytes } }))
    await settle()
    assert.equal(a.conf.get(room.id)?.descriptor.revision, 3)
    assert.deepEqual(a.conf.get(room.id)?.descriptor.topicVector, revisedVector)
    const current = h.conf.hostedRecords()[0].bytes
    // Tampered bytes fail signature verification.
    const tampered = current.slice()
    tampered[tampered.length - 1] ^= 0xff
    net.sendRaw(h.peerId, a.peerId, frame({ topicUpdate: { conferenceId: unhex(room.id), descriptor: tampered } }))
    await settle()
    assert.equal(a.conf.get(room.id)?.descriptor.revision, 3)
    // A valid, newer descriptor for another room cannot replace this one.
    const foreign = await createDescriptor({ id: freshRef(), profile, topicVector: vector,
      host: h.peerId, addrs: h.addrs, participantCount: 2, capacity: room.descriptor.capacity,
      admission: room.descriptor.admission, createdAt: room.descriptor.createdAt,
      expiresAt: room.descriptor.expiresAt, revision: 4, now: h.clock.now,
      sign: data => h.transport.sign(data) })
    net.sendRaw(h.peerId, a.peerId, frame({ topicUpdate: { conferenceId: unhex(room.id), descriptor: foreign.bytes } }))
    await settle()
    assert.equal(a.conf.get(room.id)?.descriptor.revision, 3)
    assert.deepEqual(a.conf.get(room.id)?.descriptor.topicVector, revisedVector)
    // A stranger claiming the host's update is ignored.
    net.sendRaw(stranger.peerId, a.peerId, frame({ topicUpdate: { conferenceId: unhex(room.id), descriptor: current } }))
    await settle()
    assert.equal(a.conf.get(room.id)?.descriptor.revision, 3)
    assert.deepEqual(a.conf.get(room.id)?.descriptor.topicVector, revisedVector)
  } finally { h.conf.stop(); a.conf.stop(); stranger.conf.stop() }
})

test('failed signing preserves the old topic and a retry succeeds once', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const room = await h.conf.create({ session: 'sh', namespace: profile.id, topicVector: vector,
      statement: 'old words' })
    await a.conf.join({ session: 'sa', ref: room.id, host: h.peerId, addrs: h.addrs })
    const sign = h.transport.sign.bind(h.transport)
    let failOnce = true
    h.transport.sign = (async (data: Uint8Array) => {
      if (failOnce) { failOnce = false; throw new Error('signer down') }
      return sign(data)
    }) as typeof h.transport.sign
    await assert.rejects(h.conf.reviseTopic({ conference: room.id, session: 'sh',
      topicVector: revisedVector, statement: 'new words' }), /signer down/)
    h.transport.sign = sign
    assert.deepEqual(h.conf.get(room.id)?.descriptor.topicVector, vector)
    assert.equal(h.conf.get(room.id)?.descriptor.revision, 2)
    assert.deepEqual(h.conf.hostTopicSource(room.id, 'sh').topicVector, vector)
    assert.equal(h.conf.hostTopicSource(room.id, 'sh').statement, 'old words')
    const revised = await h.conf.reviseTopic({ conference: room.id, session: 'sh',
      topicVector: revisedVector, statement: 'new words' })
    assert.equal(revised.descriptor.revision, 3)
    assert.deepEqual(revised.descriptor.topicVector, revisedVector)
  } finally { h.conf.stop(); a.conf.stop() }
})

test('stop and leave across signing publish nothing stale', async () => {
  for (const ending of ['stop', 'leave'] as const) {
    const net = createNetwork()
    const h = await makeNode(net)
    const a = await makeNode(net)
    try {
      const room = await h.conf.create({ session: 'sh', namespace: profile.id, topicVector: vector })
      await a.conf.join({ session: 'sa', ref: room.id, host: h.peerId, addrs: h.addrs })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const sign = h.transport.sign.bind(h.transport)
      h.transport.sign = (async (data: Uint8Array) => {
        await gate
        return sign(data)
      }) as typeof h.transport.sign
      const revising = h.conf.reviseTopic({ conference: room.id, session: 'sh', topicVector: revisedVector, statement: 'revised words' }).then(
        value => ({ value }), error => ({ error }))
      await settle()
      const sentBefore = net.sent.length
      if (ending === 'stop') h.conf.stop()
      else await h.conf.leave(room.id, 'sh')
      release()
      h.transport.sign = sign
      const outcome = await revising
      assert.ok('error' in outcome)
      const updates = net.sent.filter(s => {
        try {
          return ConferencePacket.decode(s.data.subarray(1)).topicUpdate !== undefined
        } catch { return false }
      })
      assert.equal(updates.length, 0)
      const fresh = net.sent.slice(sentBefore)
      if (ending === 'stop') assert.equal(fresh.length, 0)
      else {
        assert.equal(fresh.length, 1)
        assert.ok(ConferencePacket.decode(fresh[0].data.subarray(1)).close !== undefined)
      }
      assert.equal(h.conf.get(room.id), undefined)
    } finally { h.conf.stop(); a.conf.stop() }
  }
})

test('a join racing a revision keeps a monotonic revision and count', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  try {
    const room = await h.conf.create({ session: 'sh', namespace: profile.id, topicVector: vector })
    await a.conf.join({ session: 'sa', ref: room.id, host: h.peerId, addrs: h.addrs })
    assert.equal(h.conf.get(room.id)?.descriptor.revision, 2)
    const revising = h.conf.reviseTopic({ conference: room.id, session: 'sh', topicVector: revisedVector, statement: 'revised words' })
    const joining = b.conf.join({ session: 'sb', ref: room.id, host: h.peerId, addrs: h.addrs })
    const [revised, joined] = await Promise.all([revising, joining])
    assert.equal(revised.participants.length, 2)
    assert.equal(revised.descriptor.revision, 3)
    assert.equal(joined.participants.length, 3)
    const final = h.conf.get(room.id)
    assert.ok(final !== undefined)
    assert.equal(final.descriptor.participantCount, 3)
    assert.equal(final.descriptor.revision, 4)
    assert.deepEqual(final.descriptor.topicVector, revisedVector)
    await settle(30)
    for (const node of [a, b]) {
      assert.equal(node.conf.get(room.id)?.descriptor.revision, 4)
      assert.deepEqual(node.conf.get(room.id)?.descriptor.topicVector, revisedVector)
    }
  } finally { h.conf.stop(); a.conf.stop(); b.conf.stop() }
})

test('lazy formation keeps its source after withdrawal, detached from public views', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const ref = freshRef()
    h.formables.set(ref, { id: ref, session: 'sh', namespace: profile.id, topicVector: vector, statement: 'kept words' })
    await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
    h.formables.delete(ref)
    const source = h.conf.hostTopicSource(ref, 'sh')
    assert.equal(source.statement, 'kept words')
    assert.deepEqual(source.topicVector, vector)
    source.topicVector.fill(0)
    assert.deepEqual(h.conf.hostTopicSource(ref, 'sh').topicVector, vector)
    assert.throws(() => h.conf.hostTopicSource(ref, 'other'), /not hosting|session/)
    for (const view of [h.conf.get(ref)!, ...h.conf.list(), ...h.conf.hostedRecords()]) {
      assert.ok(!JSON.stringify(view).includes('kept words'))
    }
  } finally { h.conf.stop(); a.conf.stop() }
})
