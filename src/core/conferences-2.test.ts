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

// Docs: VORTEX_v5.1.md section 6.4
test('leaving removes one side and the rest keep talking', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  const infoA = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  assert.equal(await a.conf.leave(ref, 'sa'), true)
  await settle()
  const depH = h.events.filter(e => e.kind === 'departure')
  assert.equal(depH.length, 1)
  assert.ok(depH[0].kind === 'departure')
  if (depH[0].kind === 'departure') {
    assert.equal(depH[0].participant, infoA.key)
    assert.equal(depH[0].count, 2)
  }
  assert.equal(b.events.filter(e => e.kind === 'departure').length, 1)
  const closedA = a.events.filter(e => e.kind === 'closed')
  assert.equal(closedA.length, 1)
  assert.ok(closedA[0].kind === 'closed' && closedA[0].reason === 'left')
  // A later post from B reaches H only; A's own post is refused.
  const hMessages = h.events.filter(e => e.kind === 'message').length
  await b.conf.post(ref, 'sb', { type: 'text', content: new TextEncoder().encode('still here') })
  await settle()
  assert.equal(h.events.filter(e => e.kind === 'message').length, hMessages + 1)
  assert.equal(a.events.filter(e => e.kind === 'message').length, 0)
  await assert.rejects(a.conf.post(ref, 'sa', { type: 'text', content: new TextEncoder().encode('x') }),
    /not in this conference/)
  // A can join again with a fresh key.
  const infoA2 = await a.conf.join({ session: 'sa-again', ref, host: h.peerId, addrs: h.addrs })
  assert.notEqual(infoA2.key, infoA.key)
  assert.equal(infoA2.participants.length, 3)
})

// Docs: VORTEX_v5.1.md section 6.4
test('the host leaving closes the conference for everyone', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  await b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs })
  assert.equal(await h.conf.leave(ref, 'sh'), true)
  await settle()
  for (const node of [a, b]) {
    const closed = node.events.filter(e => e.kind === 'closed')
    assert.equal(closed.length, 1)
    assert.ok(closed[0].kind === 'closed' && closed[0].reason === 'host_closed')
    assert.equal(node.conf.get(ref), undefined)
  }
  assert.equal(h.conf.get(ref), undefined)
  const c = await makeNode(net)
  await assert.rejects(c.conf.join({ session: 'sc', ref, host: h.peerId, addrs: h.addrs }),
    /join refused: closed/)
  await settle()
})

// Docs: VORTEX_v5.1.md section 6.2
test('crossing joins converge on the lower id in either delivery order', async () => {
  for (const first of ['x', 'y'] as const) {
    const net = createNetwork()
    const x = await makeNode(net)
    const y = await makeNode(net)
    const xref = freshRef()
    const yref = freshRef()
    // freshRef increases, so xref is the lower id and must win.
    assert.ok(xref < yref)
    x.formables.set(xref, formable(xref, 'sx'))
    y.formables.set(yref, formable(yref, 'sy'))
    // Hold both join requests so each side is pending when the other asks.
    const held: Array<{ from: PeerId, peer: PeerId, data: Uint8Array }> = []
    const hold = (node: Node): void => {
      const orig = node.transport.send.bind(node.transport)
      node.transport.send = (async (peer: PeerId, data: Uint8Array, addrs?: string[]): Promise<void> => {
        if (data[0] === 1) {
          const body = ConferencePacket.decode(data.subarray(1))
          if (body.join !== undefined) { held.push({ from: node.peerId, peer, data }); return }
        }
        return orig(peer, data, addrs)
      }) as typeof node.transport.send
    }
    hold(x)
    hold(y)
    const jx = x.conf.join({ session: 'sx', ref: yref, host: y.peerId, addrs: y.addrs, ownInterest: xref })
    const jy = y.conf.join({ session: 'sy', ref: xref, host: x.peerId, addrs: x.addrs, ownInterest: yref })
    const sx = jx.then(
      value => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }))
    const sy = jy.then(
      value => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }))
    await settle()
    const release = (from: PeerId): void => {
      const at = held.findIndex(h => h.from === from)
      assert.ok(at >= 0, `held join from ${from}`)
      const [one] = held.splice(at, 1)
      net.sendRaw(one.from, one.peer, one.data)
    }
    if (first === 'x') {
      release(x.peerId)
      await settle()
      release(y.peerId)
    } else {
      release(y.peerId)
      await settle()
      release(x.peerId)
    }
    const [rx, ry] = await Promise.all([sx, sy])
    // Exactly one join wins a conference; the other rejects crossing or abandoned.
    const won = [rx, ry].filter(r => r.status === 'fulfilled').length
    assert.equal(won, 1, `one winner when ${first} delivers first`)
    for (const r of [rx, ry]) {
      if (r.status === 'rejected') {
        assert.match(String(r.reason),
          /join refused: crossing|join abandoned|join refused: unknown/)
      }
    }
    await settle()
    assert.equal(x.conf.list().length, 1)
    assert.equal(y.conf.list().length, 1)
    assert.equal(x.conf.list()[0].id, xref)
    assert.equal(y.conf.list()[0].id, xref)
    assert.deepEqual(y.conf.list()[0].participants, x.conf.list()[0].participants)
  }
})

