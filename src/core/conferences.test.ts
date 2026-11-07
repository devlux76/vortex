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

// Docs: VORTEX_v5.1.md section 6.2
test('formation: a join forms the conference from the interest', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  assert.deepEqual(h.conf.list(), [])
  const info = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  assert.equal(info.role, 'participant')
  assert.equal(info.id, ref)
  assert.equal(info.host, h.peerId)
  assert.equal(info.participants.length, 2)
  const hosted = h.conf.get(ref)
  assert.ok(hosted !== undefined && hosted.role === 'host')
  assert.deepEqual(info.participants, hosted.participants)
  assert.deepEqual(h.events.map(e => e.kind), ['formed', 'arrival'])
  assert.equal(h.events[1].kind, 'arrival')
  if (h.events[1].kind === 'arrival') {
    assert.equal(h.events[1].participant, info.key)
    assert.equal(h.events[1].service, a.peerId)
    assert.equal(h.events[1].count, 2)
  }
  assert.deepEqual(a.events, [])
  await settle()
})

// Docs: VORTEX_v5.1.md section 6
test('a third joins the same way and everyone sees the arrival', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  const infoA = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  const infoB = await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  assert.equal(infoB.participants.length, 3)
  const hosted = h.conf.get(ref)
  assert.ok(hosted !== undefined)
  assert.equal(infoB.participants[0], hosted.key)
  assert.deepEqual(infoB.participants, hosted.participants)
  assert.ok(infoB.participants.includes(infoA.key))
  const arrivalA = a.events.find(e => e.kind === 'arrival')
  assert.ok(arrivalA !== undefined && arrivalA.kind === 'arrival')
  if (arrivalA.kind === 'arrival') {
    assert.equal(arrivalA.participant, infoB.key)
    assert.equal(arrivalA.service, b.peerId)
  }
  assert.equal(h.events.filter(e => e.kind === 'arrival').length, 2)
  for (const node of [h, a, b]) {
    assert.equal(node.conf.get(ref)?.descriptor.participantCount, 3)
  }
  await settle()
})

// Docs: VORTEX_v5.1.md section 7.3
test('a message is seen by everyone else exactly once, with the same bytes', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  const infoA = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  const content = new TextEncoder().encode('hello all')
  await a.conf.post(ref, 'sa', { type: 'text', content })
  await settle()
  const atH = h.events.filter(e => e.kind === 'message')
  const atB = b.events.filter(e => e.kind === 'message')
  assert.equal(atH.length, 1)
  assert.equal(atB.length, 1)
  assert.deepEqual(a.events.filter(e => e.kind === 'message'), [])
  assert.ok(atH[0].kind === 'message' && atB[0].kind === 'message')
  if (atH[0].kind === 'message' && atB[0].kind === 'message') {
    assert.equal(atH[0].message.id, atB[0].message.id)
    assert.deepEqual(atH[0].message.content, content)
    assert.equal(atH[0].message.sender, infoA.key)
    assert.equal(atH[0].service, a.peerId)
    assert.equal(atB[0].service, a.peerId)
  }
  // The host forwarded the same bytes it received.
  const postsFrom = (peer: PeerId): Uint8Array[] => net.sent
    .filter(s => s.from === peer && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1)))
    .filter(p => p.post !== undefined)
    .map(p => (p.post as { message: Uint8Array }).message)
  assert.deepEqual(postsFrom(a.peerId), postsFrom(h.peerId).slice(0, 1))
  await h.conf.post(ref, 'sh', { type: 'text', content: new TextEncoder().encode('from host') })
  await b.conf.post(ref, 'sb', { type: 'text', content: new TextEncoder().encode('from b') })
  await settle()
  assert.equal(a.events.filter(e => e.kind === 'message').length, 2)
  assert.equal(h.events.filter(e => e.kind === 'message').length, 2)
  assert.equal(b.events.filter(e => e.kind === 'message').length, 2)
})

// Docs: TODO.md C1 — ordered signed descriptor updates.
test('replayed arrivals cannot restore a departed participant', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  const infoB = await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  await settle(100)
  assert.ok(a.conf.get(ref)!.participants.includes(infoB.key))
  const arrival = net.sent.find(s => s.from === h.peerId && s.peer === a.peerId &&
    ConferencePacket.decode(s.data.subarray(1)).arrival !== undefined)!
  assert.equal(await b.conf.leave(ref, 'sb'), true)
  await settle(100)
  assert.ok(!a.conf.get(ref)!.participants.includes(infoB.key))
  const snapshot = JSON.stringify(a.conf.get(ref))
  const events = a.events.length
  net.sendRaw(h.peerId, a.peerId, arrival.data)
  await replayBarrier(h, a, ref)
  assert.equal(JSON.stringify(a.conf.get(ref)), snapshot)
  assert.equal(a.events.length, events + 1)
  assert.ok(!a.conf.get(ref)!.participants.includes(infoB.key))
  h.conf.stop(); a.conf.stop(); b.conf.stop()
})

