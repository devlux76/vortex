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

// Docs: VORTEX_v5.1.md sections 6.1 and 11.2
test('discovery during first descriptor signing exposes no provisional room and still returns other rooms', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const firstGuest = await makeNode(net)
  const secondGuest = await makeNode(net)
  const first = freshRef()
  const second = freshRef()
  host.formables.set(first, formable(first, 'h1'))
  host.formables.set(second, formable(second, 'h2'))
  await firstGuest.conf.join({ session: 'g1', ref: first, host: host.peerId, addrs: host.addrs })
  let release = () => {}
  let entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const sign = host.transport.sign.bind(host.transport)
  host.transport.sign = async data => {
    if (!entered && new TextDecoder().decode(data).startsWith('vortex-descriptor:1\n')) {
      entered = true
      await gate
    }
    return sign(data)
  }
  const joining = secondGuest.conf.join({ session: 'g2', ref: second, host: host.peerId, addrs: host.addrs })
  try {
    await settle()
    assert.equal(entered, true)
    assert.deepEqual(host.conf.hostedRecords().map(r => r.descriptor.id), [first])
  } finally {
    release()
    await joining
    host.conf.stop(); firstGuest.conf.stop(); secondGuest.conf.stop()
  }
})

// Docs: VORTEX_v5.1.md sections 6.2, 6.3 and 10.3
for (const admission of ['open', 'invitation', 'group'] as const) {
  test(`explicit ${admission} creation enforces admission before disclosing membership`, async () => {
    const net = createNetwork()
    const host = await makeNode(net)
    const member = await makeNode(net)
    const stranger = await makeNode(net)
    try {
      const created = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector,
        capacity: 2, admission, peers: admission === 'open' ? undefined : [member.peerId] })
      assert.match(created.id, /^[0-9a-f]{32}$/)
      assert.equal(created.role, 'host')
      assert.equal(created.descriptor.participantCount, 1)
      assert.equal(created.descriptor.admission, admission)
      assert.equal(created.descriptor.capacity, 2)
      assert.deepEqual(host.events.map(event => event.kind), ['formed'])
      assert.equal(host.formables.size, 0)
      assert.equal(host.conf.hostedRecords().length, 1)
      assert.equal('peers' in host.conf.hostedRecords()[0].descriptor, false)
      if (admission !== 'open') {
        await assert.rejects(stranger.conf.join({ session: 'stranger', ref: created.id, host: host.peerId, addrs: host.addrs }), /not_admitted/)
        const reply = net.sent.filter(packet => packet.peer === stranger.peerId).map(packet => ConferencePacket.decode(packet.data.slice(1))).at(-1)!.reply!
        assert.equal(reply.descriptor.length, 0)
        assert.deepEqual(reply.roster, [])
        await host.conf.post(created.id, 'host', { type: 'text', content: new TextEncoder().encode('private') })
        await settle()
        assert.deepEqual(stranger.events, [])
      }
      const joined = await member.conf.join({ session: 'member', ref: created.id, host: host.peerId, addrs: host.addrs })
      assert.equal(joined.descriptor.participantCount, 2)
      await assert.rejects(stranger.conf.join({ session: 'stranger', ref: created.id, host: host.peerId, addrs: host.addrs }), /full|not_admitted/)
      await member.conf.leave(created.id, 'member')
      await settle()
      if (admission === 'invitation') {
        await assert.rejects(member.conf.join({ session: 'member', ref: created.id, host: host.peerId, addrs: host.addrs }), /not_admitted/)
      } else {
        const rejoined = await member.conf.join({ session: 'member', ref: created.id, host: host.peerId, addrs: host.addrs })
        assert.notEqual(rejoined.key, joined.key)
      }
    } finally { host.conf.stop(); member.conf.stop(); stranger.conf.stop() }
  })
}

test('invalid explicit creation options leave no hosted room or formation event', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  try {
    for (const change of [{ capacity: 1 }, { capacity: 2.5 }, { capacity: 257 }, { admission: 'unknown' },
      { peers: ['not-a-peer'], admission: 'group' }, { peers: [], admission: 'open' }, { session: '' }]) {
      await assert.rejects(host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector, ...change } as any))
      assert.deepEqual(host.conf.list(), [])
      assert.deepEqual(host.events, [])
    }
  } finally { host.conf.stop() }
})