// Docs: VORTEX_v5.1.md section 6.4
test('an expired conference closes on touch and refuses joins', async () => {
  const net = createNetwork()
  const h = await makeNode(net, 1_800_000_000_000, { lifetimeMs: 1000 })
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  h.clock.now += 2000
  a.clock.now += 2000
  const closedH = h.events.length
  assert.deepEqual(h.conf.list(), [])
  assert.equal(h.events.length, closedH + 1)
  const lastH = h.events.at(-1)
  assert.ok(lastH !== undefined && lastH.kind === 'closed' && lastH.reason === 'expired')
  const b = await makeNode(net)
  await assert.rejects(b.conf.join({ session: 'sb', ref, host: h.peerId, addrs: h.addrs }),
    /join refused: closed/)
  await settle()
  const closedA = a.events.length
  assert.deepEqual(a.conf.list(), [])
  assert.equal(a.events.length, closedA + 1)
  const lastA = a.events.at(-1)
  assert.ok(lastA !== undefined && lastA.kind === 'closed' && lastA.reason === 'expired')
})

// Docs: VORTEX_v5.1.md section 10.7
test('join caps are local and the seen set stays bounded', { timeout: 120000 }, async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const c = await makeNode(net, 1_800_000_000_000, { maxJoined: 1 })
  const ref1 = freshRef()
  h.formables.set(ref1, formable(ref1, 'sh'))
  await c.conf.join({ session: 's1', ref: ref1, host: h.peerId, addrs: h.addrs })
  const ref2 = freshRef()
  h.formables.set(ref2, formable(ref2, 'sh'))
  const sentBefore = net.sent.filter(s => s.from === c.peerId).length
  await assert.rejects(c.conf.join({ session: 's2', ref: ref2, host: h.peerId, addrs: h.addrs }),
    /too many joined conferences/)
  await settle()
  assert.equal(net.sent.filter(s => s.from === c.peerId).length, sentBefore)
  // Fill the host's seen set past its bound, then replay the first post.
  const a = await makeNode(net)
  await a.conf.join({ session: 'sa', ref: ref1, host: h.peerId, addrs: h.addrs })
  const first = await h.conf.post(ref1, 'sh', { type: 'text', content: new TextEncoder().encode('m0') })
  void first
  for (let i = 1; i < 4097; i++) {
    await h.conf.post(ref1, 'sh', { type: 'text', content: new TextEncoder().encode('m' + i) })
  }
  const delivered = async (): Promise<number> => {
    await settle(30)
    return c.events.filter(e => e.kind === 'message').length
  }
  assert.equal(await delivered(), 4097)
  const firstBytes = net.sent.filter(s => s.from === h.peerId && s.data[0] === 1)
    .map(s => ConferencePacket.decode(s.data.subarray(1))).find(p => p.post !== undefined)
  assert.ok(firstBytes?.post !== undefined)
  const before = c.events.filter(e => e.kind === 'message').length
  net.sendRaw(h.peerId, c.peerId, frame({ post: firstBytes.post }))
  await settle()
  assert.equal(c.events.filter(e => e.kind === 'message').length, before + 1)
})