test('replayed departures cannot remove a freshly readmitted certificate', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  const infoB = await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  await settle()
  const request = net.sent.find(s => s.from === b.peerId && s.peer === h.peerId &&
    ConferencePacket.decode(s.data.subarray(1)).join !== undefined)!
  assert.equal(await b.conf.leave(ref, 'sb'), true)
  await settle(100)
  const departure = net.sent.find(s => s.from === h.peerId && s.peer === a.peerId &&
    ConferencePacket.decode(s.data.subarray(1)).departure !== undefined)!
  net.sendRaw(b.peerId, h.peerId, request.data)
  await settle(100)
  assert.ok(a.conf.get(ref)!.participants.includes(infoB.key))
  const snapshot = JSON.stringify(a.conf.get(ref))
  const events = a.events.length
  net.sendRaw(h.peerId, a.peerId, departure.data)
  await replayBarrier(h, a, ref)
  assert.equal(JSON.stringify(a.conf.get(ref)), snapshot)
  assert.equal(a.events.length, events + 1)
  h.conf.stop(); a.conf.stop(); b.conf.stop()
})

// Docs: VORTEX_v5.1.md section 6.1
test('a refused joiner learns nothing: no descriptor and an empty roster', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  await assert.rejects(a.conf.join({ session: 'sa', ref: freshRef(), host: h.peerId, addrs: h.addrs }),
    /join refused: unknown/)
  await settle()
  const replies = net.sent.filter(s => s.from === h.peerId)
  assert.equal(replies.length, 1)
  const packet = ConferencePacket.decode(replies[0].data.subarray(1))
  assert.equal(packet.reply?.accepted, false)
  assert.equal(packet.reply?.descriptor.length, 0)
  assert.deepEqual(packet.reply?.roster, [])
})

// Docs: VORTEX_v5.1.md section 10.3
test('refusals name the reason and change nothing on the host', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  const snapshot = (): string => JSON.stringify(h.conf.list())
  const eventsBefore = h.events.length
  const unchanged = async (): Promise<void> => {
    await settle()
    assert.equal(h.events.length, eventsBefore, 'no host event')
    assert.equal(JSON.stringify(h.conf.list()), snapshot())
  }
  // Unknown ref.
  await assert.rejects(b.conf.join({ session: 'sb', ref: freshRef(), host: h.peerId, addrs: h.addrs }),
    /join refused: unknown/)
  await unchanged()
  // Full: a second host with capacity 2 holds the host plus A; B is refused.
  const h2 = await makeNode(net, 1_800_000_000_000, { capacity: 2 })
  const ref2 = freshRef()
  h2.formables.set(ref2, formable(ref2, 'sh2'))
  await a.conf.join({ session: 'sa2', ref: ref2, host: h2.peerId, addrs: h2.addrs })
  await assert.rejects(b.conf.join({ session: 'sb', ref: ref2, host: h2.peerId, addrs: h2.addrs }),
    /join refused: full/)
  await settle()
  assert.equal(h2.conf.get(ref2)?.descriptor.participantCount, 2)
  // A second session from a service already inside.
  await assert.rejects(a.conf.join({ session: 'sa-second', ref, host: h.peerId, addrs: h.addrs }),
    /join refused: invalid/)
  await unchanged()
  // A certificate for this service but another conference, replayed at this ref.
  const ask = net.sent.find(s => s.from === a.peerId && s.data[0] === 1)
  assert.ok(ask !== undefined)
  const request = ConferencePacket.decode(ask.data.subarray(1))
  assert.ok(request.join !== undefined)
  // A certificate for another conference, replayed at this ref.
  const lastAsk = net.sent.filter(s => s.from === a.peerId && s.data[0] === 1).at(-1)
  assert.ok(lastAsk !== undefined)
  const lastRequest = ConferencePacket.decode(lastAsk.data.subarray(1))
  assert.ok(lastRequest.join !== undefined)
  const rebased = frame({ join: { conferenceRef: unhex(ref), cert: lastRequest.join.cert } })
  net.sendRaw(a.peerId, h.peerId, rebased)
  await settle()
  await unchanged()
  // A certificate whose service is not the sender.
  net.sendRaw(b.peerId, h.peerId, ask.data)
  await settle()
  await unchanged()
  // A certificate older than ten minutes, from a node with a skewed clock.
  const d = await makeNode(net, 1_800_000_000_000 - 700000)
  await assert.rejects(d.conf.join({ session: 'sd', ref, host: h.peerId, addrs: h.addrs }),
    /join refused: invalid/)
  await unchanged()
  // Forming past maxHosted.
  const h3 = await makeNode(net, 1_800_000_000_000, { maxHosted: 1 })
  const refA = freshRef()
  h3.formables.set(refA, formable(refA, 'sh3'))
  await a.conf.join({ session: 'sa3', ref: refA, host: h3.peerId, addrs: h3.addrs })
  const refB = freshRef()
  h3.formables.set(refB, formable(refB, 'sh3'))
  await assert.rejects(b.conf.join({ session: 'sb3', ref: refB, host: h3.peerId, addrs: h3.addrs }),
    /join refused: full/)
  await settle()
  assert.equal(h3.conf.list().length, 1)
})

