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

const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 3, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
const vector = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0])

async function settle (turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

function unhex (text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

/** One conference packet on the wire: a leading 1 byte plus the encoding. */
function frame (packet: Parameters<typeof ConferencePacket.encode>[0]): Uint8Array {
  const encoded = ConferencePacket.encode(packet)
  const out = new Uint8Array(1 + encoded.length)
  out[0] = 1
  out.set(encoded, 1)
  return out
}

const DESCRIPTOR_PREFIX = new TextEncoder().encode('vortex-descriptor:1\n')

function joinedBytes (first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length)
  out.set(first)
  out.set(second, first.length)
  return out
}

type TestTransport = Transport & { peerId: PeerId }

function createNetwork () {
  let nextPort = 42000
  const nodes: TestTransport[] = []
  const sent: Array<{ from: PeerId, peer: PeerId, data: Uint8Array }> = []

  async function node (): Promise<TestTransport> {
    const key = await generateKeyPair('Ed25519')
    const peerId = peerIdFromPrivateKey(key).toString()
    const port = nextPort++
    const addrs = [`/ip4/127.0.0.1/tcp/${port}/p2p/${peerId}`]
    const directs: Array<(event: DirectEvent) => void> = []
    const n = {
      peerId,
      info: (): TransportInfo => ({ peerId, addrs }),
      start: async (): Promise<TransportInfo> => ({ peerId, addrs }),
      stop: async (): Promise<void> => {},
      dial: async (): Promise<PeerId> => peerId,
      subscribe: async (): Promise<void> => {},
      unsubscribe: async (): Promise<void> => {},
      publish: async (): Promise<{ recipients: number }> => ({ recipients: 0 }),
      send: async (peer: PeerId, data: Uint8Array): Promise<void> => {
        const target = nodes.find(candidate => candidate.peerId === peer)
        if (target === undefined) throw new Error('unknown peer')
        sent.push({ from: peerId, peer, data })
        const handlers = (target as unknown as { __directs: Array<(event: DirectEvent) => void> }).__directs
        for (const handler of [...handlers]) handler({ from: peerId, data })
      },
      onDirect: (handler: (event: DirectEvent) => void): (() => void) => {
        directs.push(handler)
        return () => { directs.splice(directs.indexOf(handler), 1) }
      },
      onPeer: (): (() => void) => () => {},
      sign: async (data: Uint8Array): Promise<Uint8Array> => await key.sign(data),
      verify: async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
        try {
          const publicKey = peerIdFromString(peer).publicKey
          if (publicKey === undefined) return false
          return await publicKey.verify(data, sig)
        } catch {
          return false
        }
      }
    } as TestTransport
    ;(n as unknown as { __directs: Array<(event: DirectEvent) => void> }).__directs = directs
    nodes.push(n as TestTransport)
    return n as TestTransport
  }

  /** Deliver raw bytes to a peer's direct handlers as if from another node. */
  function sendRaw (from: PeerId, peer: PeerId, data: Uint8Array): void {
    const target = nodes.find(candidate => candidate.peerId === peer)
    if (target === undefined) throw new Error('unknown peer')
    sent.push({ from, peer, data })
    const handlers = (target as unknown as { __directs: Array<(event: DirectEvent) => void> }).__directs
    for (const handler of [...handlers]) handler({ from, data })
  }

  return { node, nodes, sent, sendRaw }
}

interface Node {
  transport: TestTransport
  conf: Conferences
  events: ConferenceEvent[]
  clock: { now: number }
  formables: Map<string, Formable>
  peerId: PeerId
  addrs: string[]
}

async function makeNode (net: ReturnType<typeof createNetwork>, now = 1_800_000_000_000,
  opts: { capacity?: number, maxHosted?: number, maxJoined?: number, lifetimeMs?: number, historyLimit?: number, historyBytes?: number } = {}): Promise<Node> {
  const transport = await net.node()
  const events: ConferenceEvent[] = []
  const clock = { now }
  const formables = new Map<string, Formable>()
  const conf = new Conferences({ transport,
    profile: namespace => namespace === profile.id ? profile : undefined,
    formable: id => formables.get(id),
    onEvent: event => { events.push(event) },
    now: () => clock.now, ...opts })
  conf.start()
  return { transport, conf, events, clock, formables, peerId: transport.peerId, addrs: transport.info().addrs }
}

let nextRef = 0
function freshRef (): string {
  nextRef++
  return nextRef.toString(16).padStart(32, '0')
}

function formable (id: string, session: string): Formable {
  return { id, session, namespace: profile.id, topicVector: vector }
}

/** A host post queued after a replay proves the participant has finished handling it. */
async function replayBarrier (host: Node, participant: Node, ref: string): Promise<void> {
  const message = await host.conf.post(ref, 'sh', { type: 'text', content: new Uint8Array([1]) })
  const deadline = Date.now() + 2000
  while (!participant.events.some(e => e.kind === 'message' && e.message.id === message.id)) {
    assert.ok(Date.now() < deadline, 'host post reaches participant after replay')
    await settle()
  }
}

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

// Docs: VORTEX_v5.1.md sections 6.1 and 11.5 — host-only topic revision.
const revisedVector = Float32Array.from([0, 1, 0, 0, 0, 1, 0, 0])

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

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — original-query subject retention.
const subjectHex = Array.from(encodeVector(vector), byte => byte.toString(16).padStart(2, '0')).join('')
function querySubject (overrides = {}): { statement: string, vector: string, namespace: string, profileVersion: number } {
  return { statement: 'flood query', vector: subjectHex, namespace: profile.id, profileVersion: 3, ...overrides }
}

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