// Docs: VORTEX_v5.1.md section 9.3
test('stop rejects a pending join and drops late and spanning packets', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  // Hold the host's replies so A's join stays pending.
  const origSend = h.transport.send.bind(h.transport)
  h.transport.send = (async (peer: PeerId, data: Uint8Array, addrs?: string[]): Promise<void> => {
    if (data[0] === 1) return
    return origSend(peer, data, addrs)
  }) as typeof h.transport.send
  // Gate the host's verification so its handler spans a stop and start.
  let releaseVerify: () => void = () => {}
  let enteredVerify = false
  const gate = new Promise<void>(resolve => { releaseVerify = resolve })
  const rawVerify = h.transport.verify.bind(h.transport)
  h.transport.verify = (async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
    enteredVerify = true
    await gate
    return rawVerify(peer, data, sig)
  }) as typeof h.transport.verify
  const joining = a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  const gateEnd = Date.now() + 5000
  while (!enteredVerify) {
    if (Date.now() > gateEnd) throw new Error('host did not reach verification')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  h.conf.stop()
  // A packet delivered while stopped changes nothing.
  const ask = net.sent.find(s => s.data[0] === 1 && s.peer === h.peerId)
  assert.ok(ask !== undefined)
  net.sendRaw(ask.from, h.peerId, ask.data)
  await settle()
  assert.deepEqual(h.events, [])
  assert.deepEqual(h.conf.list(), [])
  h.conf.start()
  releaseVerify()
  await settle()
  // The spanning validation landed nowhere.
  assert.deepEqual(h.conf.list(), [])
  assert.deepEqual(h.events, [])
  h.transport.send = origSend
  assert.equal(a.conf.abandon(ref), true)
  await assert.rejects(joining, /join abandoned/)
})

// Docs: VORTEX_v5.1.md section 10.7
test('empty, foreign and undecodable packets are ignored without throwing', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  const eventsBefore = h.events.length
  const sentBefore = net.sent.filter(s => s.from === h.peerId).length
  net.sendRaw(a.peerId, h.peerId, new Uint8Array(0))
  net.sendRaw(a.peerId, h.peerId, new TextEncoder().encode('{"hello":1}'))
  net.sendRaw(a.peerId, h.peerId, Uint8Array.from([0, 9, 9, 9]))
  net.sendRaw(a.peerId, h.peerId, Uint8Array.from([1, 255, 255, 255]))
  net.sendRaw(a.peerId, h.peerId, frame({ close: { conferenceId: new Uint8Array(8) } }))
  await settle()
  assert.equal(h.events.length, eventsBefore)
  assert.equal(net.sent.filter(s => s.from === h.peerId).length, sentBefore)
  assert.ok(h.conf.get(ref) !== undefined)
})

// Docs: VORTEX_v5.1.md section 7.3
test('a throwing onEvent does not stop delivery to the other participants', async () => {
  const net = createNetwork()
  const hRaw = await net.node()
  const clock = { now: 1_800_000_000_000 }
  const formables = new Map<string, Formable>()
  const hConf = new Conferences({ transport: hRaw,
    profile: namespace => namespace === profile.id ? profile : undefined,
    formable: id => formables.get(id),
    onEvent: () => { throw new Error('boom') },
    now: () => clock.now })
  hConf.start()
  const a = await makeNode(net)
  const b = await makeNode(net)
  const ref = freshRef()
  formables.set(ref, formable(ref, 'sh'))
  await a.conf.join({ session: 'sa', ref, host: hRaw.peerId, addrs: hRaw.info().addrs })
  await b.conf.join({ session: 'sb', ref, host: hRaw.peerId, addrs: hRaw.info().addrs })
  await a.conf.post(ref, 'sa', { type: 'text', content: new TextEncoder().encode('through') })
  await settle()
  assert.equal(b.events.filter(e => e.kind === 'message').length, 1)
  assert.equal(hConf.get(ref)?.descriptor.participantCount, 3)
})