// Docs: VORTEX_v5.1.md section 10.7
test('forged posts are dropped by the host and reach nobody', async () => {
  const { createSession, createMessage } = await import('./conference-records.ts')
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const stranger = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  const messages = (): number => h.events.filter(e => e.kind === 'message').length +
    a.events.filter(e => e.kind === 'message').length + b.events.filter(e => e.kind === 'message').length
  const forwards = (): number => net.sent.filter(s => s.from === h.peerId && s.data[0] === 1 &&
    ConferencePacket.decode(s.data.subarray(1)).post !== undefined).length
  const rogue = await createSession()
  const rogueFor = async (conferenceId: string): Promise<Uint8Array> =>
    (await createMessage({ conferenceId, session: rogue, type: 'text',
      content: new TextEncoder().encode('rogue'), now: h.clock.now })).bytes
  // A message signed by a key not in the roster, from a peer that never joined.
  net.sendRaw(stranger.peerId, h.peerId, frame({ post: { conferenceId: unhex(ref), message: await rogueFor(ref) } }))
  await settle()
  assert.equal(messages(), 0)
  assert.equal(forwards(), 0)
  // A message for a conference nobody hosts.
  const nowhere = freshRef()
  net.sendRaw(stranger.peerId, h.peerId, frame({ post: { conferenceId: unhex(nowhere), message: await rogueFor(nowhere) } }))
  await settle()
  assert.equal(messages(), 0)
  // One legitimate post, then a roster member's bytes replayed by another service.
  await a.conf.post(ref, 'sa', { type: 'text', content: new TextEncoder().encode('real') })
  await settle()
  assert.equal(messages(), 2)
  const legit = net.sent.find(s => s.from === a.peerId && s.data[0] === 1)
  assert.ok(legit !== undefined)
  const forwarded = forwards()
  net.sendRaw(b.peerId, h.peerId, legit.data)
  await settle()
  assert.equal(messages(), 2)
  assert.equal(forwards(), forwarded)
  // A duplicate of a message already delivered.
  net.sendRaw(a.peerId, h.peerId, legit.data)
  await settle()
  assert.equal(messages(), 2)
  assert.equal(h.events.filter(e => e.kind === 'message').length, 1)
})

// Docs: VORTEX_v5.1.md section 7.3
test('a participant drops conference packets that do not come from the host', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const c = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  await c.conf.join({ session: 'sc', ref, host: h.peerId, addrs: h.addrs })
  await settle()
  const before = b.events.length
  // A valid arrival, replayed to A from B instead of H.
  const arrivalBytes = net.sent.filter(s => s.from === h.peerId && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1))).find(p => p.arrival !== undefined)
  assert.ok(arrivalBytes?.arrival !== undefined)
  const eventsBefore = a.events.length
  const rosterBefore = JSON.stringify(a.conf.get(ref)?.participants)
  net.sendRaw(b.peerId, a.peerId, frame({ arrival: arrivalBytes.arrival }))
  await settle()
  assert.equal(a.events.length, eventsBefore)
  assert.equal(JSON.stringify(a.conf.get(ref)?.participants), rosterBefore)
  // A real departure, then its replay from a non-host.
  await c.conf.leave(ref, 'sc')
  await settle()
  const departureBytes = net.sent.filter(s => s.from === h.peerId && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1))).find(p => p.departure !== undefined)
  assert.ok(departureBytes?.departure !== undefined)
  const eventsAfterLeave = a.events.length
  net.sendRaw(b.peerId, a.peerId, frame({ departure: departureBytes.departure }))
  await settle()
  assert.equal(a.events.length, eventsAfterLeave)
  // A valid forward, replayed to B from A instead of H.
  await a.conf.post(ref, 'sa', { type: 'text', content: new TextEncoder().encode('x') })
  await settle()
  const forwardBytes = net.sent.filter(s => s.from === h.peerId && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1))).find(p => p.post !== undefined)
  assert.ok(forwardBytes?.post !== undefined)
  const messagesBefore = b.events.filter(e => e.kind === 'message').length
  net.sendRaw(a.peerId, b.peerId, frame({ post: forwardBytes.post }))
  await settle()
  assert.equal(b.events.filter(e => e.kind === 'message').length, messagesBefore)
  // A forged close from a non-host changes nothing.
  net.sendRaw(b.peerId, a.peerId, frame({ close: { conferenceId: unhex(ref) } }))
  await settle()
  assert.ok(a.conf.get(ref) !== undefined)
  assert.ok(!a.events.some(e => e.kind === 'closed'))
})