test('explicit creation reserves host capacity and stop rejects unfinished signing', async () => {
  const net = createNetwork()
  const host = await makeNode(net, undefined, { maxHosted: 1 })
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const sign = host.transport.sign
  host.transport.sign = async data => { entered(); await gate; return sign(data) }
  const request = { session: 'host', namespace: profile.id, topicVector: vector }
  const pending = host.conf.create(request).catch(error => error)
  try {
    await ready
    await assert.rejects(host.conf.create(request), /too many hosted conferences/)
    assert.deepEqual(host.conf.hostedRecords(), [])
    host.conf.stop(); host.conf.start()
    release()
    assert.match((await pending).message, /stopped/)
    assert.deepEqual(host.conf.list(), [])
    host.transport.sign = sign
    const fresh = await host.conf.create(request)
    assert.equal(fresh.descriptor.participantCount, 1)
  } finally { release(); host.conf.stop() }
})

test('group admission recognizes equivalent encodings of the authenticated peer identity', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const member = await makeNode(net)
  try {
    const cid = peerIdFromString(member.peerId).toCID().toString()
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector,
      admission: 'group', peers: [cid] })
    const joined = await member.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    assert.equal(joined.descriptor.participantCount, 2)
  } finally { host.conf.stop(); member.conf.stop() }
})

test('failed admission signing preserves the roster and an unused invitation', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const member = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector,
      admission: 'invitation', peers: [member.peerId], capacity: 2 })
    const sign = host.transport.sign
    host.transport.sign = async () => { throw new Error('sign failed') }
    const joining = member.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs }).catch(error => error)
    await settle()
    assert.equal(host.conf.get(room.id)!.participants.length, 1)
    assert.equal(host.conf.get(room.id)!.descriptor.participantCount, 1)
    member.conf.abandon(room.id)
    assert.ok(await joining instanceof Error)
    host.transport.sign = sign
    const retried = await member.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    assert.equal(retried.descriptor.participantCount, 2)
  } finally { host.conf.stop(); member.conf.stop() }
})

// Docs: VORTEX_v5.1.md section 8.3; docs/handoff/DELIVERY-PLAN.md C7b.
test('history pages preserve signed provenance after the author leaves and report retention gaps', async () => {
  const net = createNetwork()
  const host = await makeNode(net, undefined, { historyLimit: 3 })
  const author = await makeNode(net)
  const reader = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await host.conf.post(room.id, 'host', { type: 'text', content: new TextEncoder().encode('first') })
    const joined = await author.conf.join({ session: 'author', ref: room.id, host: host.peerId, addrs: host.addrs })
    await author.conf.post(room.id, 'author', { type: 'text', content: new TextEncoder().encode('departed author') })
    await settle()
    await author.conf.leave(room.id, 'author'); await settle()
    await host.conf.post(room.id, 'host', { type: 'text', content: new TextEncoder().encode('third') })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    const first = await reader.conf.history({ conference: room.id, session: 'reader', limit: 1 })
    assert.deepEqual(first.records.map(record => record.sequence), [1])
    assert.equal(new TextDecoder().decode(first.records[0].message.content), 'first')
    assert.equal(first.cursor, 1); assert.equal(first.more, true); assert.equal(first.firstAvailable, 1); assert.equal(first.latest, 3)
    const next = await reader.conf.history({ conference: room.id, session: 'reader', after: first.cursor, limit: 2 })
    assert.deepEqual(next.records.map(record => record.sequence), [2, 3])
    assert.equal(next.records[0].message.sender, joined.key)
    assert.equal(next.records[0].service, author.peerId)
    assert.equal(next.cursor, 3); assert.equal(next.more, false)
    await host.conf.post(room.id, 'host', { type: 'text', content: new TextEncoder().encode('fourth') })
    const retained = await host.conf.history({ conference: room.id, session: 'host' })
    assert.deepEqual(retained.records.map(record => record.sequence), [2, 3, 4])
    assert.equal(retained.firstAvailable, 2)
    await assert.rejects(reader.conf.history({ conference: room.id, session: 'wrong' }), /not in this conference/)
  } finally { host.conf.stop(); author.conf.stop(); reader.conf.stop() }
})

for (const options of [{ historyLimit: 0 }, { historyBytes: 0 }, { historyBytes: 1 }]) {
  test(`history retention honors ${JSON.stringify(options)}`, async () => {
    const net = createNetwork()
    const host = await makeNode(net, undefined, options)
    try {
      const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
      await host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array([1]) })
      const page = await host.conf.history({ conference: room.id, session: 'host' })
      assert.deepEqual(page.records, [])
      assert.equal(page.firstAvailable, 2); assert.equal(page.latest, 1); assert.equal(page.cursor, 1); assert.equal(page.more, false)
    } finally { host.conf.stop() }
  })
}

