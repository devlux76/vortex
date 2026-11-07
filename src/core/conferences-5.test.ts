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

test('topic revision requires the source for the new vector', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id,
      topicVector: vector, statement: 'original source' })
    const before = host.conf.hostTopicSource(room.id, 'host')
    const missing = { conference: room.id, session: 'host', topicVector: revisedVector } as Parameters<Conferences['reviseTopic']>[0]
    await assert.rejects(host.conf.reviseTopic(missing), /invalid statement/)
    assert.deepEqual(host.conf.hostTopicSource(room.id, 'host'), before)
  } finally { host.conf.stop() }
})

test('stop and leave during topic fanout prevent later sends and success', async () => {
  for (const ending of ['stop', 'leave'] as const) {
    const net = createNetwork()
    const host = await makeNode(net)
    const a = await makeNode(net)
    const b = await makeNode(net)
    let release: () => void = () => {}
    try {
      const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
      await a.conf.join({ session: 'a', ref: room.id, host: host.peerId, addrs: host.addrs })
      await b.conf.join({ session: 'b', ref: room.id, host: host.peerId, addrs: host.addrs })
      const gate = new Promise<void>(resolve => { release = resolve })
      let entered: () => void = () => {}
      const ready = new Promise<void>(resolve => { entered = resolve })
      const send = host.transport.send.bind(host.transport)
      let updates = 0
      host.transport.send = async (peer, data, addrs) => {
        if (ConferencePacket.decode(data.subarray(1)).topicUpdate !== undefined) {
          updates += 1
          if (updates === 1) { entered(); await gate }
        }
        await send(peer, data, addrs)
      }
      const pending = host.conf.reviseTopic({ conference: room.id, session: 'host',
        topicVector: revisedVector, statement: 'revised source' }).then(value => ({ value }), error => ({ error }))
      await ready
      if (ending === 'stop') host.conf.stop()
      else await host.conf.leave(room.id, 'host')
      release()
      assert.ok('error' in await pending)
      assert.equal(updates, 1)
    } finally { release(); host.conf.stop(); a.conf.stop(); b.conf.stop() }
  }
})

test('join captures the original query and later mutation cannot rebind it', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const ref = freshRef()
    h.formables.set(ref, formable(ref, 'sh'))
    const input = querySubject()
    const joining = a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs, subject: input })
    input.statement = 'mutated'
    input.vector = '00'.repeat(32)
    const info = await joining
    assert.equal(info.id, ref)
    const held = a.conf.membershipSubject(ref, 'sa')
    assert.deepEqual(held, querySubject())
    assert.throws(() => a.conf.membershipSubject(ref, 'wrong'), /not in this conference|wrong session|not a member/)
    assert.throws(() => h.conf.membershipSubject(ref, 'sh'), /host|not in this conference|participant/)
  } finally { h.conf.stop(); a.conf.stop() }
})

test('topic revision never replaces the original query and export copies it', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const ref = freshRef()
    h.formables.set(ref, formable(ref, 'sh'))
    await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs, subject: querySubject() })
    const revisedVector = Float32Array.from(vector)
    revisedVector[0] = 0.9
    await h.conf.reviseTopic({ conference: ref, session: 'sh', topicVector: revisedVector, statement: 'new words' })
    await settle()
    assert.deepEqual(a.conf.membershipSubject(ref, 'sa'), querySubject())
    const saved = a.conf.exportMembership(ref, 'sa')
    assert.deepEqual(saved.subject, querySubject())
    saved.subject!.statement = 'mutated'
    assert.deepEqual(a.conf.membershipSubject(ref, 'sa'), querySubject())
    // Fresh resume restores the subject; refresh preserves the held one.
    a.conf.stop()
    a.conf.start()
    const resumed = await a.conf.resumeMembership('sa',
      { descriptor: saved.descriptor, privateKey: saved.privateKey }, { subject: querySubject() })
    assert.deepEqual(a.conf.membershipSubject(ref, 'sa'), querySubject())
    void resumed
    const other = querySubject({ statement: 'other words' })
    const refreshed = await a.conf.resumeMembership('sa',
      { descriptor: saved.descriptor, privateKey: saved.privateKey }, { refresh: true, subject: other })
    assert.deepEqual(a.conf.membershipSubject(ref, 'sa'), querySubject())
    void refreshed
  } finally { h.conf.stop(); a.conf.stop() }
})