// Docs: VORTEX_v5.1.md section 10.3
test('a joiner rejects a bad reply and takes back its announcement', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const x = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  // One honest join first: its reply bytes are reused below.
  await a.conf.join({ session: 'sa0', ref, host: h.peerId, addrs: h.addrs })
  // X joins honestly so a third certificate exists.
  await x.conf.join({ session: 'sx', ref, host: h.peerId, addrs: h.addrs })
  const honest = JSON.stringify(a.conf.get(ref))
  const genuine = net.sent.filter(s => s.from === h.peerId && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1))).find(p => p.reply?.accepted === true)
  assert.ok(genuine?.reply !== undefined)
  const [hostCert, joinerCert] = genuine.reply.roster
  const xCert = net.sent.filter(s => s.from === x.peerId && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1))).find(p => p.join !== undefined)?.join?.cert
  assert.ok(xCert !== undefined)
  // Hold the host's outbound replies so each forged reply lands first.
  const origSend = h.transport.send.bind(h.transport)
  const held: Array<{ peer: PeerId, data: Uint8Array }> = []
  h.transport.send = (async (peer: PeerId, data: Uint8Array, addrs?: string[]): Promise<void> => {
    if (data[0] === 1) { held.push({ peer, data }); return }
    return origSend(peer, data, addrs)
  }) as typeof h.transport.send
  const stranger = await makeNode(net)
  const strangerDesc = async (): Promise<Uint8Array> => {
    const inner = WireDescriptor.encode({ conferenceId: unhex(ref), namespace: unhex(profile.id),
      profileVersion: profile.version, topicVector: encodeVector(vector), host: h.peerId,
      contact: encodeContact([h.addrs[0]]), participantCount: 2, capacity: 10,
      admission: Admission.OPEN, revision: 1n, createdAt: BigInt(h.clock.now), expiresAt: BigInt(h.clock.now + 3600000) })
    return SignedDescriptor.encode({ descriptor: inner,
      signature: await stranger.transport.sign(joinedBytes(DESCRIPTOR_PREFIX, inner)) })
  }
  const leaves = (): number => net.sent.filter(s => s.from === a.peerId && s.data[0] === 1 &&
    ConferencePacket.decode(s.data.subarray(1)).leave !== undefined).length
  const cases: Array<{ name: string, descriptor: Uint8Array, roster: Uint8Array[] }> = [
    { name: 'stranger descriptor', descriptor: await strangerDesc(), roster: genuine.reply.roster },
    { name: 'roster not led by host', descriptor: genuine.reply.descriptor, roster: [joinerCert, hostCert] },
    { name: 'roster missing joiner', descriptor: genuine.reply.descriptor, roster: [hostCert] },
    { name: 'roster duplicate key', descriptor: genuine.reply.descriptor, roster: [hostCert, hostCert] },
    { name: 'roster size not count', descriptor: genuine.reply.descriptor, roster: [hostCert, joinerCert, xCert] }
  ]
  for (const [index, forged] of cases.entries()) {
    const joining = a.conf.join({ session: `sa-bad-${index}`, ref, host: h.peerId, addrs: h.addrs })
    await settle()
    const leavesBefore = leaves()
    net.sendRaw(h.peerId, a.peerId, frame({ reply: { conferenceRef: unhex(ref), accepted: true,
      reason: '', descriptor: forged.descriptor, roster: forged.roster } }))
    await assert.rejects(joining, /join refused: invalid/, forged.name)
    await settle()
    assert.equal(leaves(), leavesBefore + 1, `leave sent for ${forged.name}`)
    assert.equal(JSON.stringify(a.conf.get(ref)), honest, `nothing stored for ${forged.name}`)
  }
  h.transport.send = origSend
  for (const heldReply of held) net.sendRaw(h.peerId, heldReply.peer, heldReply.data)
  await settle()
  assert.equal(JSON.stringify(a.conf.get(ref)), honest)
})