test('history pages bound maximum message bodies by encoded reply bytes', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const reader = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    for (let i = 0; i < 4; i++) await host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array(16384).fill(i) })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    const first = await reader.conf.history({ conference: room.id, session: 'reader', limit: 20 })
    assert.equal(first.records.length, 3); assert.equal(first.more, true)
    for (const packet of net.sent.filter(packet => ConferencePacket.decode(packet.data.slice(1)).historyReply)) assert.ok(packet.data.length <= 65536)
    const second = await reader.conf.history({ conference: room.id, session: 'reader', after: first.cursor })
    assert.equal(second.records.length, 1); assert.equal(second.more, false); assert.equal(second.records[0].message.content.length, 16384)
  } finally { host.conf.stop(); reader.conf.stop() }
})

test('history requests from a nonmember disclose no records, even with a member session key', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const member = await makeNode(net)
  const stranger = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await host.conf.post(room.id, 'host', { type: 'text', content: new TextEncoder().encode('secret history') })
    const joined = await member.conf.join({ session: 'member', ref: room.id, host: host.peerId, addrs: host.addrs })
    net.sendRaw(stranger.peerId, host.peerId, frame({ historyRequest: { conferenceId: unhex(room.id), requestId: new Uint8Array(16).fill(3),
      sessionKey: unhex(joined.key), after: 0n, limit: 20 } }))
    await settle()
    const reply = net.sent.filter(packet => packet.peer === stranger.peerId).map(packet => ConferencePacket.decode(packet.data.slice(1)).historyReply).find(Boolean)!
    assert.equal(reply.error, 'not_member'); assert.deepEqual(reply.entries, [])
    assert.deepEqual(stranger.events, [])
  } finally { host.conf.stop(); member.conf.stop(); stranger.conf.stop() }
})

for (const action of ['leave', 'close', 'stop', 'expiry', 'timeout'] as const) {
  test(`pending history rejects on ${action} and late replies cannot revive it`, async () => {
    const net = createNetwork()
    const host = await makeNode(net)
    const reader = await makeNode(net)
    const held: Uint8Array[] = []
    const send = host.transport.send
    try {
      const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
      await host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array([1]) })
      await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
      host.transport.send = async (peer, data) => {
        if (ConferencePacket.decode(data.slice(1)).historyReply) { held.push(data); return }
        return send(peer, data)
      }
      const outcome = reader.conf.history({ conference: room.id, session: 'reader', timeoutMs: 80 }).catch(error => error)
      await settle()
      assert.equal(held.length, 1)
      if (action === 'leave') await reader.conf.leave(room.id, 'reader')
      if (action === 'close') await host.conf.leave(room.id, 'host')
      if (action === 'stop') { reader.conf.stop(); reader.conf.start() }
      if (action === 'expiry') { reader.clock.now += 86400001; reader.conf.list() }
      assert.ok(await outcome instanceof Error)
      net.sendRaw(host.peerId, reader.peerId, held[0]); await settle()
      assert.equal(reader.events.filter(event => event.kind === 'message').length, 0)
    } finally { host.conf.stop(); reader.conf.stop() }
  })
}

test('a forged history sibling rejects the whole page and a subsequent valid request succeeds', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const reader = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    for (const byte of [1, 2]) await host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array([byte]) })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    const send = host.transport.send
    host.transport.send = async (peer, data) => {
      const packet = ConferencePacket.decode(data.slice(1))
      if (packet.historyReply) {
        packet.historyReply.entries[1].message[packet.historyReply.entries[1].message.length - 1] ^= 1
        return send(peer, frame(packet))
      }
      return send(peer, data)
    }
    await assert.rejects(reader.conf.history({ conference: room.id, session: 'reader' }), /invalid conference history/)
    assert.equal(reader.events.filter(event => event.kind === 'message').length, 0)
    host.transport.send = send
    const page = await reader.conf.history({ conference: room.id, session: 'reader' })
    assert.deepEqual(page.records.map(record => record.sequence), [1, 2])
  } finally { host.conf.stop(); reader.conf.stop() }
})

test('history reply byte budget includes the more flag at the exact boundary', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const reader = await makeNode(net)
  const create = async (length: number) => {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    for (const size of [16384, 16384, 16384, length, 1]) await host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array(size) })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    return room
  }
  try {
    const small = await create(10000)
    await reader.conf.history({ conference: small.id, session: 'reader', limit: 4 })
    const size = net.sent.filter(packet => ConferencePacket.decode(packet.data.slice(1)).historyReply).at(-1)!.data.length
    const boundary = await create(10000 + 65537 - size)
    const page = await reader.conf.history({ conference: boundary.id, session: 'reader', limit: 4 })
    assert.equal(page.records.length, 3)
    assert.ok(net.sent.filter(packet => ConferencePacket.decode(packet.data.slice(1)).historyReply).every(packet => packet.data.length <= 65536))
  } finally { host.conf.stop(); reader.conf.stop() }
})