test('legacy memberships without a subject stay compatible', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const ref = freshRef()
    h.formables.set(ref, formable(ref, 'sh'))
    await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
    assert.equal(a.conf.membershipSubject(ref, 'sa'), undefined)
    const saved = a.conf.exportMembership(ref, 'sa')
    assert.ok(!('subject' in saved))
    a.conf.stop()
    a.conf.start()
    await a.conf.resumeMembership('sa', { descriptor: saved.descriptor, privateKey: saved.privateKey })
    assert.equal(a.conf.membershipSubject(ref, 'sa'), undefined)
  } finally { h.conf.stop(); a.conf.stop() }
})

test('certified roster returns authenticated services and rejects strangers', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const stranger = await makeNode(net)
  try {
    const ref = freshRef()
    h.formables.set(ref, formable(ref, 'sh'))
    const infoA = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs, subject: querySubject() })
    const roster = a.conf.certifiedParticipants(ref, 'sa')
    assert.equal(roster.length, 2)
    const byKey = new Map(roster.map(entry => [entry.participant, entry.service]))
    assert.equal(byKey.get(infoA.key), a.peerId)
    assert.equal(byKey.get(h.conf.get(ref)!.key), h.peerId)
    roster[0].service = 'tampered'
    assert.notEqual(a.conf.certifiedParticipants(ref, 'sa')[0].service, 'tampered')
    // A forged arrival cert is never admitted to the verified roster.
    const before = a.conf.certifiedParticipants(ref, 'sa')
    net.sendRaw(h.peerId, a.peerId, frame({ arrival: { conferenceId: unhex(ref),
      cert: new Uint8Array([9, 9, 9]), descriptor: h.conf.hostedRecords()[0].bytes } }))
    await settle()
    assert.deepEqual(a.conf.certifiedParticipants(ref, 'sa'), before)
    assert.throws(() => a.conf.certifiedParticipants(ref, 'wrong'), /not in this conference|wrong session|not a member/)
    assert.throws(() => stranger.conf.certifiedParticipants(ref, 'sx'), /not in this conference|not a member/)
    assert.throws(() => h.conf.certifiedParticipants('ff'.repeat(16), 'sh'), /not in this conference|unknown|not a member/)
    // Hosted sessions see the same verified roster, including the remote guest.
    const hosted = h.conf.certifiedParticipants(ref, 'sh')
    assert.equal(hosted.length, 2)
    const hostedByKey = new Map(hosted.map(entry => [entry.participant, entry.service]))
    assert.equal(hostedByKey.get(infoA.key), a.peerId)
    assert.equal(hostedByKey.get(h.conf.get(ref)!.key), h.peerId)
    assert.throws(() => h.conf.certifiedParticipants(ref, 'wrong'), /not in this conference|wrong session|not a member/)
  } finally { h.conf.stop(); a.conf.stop(); stranger.conf.stop() }
})

test('off-profile subjects are rejected at join and resume without wire trace', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  try {
    const ref = freshRef()
    h.formables.set(ref, formable(ref, 'sh'))
    const shortHex = Array.from(encodeVector(Float32Array.from([1, 0, 0, 0])), byte => byte.toString(16).padStart(2, '0')).join('')
    const cases = [
      querySubject({ namespace: 'ff'.repeat(32) }),
      querySubject({ profileVersion: 99 }),
      querySubject({ vector: shortHex }),
      querySubject({ statement: '' })
    ]
    for (const subject of cases) {
      await assert.rejects(a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs, subject }), /invalid (peer )?subject/)
    }
    assert.deepEqual(a.conf.list(), [])
    const info = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs, subject: querySubject() })
    void info
    // The source text never appears in any wire packet.
    for (const packet of net.sent) {
      assert.ok(!Buffer.from(packet.data).toString('utf8').includes('flood query'))
    }
    const saved = a.conf.exportMembership(ref, 'sa')
    a.conf.stop()
    a.conf.start()
    await assert.rejects(a.conf.resumeMembership('sa',
      { descriptor: saved.descriptor, privateKey: saved.privateKey },
      { subject: querySubject({ namespace: 'ff'.repeat(32) }) }), /invalid (peer )?subject/)
    assert.deepEqual(a.conf.list(), [])
    assert.equal(net.sent.filter(s => s.from === a.peerId).length, 1)
  } finally { h.conf.stop(); a.conf.stop() }
})