// Docs: VORTEX_v5.1.md sections 6.3 and 10.7
test('simultaneous joins reserve one request before signing starts', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  const first = a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs }).then(
    value => ({ value }), error => ({ error }))
  const second = a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs }).then(
    value => ({ value }), error => ({ error }))
  try {
    await settle(30)
    const requests = net.sent.filter(s => s.from === a.peerId && ConferencePacket.decode(s.data.slice(1)).join)
    assert.equal(requests.length, 1)
    assert.ok('value' in await first)
    const outcome = await second
    assert.ok('error' in outcome)
    assert.match(outcome.error.message, /join already pending/)
  } finally { a.conf.stop(); h.conf.stop() }
})
// Docs: VORTEX_v5.1.md sections 6.3 and 9.3
test('abandon during signing rejects immediately and sends no late join', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  let release: () => void = () => {}
  let entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const sign = a.transport.sign.bind(a.transport)
  a.transport.sign = async data => { entered = true; await gate; return sign(data) }
  const joining = a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs }).catch(error => error)
  try {
    await settle()
    assert.equal(entered, true)
    assert.equal(a.conf.abandon(ref), true)
    assert.match((await joining).message, /join abandoned/)
    release()
    await settle()
    assert.equal(net.sent.filter(s => s.from === a.peerId).length, 0)
    assert.deepEqual(a.conf.list(), [])
    a.transport.sign = sign
    const retried = await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
    assert.equal(retried.id, ref)
  } finally { release(); a.conf.stop(); h.conf.stop() }
})
// Docs: VORTEX_v5.1.md sections 6.3 and 6.4
test('abandon during reply verification never restores membership and removes the host seat', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const ref = freshRef()
  h.formables.set(ref, formable(ref, 'sh'))
  let release: () => void = () => {}
  let entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const verify = a.transport.verify.bind(a.transport)
  a.transport.verify = async (peer, data, sig) => { entered = true; await gate; return verify(peer, data, sig) }
  const joining = a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs }).catch(error => error)
  try {
    await settle(30)
    assert.equal(entered, true)
    assert.equal(a.conf.abandon(ref), true)
    assert.match((await joining).message, /join abandoned/)
    release()
    await settle(30)
    assert.deepEqual(a.conf.list(), [])
    assert.equal(h.conf.get(ref)?.participants.length, 1)
  } finally { release(); a.conf.stop(); h.conf.stop() }
})

// Docs: VORTEX_v5.1.md sections 6.3, 8.1 and 9.1
test('explicit conference handles allow one session to post to either membership', async () => {
  const net = createNetwork()
  const h = await makeNode(net)
  const a = await makeNode(net)
  const refs = [freshRef(), freshRef()]
  for (const ref of refs) {
    h.formables.set(ref, formable(ref, 'sh'))
    await a.conf.join({ session: 'sa', ref, host: h.peerId, addrs: h.addrs })
  }
  try {
    assert.equal(a.conf.list('sa').length, 2)
    for (const ref of refs) {
      await a.conf.post(ref, 'sa', { type: 'text', content: new TextEncoder().encode(ref) })
      await h.conf.post(ref, 'sh', { type: 'text', content: new TextEncoder().encode(ref) })
    }
    await settle()
    assert.equal(h.events.filter(e => e.kind === 'message').length, 2)
    assert.equal(a.events.filter(e => e.kind === 'message').length, 2)
    await assert.rejects(a.conf.post(refs[1], 'other', { type: 'text', content: new Uint8Array([1]) }), /not in this conference/)
  } finally { a.conf.stop(); h.conf.stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1 and 10.6
test('hosted discovery records are detached signed descriptors, excluding joined and expired rooms', async () => {
  const net = createNetwork()
  const host = await makeNode(net, 1_800_000_000_000, { lifetimeMs: 1000 })
  const guest = await makeNode(net)
  const ref = freshRef()
  host.formables.set(ref, formable(ref, 'host'))
  await guest.conf.join({ session: 'guest', ref, host: host.peerId, addrs: host.addrs })
  assert.deepEqual(guest.conf.hostedRecords(), [])
  const records = host.conf.hostedRecords()
  assert.equal(records.length, 1)
  assert.deepEqual(Object.keys(records[0]).sort(), ['bytes', 'descriptor'])
  assert.equal(records[0].descriptor.participantCount, 2)
  assert.equal('roster' in records[0].descriptor, false)
  assert.equal('participants' in records[0].descriptor, false)
  const bytes = records[0].bytes.slice()
  records[0].bytes.fill(0)
  records[0].descriptor.topicVector.fill(0)
  records[0].descriptor.addrs.length = 0
  records[0].descriptor.participantCount = 99
  const fresh = host.conf.hostedRecords()[0]
  assert.deepEqual(fresh.bytes, bytes)
  assert.deepEqual(fresh.descriptor.topicVector, vector)
  assert.deepEqual(fresh.descriptor.addrs, host.addrs)
  assert.equal(fresh.descriptor.participantCount, 2)
  host.clock.now += 1000
  assert.deepEqual(host.conf.hostedRecords(), [])
  assert.equal(host.events.at(-1)?.kind, 'closed')
  host.conf.stop(); guest.conf.stop()
})