test('a host post spanning stop sends nothing and cannot resurrect retained history', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const reader = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    const before = net.sent.length
    const posting = host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array([1]) }).catch(error => error)
    host.conf.stop()
    assert.ok(await posting instanceof Error)
    assert.equal(net.sent.length, before)
  } finally { host.conf.stop(); reader.conf.stop() }
})

test('history cancellation releases a request slot and the outstanding request cap is enforced', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const reader = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    const send = host.transport.send
    host.transport.send = async (peer, data) => ConferencePacket.decode(data.slice(1)).historyReply ? undefined : send(peer, data)
    const controller = new AbortController()
    const first = reader.conf.history({ conference: room.id, session: 'reader', timeoutMs: 80, signal: controller.signal }).catch(error => error)
    const rest = Array.from({ length: 31 }, () => reader.conf.history({ conference: room.id, session: 'reader', timeoutMs: 1000 }).catch(error => error))
    await assert.rejects(reader.conf.history({ conference: room.id, session: 'reader' }), /too many pending/)
    controller.abort()
    assert.match((await first).message, /canceled/)
    const next = reader.conf.history({ conference: room.id, session: 'reader' }).catch(error => error)
    reader.conf.stop()
    assert.ok(await next instanceof Error)
    await Promise.all(rest)
  } finally { host.conf.stop(); reader.conf.stop() }
})

test('an empty history page cannot advance past metadata claiming retained messages', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const reader = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    await host.conf.post(room.id, 'host', { type: 'text', content: new Uint8Array([1]) })
    await reader.conf.join({ session: 'reader', ref: room.id, host: host.peerId, addrs: host.addrs })
    const send = host.transport.send
    host.transport.send = async (peer, data) => {
      const packet = ConferencePacket.decode(data.slice(1))
      if (packet.historyReply) { packet.historyReply.entries = []; packet.historyReply.cursor = packet.historyReply.latest; packet.historyReply.more = false }
      return send(peer, frame(packet))
    }
    await assert.rejects(reader.conf.history({ conference: room.id, session: 'reader' }), /invalid conference history/)
  } finally { host.conf.stop(); reader.conf.stop() }
})

// Docs: TODO.md C8 — private membership persistence and authenticated resume.
test('exported membership is copied and no private key reaches public info or wire', async () => {
  const net = createNetwork()
  const host = await makeNode(net)
  const guest = await makeNode(net)
  try {
    const room = await host.conf.create({ session: 'host', namespace: profile.id, topicVector: vector })
    const joined = await guest.conf.join({ session: 'guest', ref: room.id, host: host.peerId, addrs: host.addrs })
    const saved = (guest.conf as unknown as { exportMembership: (c: string, s: string) => { descriptor: Uint8Array, privateKey: Uint8Array } }).exportMembership(room.id, 'guest')
    assert.ok(saved.descriptor instanceof Uint8Array && saved.descriptor.length > 0)
    assert.ok(saved.privateKey instanceof Uint8Array && saved.privateKey.length > 0)
    const descCopy = saved.descriptor.slice()
    const keyCopy = saved.privateKey.slice()
    saved.descriptor.fill(0)
    saved.privateKey.fill(0)
    const again = (guest.conf as unknown as { exportMembership: (c: string, s: string) => { descriptor: Uint8Array, privateKey: Uint8Array } }).exportMembership(room.id, 'guest')
    assert.deepEqual(again.descriptor, descCopy)
    assert.deepEqual(again.privateKey, keyCopy)
    const keyHex = Buffer.from(keyCopy).toString('hex')
    for (const info of [guest.conf.get(room.id)!, ...guest.conf.list(), ...host.conf.list()]) {
      assert.equal(JSON.stringify(info).includes(keyHex), false)
      assert.equal('privateKey' in (info as unknown as Record<string, unknown>), false)
    }
    for (const record of host.conf.hostedRecords()) {
      assert.equal(JSON.stringify(record).includes(keyHex), false)
    }
    for (const packet of net.sent) {
      assert.equal(Buffer.from(packet.data).toString('hex').includes(keyHex), false)
    }
    assert.throws(() => (guest.conf as unknown as { exportMembership: (c: string, s: string) => unknown }).exportMembership(room.id, 'wrong'), /not in/)
    assert.throws(() => (host.conf as unknown as { exportMembership: (c: string, s: string) => unknown }).exportMembership(room.id, 'host'), /host|participant|not in/)
    void joined
  } finally { host.conf.stop(); guest.conf.stop() }
})
