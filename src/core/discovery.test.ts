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

const profile = makeProfile({
  model: 'm',
  revision: 'r1',
  weights: 'q4',
  prompt: 'p: ',
  maxTokens: 64,
  truncation: 'tail',
  pooling: 'mean',
  normalization: 'l2',
  dims: [8, 4, 2],
  encoding: 'float32le',
  version: 3,
  tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})

const topic = announceTopic(profile.id)

// Vectors: first two components keep every prefix valid (Section 5.1).
const vBase = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0])
const vExact = Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0])
const v8 = Float32Array.from([1, 0.2, 0, 0, 1, 0.3, 0, 0])
const v4 = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0])
const v2 = Float32Array.from([1, 0.1, 1, 1, 0, 0, 0, 0])
const vFar = Float32Array.from([0, 1, 0, 0, 0, 0, 1, 0])
const vR2 = Float32Array.from([1, 0.3, 0.2, 0.1, 0.5, 1, 0, 0])

const table: Record<string, Float32Array> = {
  base: vBase,
  exact: vExact,
  tier8: v8,
  tier4: v4,
  tier2: v2,
  far: vFar,
  other: vR2,
  first: vBase,
  second: vBase
}

function makeEmbedder (calls?: { count: number }) {
  return {
    profile: () => profile,
    embed: async (text: string): Promise<Float32Array> => {
      if (calls !== undefined) calls.count++
      const found = table[text]
      if (found === undefined) throw new Error(`unknown statement: ${text}`)
      return found
    }
  }
}

function hex (bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function unhex (text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

/** One hand-built direct answer to an interest, for the forged-response cases. */
function directPacket (announcementId: string, record: Uint8Array, tier: number, score: number): Uint8Array {
  const encoded = DiscoveryPacket.encode({ results: [{ announcementId: unhex(announcementId), record, tier, score }] })
  const packet = new Uint8Array(1 + encoded.length)
  packet[0] = 0
  packet.set(encoded, 1)
  return packet
}

async function settle (turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function sleep (ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

type TestTransport = Transport & {
  verdicts: GossipVerdict[]
  sent: Array<{ peer: PeerId, data: Uint8Array }>
  directs: DirectEvent[]
  peerId: PeerId
  failPublish: boolean
}

function createNetwork () {
  let nextPort = 41000
  let msgId = 0
  const subs = new Map<string, Array<{ node: TestTransport, handler: GossipHandler }>>()
  const nodes: TestTransport[] = []
  const publishes: Array<{ topic: string, data: Uint8Array, from: PeerId }> = []

  async function node (): Promise<TestTransport> {
    const key = await generateKeyPair('Ed25519')
    const peerId = peerIdFromPrivateKey(key).toString()
    const port = nextPort++
    const addrs = [`/ip4/127.0.0.1/tcp/${port}/p2p/${peerId}`]
    const directHandlers: Array<(event: DirectEvent) => void> = []
    const ownedTopics = new Set<string>()
    const n = {
      verdicts: [] as GossipVerdict[],
      sent: [] as Array<{ peer: PeerId, data: Uint8Array }>,
      directs: [] as DirectEvent[],
      peerId,
      failPublish: false,
      info: (): TransportInfo => ({ peerId, addrs }),
      start: async (): Promise<TransportInfo> => ({ peerId, addrs }),
      stop: async (): Promise<void> => {},
      dial: async (addr: string): Promise<PeerId> => {
        const id = addr.slice(addr.lastIndexOf('/p2p/') + 5)
        const found = nodes.find(candidate => candidate.peerId === id)
        if (found === undefined) throw new Error('unknown peer')
        return found.peerId
      },
      subscribe: async (t: string, handler: GossipHandler): Promise<void> => {
        const list = subs.get(t) ?? []
        list.push({ node: n as TestTransport, handler })
        subs.set(t, list)
        ownedTopics.add(t)
      },
      unsubscribe: async (t: string): Promise<void> => {
        subs.set(t, (subs.get(t) ?? []).filter(entry => entry.node !== (n as TestTransport)))
        ownedTopics.delete(t)
      },
      publish: async (t: string, data: Uint8Array): Promise<{ recipients: number }> => {
        if ((n as TestTransport).failPublish) throw new Error('publish failed')
        publishes.push({ topic: t, data, from: peerId })
        const list = [...(subs.get(t) ?? [])]
        for (const entry of list) {
          const event: GossipEvent = { topic: t, id: `m${msgId++}`, origin: peerId, relayedBy: peerId, data }
          const verdict = await entry.handler(event)
          entry.node.verdicts.push(verdict)
        }
        return { recipients: list.length }
      },
      send: async (peer: PeerId, data: Uint8Array): Promise<void> => {
        const target = nodes.find(candidate => candidate.peerId === peer)
        if (target === undefined) throw new Error('unknown peer')
        ;(n as TestTransport).sent.push({ peer, data })
        const event: DirectEvent = { from: peerId, data }
        target.directs.push(event)
        for (const handler of directHandlersOf(target)) handler(event)
      },
      onDirect: (handler: (event: DirectEvent) => void): (() => void) => {
        directHandlers.push(handler)
        return () => {
          const at = directHandlers.indexOf(handler)
          if (at >= 0) directHandlers.splice(at, 1)
        }
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
    const directHandlersOf = (target: TestTransport): Array<(event: DirectEvent) => void> => {
      // Reach into the closure of the target node via its own registry.
      return (target as unknown as { __handlers?: Array<(event: DirectEvent) => void> }).__handlers ?? []
    }
    // Store handlers on the object so other nodes can deliver to them.
    ;(n as unknown as { __handlers: Array<(event: DirectEvent) => void> }).__handlers = directHandlers
    nodes.push(n as TestTransport)
    // Patch send above to use the shared lookup: it already closes over nodes.
    return n as TestTransport
  }

  function handlersOf (target: TestTransport): Array<(event: DirectEvent) => void> {
    return (target as unknown as { __handlers: Array<(event: DirectEvent) => void> }).__handlers
  }

  async function inject (origin: PeerId, t: string, data: Uint8Array): Promise<void> {
    const list = [...(subs.get(t) ?? [])]
    for (const entry of list) {
      const event: GossipEvent = { topic: t, id: `m${msgId++}`, origin, relayedBy: origin, data }
      const verdict = await entry.handler(event)
      entry.node.verdicts.push(verdict)
    }
  }

  return { node, inject, publishes, nodes, handlersOf }
}

async function verify (peer: PeerId, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const publicKey = peerIdFromString(peer).publicKey
  if (publicKey === undefined) return false
  return await publicKey.verify(data, signature)
}

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('late joiner is matched in one direction only', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const matchesA: unknown[] = []
  const matchesB: Array<{ interest: string, peer: PeerId, tier: { tier: unknown }, addrs: string[], record: { id: string } }> = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: (m) => { matchesA.push(m) } })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { matchesB.push(m as never) } })
  await da.start()
  await db.start()
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  assert.equal(matchesA.length, 0)
  assert.equal(matchesB.length, 0)
  const idB = await db.announce({ session: 'b', statement: 'exact' })
  await settle()
  assert.equal(matchesB.length, 1)
  assert.equal(matchesB[0].interest, idB)
  assert.equal(matchesB[0].peer, ta.info().peerId)
  assert.equal((matchesB[0].tier as { tier: string }).tier, 'exact')
  assert.deepEqual(matchesB[0].addrs, ta.info().addrs)
  assert.equal(matchesB[0].record.id, idA)
  assert.equal(matchesA.length, 0)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.2 and 5.3
test('tiers order exact before 8 before 4 with recomputed tiers', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: Array<{ tier: { tier: unknown } }> = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'exact' })
  await da.announce({ session: 'a', statement: 'tier8' })
  await da.announce({ session: 'a', statement: 'tier4' })
  await settle()
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  const kept = db.matches(idB)
  assert.equal(kept.length, 3)
  assert.deepEqual(kept.map(m => m.tier.tier), ['exact', 8, 4])
  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map(m => (m.tier as { tier: unknown }).tier).sort(), [4, 8, 'exact'].sort())
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.2 and 11.2
test('unrelated statements produce no direct packet and no match', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  await db.announce({ session: 'b', statement: 'far' })
  await settle()
  assert.equal(hits, 0)
  assert.equal(ta.directs.length, 0)
  assert.equal(tb.directs.length, 0)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 4.2 and 10.2
test('the statement stays local unless publishStatement is set', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  await d.start()
  const before = net.publishes.length
  const idHidden = await d.announce({ session: 's', statement: 'base' })
  const first = net.publishes[before]
  const openedHidden = await openAnnouncement(first.data, { profile: ns => ns === profile.id ? profile : undefined, verify, now: Date.now() })
  assert.equal(openedHidden.statement, undefined)
  const idShown = await d.announce({ session: 's', statement: 'tier8', publishStatement: true })
  const second = net.publishes[before + 1]
  const openedShown = await openAnnouncement(second.data, { profile: ns => ns === profile.id ? profile : undefined, verify, now: Date.now() })
  assert.equal(openedShown.statement, 'tier8')
  const local = new Map(d.interests().map(i => [i.id, i.statement]))
  assert.equal(local.get(idHidden), 'base')
  assert.equal(local.get(idShown), 'tier8')
  await d.stop()
})

// Docs: VORTEX_v5.1.md sections 10.2 and 11.2
test('checkOutbound throwing stops everything', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const calls = { count: 0 }
  const d = new Discovery({
    transport: ta,
    embedder: makeEmbedder(calls),
    onMatch: () => {},
    checkOutbound: () => { throw new Error('denied') }
  })
  await d.start()
  const published = net.publishes.length
  await assert.rejects(d.announce({ session: 's', statement: 'base' }), /denied/)
  assert.equal(calls.count, 0)
  assert.equal(d.interests().length, 0)
  assert.equal(net.publishes.length, published)
  await d.stop()
})

// Docs: VORTEX_v5.1.md section 11.2
test('a failing publish removes the interest again', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  await d.start()
  ta.failPublish = true
  await assert.rejects(d.announce({ session: 's', statement: 'base' }), /publish failed/)
  assert.equal(d.interests().length, 0)
  // A failed revision changes nothing either: the interest it would have replaced is still held.
  ta.failPublish = false
  const kept = await d.announce({ session: 's', statement: 'base' })
  ta.failPublish = true
  await assert.rejects(d.announce({ session: 's', statement: 'exact', replaces: kept }), /publish failed/)
  assert.deepEqual(d.interests().map(interest => interest.id), [kept])
  ta.failPublish = false
  await d.stop()
})

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('replaces drops the old interest and its matches', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const oldId = await db.announce({ session: 's', statement: 'base' })
  await settle()
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  // db answered da, so da holds a match; give db one too by announcing from da first is enough.
  // Now replace db's interest and check the old one and its matches are gone.
  const before = db.matches(oldId)
  assert.ok(Array.isArray(before))
  const newId = await db.announce({ session: 's', statement: 'tier8', replaces: oldId })
  assert.equal(db.matches(oldId).length, 0)
  assert.notEqual(newId, oldId)
  assert.ok(db.interests().some(i => i.id === newId))
  assert.equal(db.interests().some(i => i.id === oldId), false)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 10.7
test('validator verdicts reject bad mail and answer once', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const baseCount = () => tb.sent.length

  await net.inject(ta.info().peerId, topic, Uint8Array.from([1, 2, 3]))
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'reject')

  const foreign = makeProfile({
    model: 'other', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
    truncation: 'tail', pooling: 'mean', normalization: 'l2',
    dims: [8, 4, 2], encoding: 'float32le', version: 1, tolerance: 0.001, thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
  })
  const { createAnnouncement } = await import('./announcement.ts')
  const contact = Contact.encode({ addrs: ta.info().addrs })
  const made = await createAnnouncement({
    profile: foreign, vector: vBase, origin: ta.info().peerId, contact, ttl: 60,
    sign: data => ta.sign(data), now: Date.now()
  })
  await net.inject(ta.info().peerId, topic, made.bytes)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'ignore')

  const expired = await createAnnouncement({
    profile, vector: vBase, origin: ta.info().peerId, contact, ttl: 60,
    sign: data => ta.sign(data), now: Date.now() - 120000
  })
  await net.inject(ta.info().peerId, topic, expired.bytes)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'ignore')

  // Valid announcement but a different publisher than its origin.
  await db.announce({ session: 'b', statement: 'base' })
  await settle()
  const published = net.publishes[net.publishes.length - 1]
  await net.inject(ta.info().peerId, topic, published.data)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'reject')

  // Contact address not ending in the origin.
  const badContact = Contact.encode({ addrs: ['/ip4/1.2.3.4/tcp/1/p2p/12D3KooWother'] })
  const bad = await createAnnouncement({
    profile, vector: vBase, origin: ta.info().peerId, contact: badContact, ttl: 60,
    sign: data => ta.sign(data), now: Date.now()
  })
  await net.inject(ta.info().peerId, topic, bad.bytes)
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'reject')

  // Repeated announcement is ignored and answered only once.
  const dc = new Discovery({ transport: await net.node(), embedder: makeEmbedder(), onMatch: () => {} })
  // Use fresh nodes for a clean count: responder holds one interest.
  const tR = await net.node()
  const tO = await net.node()
  const dR = new Discovery({ transport: tR, embedder: makeEmbedder(), onMatch: () => {} })
  const dO = new Discovery({ transport: tO, embedder: makeEmbedder(), onMatch: () => {} })
  await dR.start()
  await dO.start()
  await dR.announce({ session: 'r', statement: 'base' })
  await settle()
  const sentBefore = tR.sent.length
  const idO = await dO.announce({ session: 'o', statement: 'exact' })
  await settle()
  assert.equal(tR.sent.length, sentBefore + 1)
  void baseCount
  void idO
  void dc
  // Replay the same bytes as the same origin: seen, so ignored with no new answer.
  const lastPublish = net.publishes[net.publishes.length - 1]
  const verdictsBefore = tR.verdicts.length
  await net.inject(tO.info().peerId, topic, lastPublish.data)
  await settle()
  assert.equal(tR.verdicts[tR.verdicts.length - 1], 'ignore')
  assert.ok(tR.verdicts.length > verdictsBefore)
  assert.equal(tR.sent.length, sentBefore + 1)
  await da.stop()
  await db.stop()
  await dR.stop()
  await dO.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 10.7
test('rate limit ignores the third announcement and recovers after a minute', async () => {
  const net = createNetwork()
  const clock = { now: Date.now() }
  const ta = await net.node()
  const tb = await net.node()
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  const db = new Discovery({
    transport: tb, embedder: makeEmbedder(), onMatch: () => {},
    now: () => clock.now, announcementsPerOriginPerMinute: 2
  })
  await da.start()
  await db.start()
  // B holds no interests; verdicts still show accept/ignore without responses.
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  await da.announce({ session: 'a', statement: 'tier8' })
  await settle()
  const verdicts = tb.verdicts.slice(-2)
  assert.deepEqual(verdicts, ['accept', 'accept'])
  const sentBefore = ta.sent.length + tb.sent.length
  await da.announce({ session: 'a', statement: 'tier4' })
  await settle()
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'ignore')
  assert.equal(ta.sent.length + tb.sent.length, sentBefore)
  clock.now += 61000
  await da.announce({ session: 'a', statement: 'tier2' })
  await settle()
  assert.equal(tb.verdicts[tb.verdicts.length - 1], 'accept')
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 10.6 and 11.2
test('a lying responder with a false tier and score gets no match', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  // B holds an unrelated interest; answer A's interest with it while claiming exact.
  await db.announce({ session: 'b', statement: 'far' })
  await settle()
  const record = db.interests()[0].bytes
  const packet = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }]
  }).length)
  packet[0] = 0
  packet.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }] }), 1)
  await tb.send(ta.info().peerId, packet, ta.info().addrs)
  await settle()
  assert.equal(hits, 0)
  assert.equal(da.matches(idA).length, 0)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 10.6 and 11.2
test('a record signed by a third node is not matched', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tc = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  const dc = new Discovery({ transport: tc, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await dc.start()
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  await dc.announce({ session: 'c', statement: 'exact' })
  await settle()
  const record = dc.interests()[0].bytes
  const packet = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }]
  }).length)
  packet[0] = 0
  packet.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idA), record, tier: 0, score: 1 }] }), 1)
  // B forwards C's record as if it were its own.
  await tb.send(ta.info().peerId, packet, ta.info().addrs)
  await settle()
  assert.equal(hits, 0)
  assert.equal(da.matches(idA).length, 0)
  await da.stop()
  await db.stop()
  await dc.stop()
})

// Docs: VORTEX_v5.1.md sections 10.5 and 11.2
test('bad packets and results for gone interests are ignored', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  const sendRaw = async (data: Uint8Array): Promise<void> => {
    await tb.send(ta.info().peerId, data, ta.info().addrs)
    await settle()
  }
  // Unknown interest.
  const { createAnnouncement } = await import('./announcement.ts')
  const contactB = Contact.encode({ addrs: tb.info().addrs })
  const rec = await createAnnouncement({
    profile, vector: vExact, origin: tb.info().peerId, contact: contactB, ttl: 60,
    sign: data => tb.sign(data), now: Date.now()
  })
  const unknown = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: new Uint8Array(16).fill(9), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  unknown[0] = 0
  unknown.set(DiscoveryPacket.encode({ results: [{ announcementId: new Uint8Array(16).fill(9), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await sendRaw(unknown)
  // Withdrawn interest.
  const idA = await da.announce({ session: 'a', statement: 'base' })
  await settle()
  assert.equal(da.withdraw('a', idA), true)
  const gone = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idA), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  gone[0] = 0
  gone.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idA), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await sendRaw(gone)
  // Expired interest: short ttl with a moving clock.
  const clock = { now: Date.now() }
  const tE = await net.node()
  const dE = new Discovery({ transport: tE, embedder: makeEmbedder(), onMatch: () => { hits++ }, now: () => clock.now })
  await dE.start()
  const idE = await dE.announce({ session: 'e', statement: 'base', ttl: 1 })
  clock.now += 2000
  const late = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(idE), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  late[0] = 0
  late.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(idE), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await tb.send(tE.info().peerId, late, tE.info().addrs)
  await settle()
  // Malformed packets: empty, wrong lead byte, undecodable, too many results.
  await sendRaw(new Uint8Array(0))
  await sendRaw(new TextEncoder().encode('{"hello":1}'))
  await sendRaw(Uint8Array.from([0, 255, 255, 255]))
  const many = Array.from({ length: 4 }, () => ({ announcementId: unhex(idA), record: rec.bytes, tier: 0, score: 1 }))
  const tooMany = new Uint8Array(1 + DiscoveryPacket.encode({ results: many }).length)
  tooMany[0] = 0
  tooMany.set(DiscoveryPacket.encode({ results: many }), 1)
  await sendRaw(tooMany)
  assert.equal(hits, 0)
  await da.stop()
  await db.stop()
  await dE.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('caps keep the best and bound one peer', async () => {
  const net = createNetwork()
  const tO = await net.node()
  const t1 = await net.node()
  const t2 = await net.node()
  const t3 = await net.node()
  const seen: Array<{ peer: PeerId }> = []
  const dO = new Discovery({ matchWindowMs: 0,
    transport: tO, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m as never) },
    maxMatchesPerInterest: 2
  })
  const d1 = new Discovery({ matchWindowMs: 0,  transport: t1, embedder: makeEmbedder(), onMatch: () => {} })
  const d2 = new Discovery({ matchWindowMs: 0,  transport: t2, embedder: makeEmbedder(), onMatch: () => {} })
  const d3 = new Discovery({ matchWindowMs: 0,  transport: t3, embedder: makeEmbedder(), onMatch: () => {} })
  await dO.start()
  await d1.start()
  await d2.start()
  await d3.start()
  // Three responders at different tiers for one interest.
  await d1.announce({ session: 'r', statement: 'exact' })
  await d2.announce({ session: 'r', statement: 'tier8' })
  await d3.announce({ session: 'r', statement: 'tier4' })
  await settle()
  const idO = await dO.announce({ session: 'o', statement: 'base' })
  await settle()
  const kept = dO.matches(idO)
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map(m => m.tier.tier), ['exact', 8])
  assert.equal(seen.length, 2)
  // One peer cannot exceed maxResultsPerAnnouncement kept matches for one interest.
  const tS = await net.node()
  const dS = new Discovery({ matchWindowMs: 0,  transport: tS, embedder: makeEmbedder(), onMatch: () => {}, maxResultsPerAnnouncement: 1 })
  await dS.start()
  await dS.announce({ session: 's', statement: 'exact' })
  await dS.announce({ session: 's', statement: 'tier8' })
  await settle()
  const tT = await net.node()
  const dT = new Discovery({ matchWindowMs: 0,  transport: tT, embedder: makeEmbedder(), onMatch: () => {}, maxResultsPerAnnouncement: 1 })
  await dT.start()
  const idT = await dT.announce({ session: 't', statement: 'base' })
  await settle()
  // dS answers with at most one record per announcement, so dT keeps at most one from dS.
  const fromS = dT.matches(idT).filter(m => m.peer === tS.info().peerId)
  assert.ok(fromS.length <= 1)
  await dO.stop()
  await d1.stop()
  await d2.stop()
  await d3.stop()
  await dS.stop()
  await dT.stop()
})

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('the same record twice calls onMatch once', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hits = 0
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: () => {} })
  await da.start()
  await db.start()
  await db.announce({ session: 'b', statement: 'exact' })
  await settle()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  assert.equal(hits, 1)
  // Replay the exact packet the responder sent.
  const replay = tb.sent[tb.sent.length - 1].data
  await tb.send(ta.info().peerId, replay, ta.info().addrs)
  await settle()
  assert.equal(hits, 1)
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
test('a node accepts its own announcement and never matches itself', async () => {
  const net = createNetwork()
  const ta = await net.node()
  let hits = 0
  const d = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => { hits++ } })
  await d.start()
  await d.announce({ session: 's', statement: 'base' })
  await settle()
  const before = ta.sent.length
  const idOwn = await d.announce({ session: 's', statement: 'exact' })
  await settle()
  assert.ok(ta.verdicts.includes('accept'))
  assert.equal(ta.sent.length, before)
  assert.equal(hits, 0)
  assert.equal(d.matches(idOwn).length, 0)
  await d.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 11.2
test('stop leaves later announcements and packets untouched', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  let hitsB = 0
  const da = new Discovery({ transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ transport: tb, embedder: makeEmbedder(), onMatch: () => { hitsB++ } })
  await da.start()
  await db.start()
  const stoppedId = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  await db.stop()
  const verdictsBefore = tb.verdicts.length
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  assert.equal(tb.verdicts.length, verdictsBefore)
  assert.equal(hitsB, 0)
  // A direct packet after stop changes nothing.
  const { createAnnouncement } = await import('./announcement.ts')
  const contactA = Contact.encode({ addrs: ta.info().addrs })
  const rec = await createAnnouncement({
    profile, vector: vExact, origin: ta.info().peerId, contact: contactA, ttl: 60,
    sign: data => ta.sign(data), now: Date.now()
  })
  assert.deepEqual(db.interests(), [])
  const packet = new Uint8Array(1 + DiscoveryPacket.encode({
    results: [{ announcementId: unhex(stoppedId), record: rec.bytes, tier: 0, score: 1 }]
  }).length)
  packet[0] = 0
  packet.set(DiscoveryPacket.encode({ results: [{ announcementId: unhex(stoppedId), record: rec.bytes, tier: 0, score: 1 }] }), 1)
  await ta.send(tb.info().peerId, packet, tb.info().addrs)
  await settle()
  assert.equal(hitsB, 0)
  await da.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('matches sharing a tier order by fullScore, not tier score', async () => {
  const net = createNetwork()
  const tO = await net.node()
  const tA = await net.node()
  const tB = await net.node()
  const dO = new Discovery({ transport: tO, embedder: makeEmbedder(), onMatch: () => {} })
  const dA = new Discovery({ transport: tA, embedder: makeEmbedder(), onMatch: () => {} })
  const dB = new Discovery({ transport: tB, embedder: makeEmbedder(), onMatch: () => {} })
  await dO.start()
  await dA.start()
  await dB.start()
  // A holds tier4 (prefix 1.0, full 0.5); B holds tier4 with lower prefix but higher full.
  await dA.announce({ session: 'a', statement: 'tier4' })
  await dB.announce({ session: 'b', statement: 'other' })
  await settle()
  const idO = await dO.announce({ session: 'o', statement: 'base' })
  await settle()
  const kept = dO.matches(idO)
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map(m => m.tier.tier), [4, 4])
  // B has the lower tier.score but the higher fullScore, so it comes first.
  assert.ok(kept[0].tier.score < kept[1].tier.score)
  assert.ok(kept[0].fullScore > kept[1].fullScore)
  assert.equal(kept[0].peer, tB.info().peerId)
  await dO.stop()
  await dA.stop()
  await dB.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('expired kept matches do not block a fresh match under the interest cap', async () => {
  const net = createNetwork()
  const clock = { now: Date.now() }
  const ta1 = await net.node()
  const tb = await net.node()
  const ta2 = await net.node()
  const seen: PeerId[] = []
  const da1 = new Discovery({ matchWindowMs: 0,  transport: ta1, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.peer) },
    now: () => clock.now, maxMatchesPerInterest: 1
  })
  const da2 = new Discovery({ matchWindowMs: 0,  transport: ta2, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  await da1.start()
  await db.start()
  await da2.start()
  await da1.announce({ session: 'a1', statement: 'exact', ttl: 1 })
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  assert.deepEqual(seen, [ta1.info().peerId])
  // Let the first record expire without reading matches.
  clock.now += 2000
  await da2.announce({ session: 'a2', statement: 'tier8' })
  await settle()
  const record = da2.interests()[0].bytes
  await ta2.send(tb.info().peerId, directPacket(idB, record, 8, 0.95), tb.info().addrs)
  await settle()
  assert.deepEqual(seen, [ta1.info().peerId, ta2.info().peerId])
  assert.deepEqual(db.matches(idB).map(m => m.peer), [ta2.info().peerId])
  await da1.stop()
  await db.stop()
  await da2.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('an expired kept match does not use up its peer slot', async () => {
  const net = createNetwork()
  const clock = { now: Date.now() }
  const ta1 = await net.node()
  const tb = await net.node()
  const seen: string[] = []
  const da1 = new Discovery({ matchWindowMs: 0,  transport: ta1, embedder: makeEmbedder(), onMatch: () => {}, now: () => clock.now })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.record.id) },
    now: () => clock.now, maxResultsPerAnnouncement: 1
  })
  await da1.start()
  await db.start()
  await da1.announce({ session: 'a1', statement: 'exact', ttl: 1 })
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await settle()
  assert.equal(seen.length, 1)
  clock.now += 2000
  await da1.announce({ session: 'a1', statement: 'tier8' })
  await settle()
  const fresh = da1.interests().find(i => i.statement === 'tier8')
  assert.ok(fresh !== undefined)
  await ta1.send(tb.info().peerId, directPacket(idB, fresh.bytes, 8, 0.95), tb.info().addrs)
  await settle()
  assert.equal(seen.length, 2)
  assert.deepEqual(db.matches(idB).map(m => m.record.id), [fresh.id])
  await da1.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test("a peer's better record replaces its weaker one within the peer cap", async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tiers: unknown[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { tiers.push(m.tier.tier) },
    maxResultsPerAnnouncement: 1
  })
  await da.start()
  await db.start()
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await da.announce({ session: 'a', statement: 'tier4' })
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  const byStatement = new Map(da.interests().map(i => [i.statement, i]))
  const broad = byStatement.get('tier4')
  const narrow = byStatement.get('exact')
  assert.ok(broad !== undefined && narrow !== undefined)
  await ta.send(tb.info().peerId, directPacket(idB, broad.bytes, 4, 1), tb.info().addrs)
  await settle()
  await ta.send(tb.info().peerId, directPacket(idB, narrow.bytes, 0, 1), tb.info().addrs)
  await settle()
  assert.deepEqual(tiers, [4, 'exact'])
  assert.deepEqual(db.matches(idB).map(m => m.tier.tier), ['exact'])
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test("a peer's weaker record does not displace its better one", async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const tiers: unknown[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,
    transport: tb, embedder: makeEmbedder(), onMatch: (m) => { tiers.push(m.tier.tier) },
    maxResultsPerAnnouncement: 1
  })
  await da.start()
  await db.start()
  const idB = await db.announce({ session: 'b', statement: 'base' })
  await da.announce({ session: 'a', statement: 'tier4' })
  await da.announce({ session: 'a', statement: 'exact' })
  await settle()
  const byStatement = new Map(da.interests().map(i => [i.statement, i]))
  const broad = byStatement.get('tier4')
  const narrow = byStatement.get('exact')
  assert.ok(broad !== undefined && narrow !== undefined)
  await ta.send(tb.info().peerId, directPacket(idB, narrow.bytes, 0, 1), tb.info().addrs)
  await settle()
  await ta.send(tb.info().peerId, directPacket(idB, broad.bytes, 4, 1), tb.info().addrs)
  await settle()
  assert.deepEqual(tiers, ['exact'])
  assert.deepEqual(db.matches(idB).map(m => m.tier.tier), ['exact'])
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 2.2 and 10.7
test('a validation that spans a stop and start leaves no state behind', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: PeerId[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.peer) } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  // Gate A's verification only from here on, so setup mail is unaffected.
  let releaseGate: () => void = () => {}
  let enteredGate = false
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const rawVerify = ta.verify.bind(ta)
  ta.verify = (async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
    enteredGate = true
    await gate
    return rawVerify(peer, data, sig)
  }) as typeof ta.verify
  const announcing = db.announce({ session: 'b', statement: 'exact' })
  const gateEnd = Date.now() + 5000
  while (!enteredGate) {
    if (Date.now() > gateEnd) throw new Error('validator did not reach the gate')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await da.stop()
  await da.start()
  releaseGate()
  await announcing
  const bytes = net.publishes[net.publishes.length - 1].data
  // The stale validation changed nothing: ignored, unanswered, uncounted.
  assert.equal(ta.verdicts[ta.verdicts.length - 1], 'ignore')
  assert.deepEqual(seen, [])
  // A new run must reopen its interest before it can answer a replay.
  await da.announce({ session: 'a', statement: 'base' })
  await net.inject(tb.info().peerId, topic, bytes)
  await settle()
  assert.equal(ta.verdicts[ta.verdicts.length - 1], 'accept')
  assert.deepEqual(seen, [ta.info().peerId])
  await da.stop()
  await db.stop()
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('a result verified across a stop and start is not kept by the new run', async () => {
  const net = createNetwork()
  const ta = await net.node()
  const tb = await net.node()
  const seen: PeerId[] = []
  const da = new Discovery({ matchWindowMs: 0,  transport: ta, embedder: makeEmbedder(), onMatch: () => {} })
  const db = new Discovery({ matchWindowMs: 0,  transport: tb, embedder: makeEmbedder(), onMatch: (m) => { seen.push(m.peer) } })
  await da.start()
  await db.start()
  await da.announce({ session: 'a', statement: 'base' })
  await settle()
  // Hold B's verification of records signed by A; B's own announcement passes straight through.
  let releaseGate: () => void = () => {}
  let enteredGate = false
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const rawVerify = tb.verify.bind(tb)
  tb.verify = (async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
    if (peer === ta.info().peerId) {
      enteredGate = true
      await gate
    }
    return rawVerify(peer, data, sig)
  }) as typeof tb.verify
  const first = await db.announce({ session: 'b', statement: 'exact' })
  const gateEnd = Date.now() + 5000
  while (!enteredGate) {
    if (Date.now() > gateEnd) throw new Error('result handler did not reach the gate')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  await db.stop()
  await db.start()
  releaseGate()
  await settle()
  // The old run's result and its session interest both ended with that run.
  assert.deepEqual(seen, [])
  assert.deepEqual(db.matches(first), [])
  assert.equal(db.interests().length, 0)
  // The new run collects results as usual.
  const second = await db.announce({ session: 'b', statement: 'exact' })
  await settle()
  assert.deepEqual(seen, [ta.info().peerId])
  assert.equal(db.matches(second).length, 1)
  await da.stop()
  await db.stop()
})

/** A signed host record with no admission credentials or roster. */
async function hostedRecord (host: TestTransport, id = 'ab'.repeat(16), topicVector = vBase, now = Date.now()) {
  return createDescriptor({ id, profile, topicVector, host: host.peerId, addrs: host.info().addrs,
    participantCount: 2, capacity: 8, admission: 'open', createdAt: now, expiresAt: now + 60000,
    sign: data => host.sign(data), now })
}

function resultPacket (results: Parameters<typeof DiscoveryPacket.encode>[0]['results']): Uint8Array {
  const encoded = DiscoveryPacket.encode({ results })
  const packet = new Uint8Array(1 + encoded.length)
  packet.set(encoded, 1)
  return packet
}

// Docs: VORTEX_v5.1.md sections 5.2, 6.1 and 11.2
test('hosted descriptors match on topic, replace their interest, and share ranking and result caps', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  let rooms: Awaited<ReturnType<typeof hostedRecord>>[] = []
  const dh = new Discovery({ matchWindowMs: 0,  transport: th, embedder: makeEmbedder(), onMatch: () => {}, conferences: () => rooms })
  const hits: string[] = []
  const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: m => { hits.push(m.record.id) } })
  await dh.start()
  await origin.start()
  try {
    const held = await dh.announce({ session: 'host', statement: 'base' })
    await dh.announce({ session: 'host', statement: 'tier8' })
    await dh.announce({ session: 'host', statement: 'tier4' })
    rooms = [await hostedRecord(th, held), await hostedRecord(th, 'cd'.repeat(16), vExact),
      await hostedRecord(th, 'ef'.repeat(16), vFar)]
    const id = await origin.announce({ session: 'origin', statement: 'base' })
    await settle()
    const matches = origin.matches(id)
    assert.equal(matches.length, 3)
    assert.equal(matches.filter(m => m.record.id === held).length, 1)
    assert.equal(matches.find(m => m.record.id === held)?.kind, 'conference')
    assert.deepEqual(matches.map(m => m.tier.tier), ['exact', 'exact', 8])
    assert.equal(matches.some(m => m.record.id === 'ef'.repeat(16)), false)
    const wire = DiscoveryPacket.decode(th.sent.at(-1)!.data.slice(1))
    assert.equal(wire.results.length, 3)
    assert.equal(wire.results.filter(r => r.conference.length > 0).length, 2)
    assert.equal(wire.results.every(r => (r.record.length > 0) !== (r.conference.length > 0)), true)
    assert.equal(hits.length, 3)
  } finally { await dh.stop(); await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1, 10.6 and 11.2
test('descriptor payloads round-trip beside legacy interests and ambiguous results leave valid siblings intact', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const origin = new Discovery({ transport: to, embedder: makeEmbedder(), onMatch: () => {} })
  await origin.start()
  try {
    const id = await origin.announce({ session: 'origin', statement: 'base' })
    const room = await hostedRecord(th)
    const { createAnnouncement } = await import('./announcement.ts')
    const interest = await createAnnouncement({ profile, vector: v8, origin: th.peerId,
      contact: Contact.encode({ addrs: th.info().addrs }), ttl: 60, sign: data => th.sign(data) })
    const legacy = DiscoveryPacket.decode(DiscoveryPacket.encode({ results: [{ announcementId: unhex(id), record: interest.bytes, tier: 8, score: 1 }] }))
    assert.deepEqual(legacy.results[0].record, interest.bytes)
    const conf = { announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }
    assert.deepEqual(DiscoveryPacket.decode(DiscoveryPacket.encode({ results: [conf] })).results[0].conference, room.bytes)
    await th.send(to.peerId, resultPacket([
      { ...conf, record: interest.bytes }, { ...conf, conference: new Uint8Array() }, conf
    ]))
    await settle()
    assert.deepEqual(origin.matches(id).map(m => m.kind), ['conference'])
    await th.send(to.peerId, directPacket(id, interest.bytes, 8, 1))
    await settle()
    assert.deepEqual(origin.matches(id).map(m => m.kind), ['conference', 'interest'])
  } finally { await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 5.2, 6.1 and 10.6
test('descriptor verification refuses forged records and recomputes claimed tiers', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const impostor = await net.node()
  const now = Date.now()
  const origin = new Discovery({ transport: to, embedder: makeEmbedder(), onMatch: () => {}, now: () => now })
  await origin.start()
  try {
    const id = await origin.announce({ session: 'o', statement: 'base' })
    const good = await hostedRecord(th, 'ab'.repeat(16), v8, now)
    const signed = SignedDescriptor.decode(good.bytes)
    const wire = WireDescriptor.decode(signed.descriptor)
    const mutate = async (patch: Partial<typeof wire>): Promise<Uint8Array> => {
      const inner = WireDescriptor.encode({ ...wire, ...patch })
      const prefix = new TextEncoder().encode('vortex-descriptor:1\n')
      const data = new Uint8Array(prefix.length + inner.length)
      data.set(prefix); data.set(inner, prefix.length)
      return SignedDescriptor.encode({ descriptor: inner, signature: await th.sign(data) })
    }
    const invalid = [
      SignedDescriptor.encode({ ...signed, signature: new Uint8Array(64) }),
      await mutate({ namespace: new Uint8Array(32).fill(7) }),
      await mutate({ expiresAt: BigInt(now) }),
      await mutate({ host: impostor.peerId }),
      await mutate({ contact: Contact.encode({ addrs: impostor.info().addrs }) }),
      await mutate({ topicVector: new Uint8Array(4) }),
      (await hostedRecord(th, 'bc'.repeat(16), vFar, now)).bytes
    ]
    for (const bytes of invalid) {
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: bytes, tier: 0, score: 1 }]))
      await settle()
      assert.deepEqual(origin.matches(id), [])
    }
    await impostor.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: good.bytes, tier: 0, score: 1 }]))
    await settle()
    assert.deepEqual(origin.matches(id), [])
    await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: good.bytes, tier: 0, score: 1 }]))
    await settle()
    const match = origin.matches(id)[0]
    assert.equal(match.kind, 'conference')
    assert.equal(match.tier.tier, 8)
    assert.ok(match.fullScore < 1)
  } finally { await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 5.3, 6.1 and 11.2
test('a descriptor replaces its retained interest and refreshes metadata without repeat callbacks', async () => {
  const net = createNetwork()
  const th = await net.node()
  const to = await net.node()
  const host = new Discovery({ matchWindowMs: 0,  transport: th, embedder: makeEmbedder(), onMatch: () => {} })
  let hits = 0
  const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: () => { hits++ }, maxMatchesPerInterest: 1, maxResultsPerAnnouncement: 1 })
  await host.start(); await origin.start()
  try {
    const held = await host.announce({ session: 'h', statement: 'base' })
    const id = await origin.announce({ session: 'o', statement: 'base' })
    await settle()
    assert.equal(origin.matches(id)[0].kind, 'interest')
    const room = await hostedRecord(th, held)
    const send = async (bytes: Uint8Array) => {
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: bytes, tier: 0, score: 1 }]))
      await settle()
    }
    await send(room.bytes)
    assert.equal(origin.matches(id)[0].kind, 'conference')
    assert.equal(hits, 2)
    await send(room.bytes)
    await retainedRecord(origin, id, held)
    const refreshed = await createDescriptor({ id: held, profile, topicVector: vBase, host: th.peerId, addrs: th.info().addrs,
      participantCount: 3, capacity: 8, admission: 'open', revision: 2, createdAt: room.descriptor.createdAt,
      expiresAt: room.descriptor.expiresAt, sign: data => th.sign(data) })
    await send(refreshed.bytes)
    assert.equal(hits, 2)
    const retained = origin.matches(id)[0]
    assert.ok(retained.kind === 'conference')
    assert.equal(retained.record.participantCount, 3)
    await send(room.bytes)
    const afterReplay = origin.matches(id)[0]
    assert.ok(afterReplay.kind === 'conference')
    assert.equal(afterReplay.record.participantCount, 3)
    for (const change of [{ revision: 2, createdAt: room.descriptor.createdAt },
      { revision: 3, createdAt: room.descriptor.createdAt + 1 }]) {
      const conflicting = await createDescriptor({ id: held, profile, topicVector: vBase,
        host: th.peerId, addrs: th.info().addrs, participantCount: 4, capacity: 8,
        admission: 'open', expiresAt: room.descriptor.expiresAt, ...change, sign: data => th.sign(data) })
      await send(conflicting.bytes)
      const unchanged = origin.matches(id)[0]
      assert.ok(unchanged.kind === 'conference')
      assert.equal(unchanged.record.participantCount, 3)
      assert.equal(unchanged.record.revision, 2)
    }
    await th.send(to.peerId, directPacket(id, host.interests()[0].bytes, 0, 1))
    await settle()
    assert.equal(origin.matches(id)[0].kind, 'conference')
    assert.equal(hits, 2)
  } finally { await host.stop(); await origin.stop() }
})

// Docs: VORTEX_v5.1.md sections 2.2, 5.3 and 10.7
for (const action of ['withdraw', 'expiry', 'stop', 'restart'] as const) {
  test(`descriptor verification spanning ${action} retains nothing`, async () => {
    const net = createNetwork()
    const th = await net.node()
    const to = await net.node()
    const clock = { now: Date.now() }
    let hits = 0
    const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: () => { hits++ }, now: () => clock.now })
    await origin.start()
    try {
      const id = await origin.announce({ session: 'o', statement: 'base', ttl: 1 })
      const room = await hostedRecord(th, 'ab'.repeat(16), vBase, clock.now)
      let release = () => {}
      let entered = false
      const gate = new Promise<void>(resolve => { release = resolve })
      const verify = to.verify.bind(to)
      to.verify = async (peer, data, sig) => { entered = true; await gate; return verify(peer, data, sig) }
      await th.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }]))
      await settle()
      assert.equal(entered, true)
      if (action === 'withdraw') origin.withdraw('o', id)
      if (action === 'expiry') clock.now += 2000
      if (action === 'stop' || action === 'restart') await origin.stop()
      if (action === 'restart') await origin.start()
      release()
      await settle()
      assert.equal(hits, 0)
      assert.deepEqual(origin.matches(id), [])
    } finally { await origin.stop() }
  })
}

// Docs: VORTEX_v5.1.md sections 6.1, 6.3 and 10.6
for (const retainedKind of ['interest', 'conference'] as const) {
  test(`a different host cannot replace a retained ${retainedKind} using its handle`, async () => {
    const net = createNetwork()
    const host = await net.node()
    const attacker = await net.node()
    const to = await net.node()
    let hits = 0
    const origin = new Discovery({ matchWindowMs: 0,  transport: to, embedder: makeEmbedder(), onMatch: () => { hits++ } })
    await origin.start()
    try {
      const id = await origin.announce({ session: 'o', statement: 'base' })
      const { createAnnouncement } = await import('./announcement.ts')
      const interest = await createAnnouncement({ profile, vector: vBase, origin: host.peerId,
        contact: Contact.encode({ addrs: host.info().addrs }), ttl: 60, sign: data => host.sign(data) })
      const handle = interest.announcement.id
      const room = await hostedRecord(host, handle)
      if (retainedKind === 'interest') await host.send(to.peerId, directPacket(id, interest.bytes, 0, 1))
      else await host.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: room.bytes, tier: 0, score: 1 }]))
      await settle()
      assert.equal(origin.matches(id)[0].peer, host.peerId)
      const forgedRoom = await hostedRecord(attacker, handle)
      await attacker.send(to.peerId, resultPacket([{ announcementId: unhex(id), record: new Uint8Array(), conference: forgedRoom.bytes, tier: 0, score: 1 }]))
      await settle()
      const kept = origin.matches(id)
      assert.equal(kept.length, 1)
      assert.equal(kept[0].peer, host.peerId)
      assert.equal(kept[0].kind, retainedKind)
      assert.deepEqual(kept[0].addrs, host.info().addrs)
      assert.equal(hits, 1)
    } finally { await origin.stop() }
  })
}

// Docs: VORTEX_v5.1.md sections 4.3 and 11.2
for (const stage of ['embed', 'sign', 'publish'] as const) {
  for (const restart of [false, true]) {
    test(`an announcement spanning ${stage} and ${restart ? 'restart' : 'stop'} cannot complete in the old run`, async () => {
      const net = createNetwork()
      const transport = await net.node()
      let release = () => {}
      let entered = () => {}
      const gate = new Promise<void>(resolve => { release = resolve })
      const ready = new Promise<void>(resolve => { entered = resolve })
      const embedder = makeEmbedder()
      const originalEmbed = embedder.embed
      const originalSign = transport.sign
      const originalPublish = transport.publish
      if (stage === 'embed') embedder.embed = async text => { entered(); await gate; return originalEmbed(text) }
      if (stage === 'sign') transport.sign = async data => { entered(); await gate; return originalSign(data) }
      if (stage === 'publish') transport.publish = async (topic, data) => { entered(); await gate; return originalPublish(topic, data) }
      const discovery = new Discovery({ matchWindowMs: 0,  transport, embedder, onMatch: () => {} })
      await discovery.start()
      const outcome = discovery.announce({ session: 'old', statement: 'base' }).then(
        () => undefined, error => error as Error)
      try {
        await ready
        await discovery.stop()
        if (restart) await discovery.start()
        release()
        assert.match((await outcome)?.message ?? 'unexpected success', /discovery stopped/)
        assert.deepEqual(discovery.interests(), [])
        // A transport write already in flight cannot be recalled; earlier stages must never publish.
        assert.equal(net.publishes.length, stage === 'publish' ? 1 : 0)
      } finally { release(); await discovery.stop() }
    })
  }
}

// Inspect retained storage directly: public getters lazily prune and would hide a missing timer.
test('idle interest expiry releases statements and matches without another operation', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: () => {} })
  await responder.start(); await origin.start()
  try {
    await responder.announce({ session: 'host', statement: 'base' })
    const short = await origin.announce({ session: 'guest', statement: 'exact', ttl: 1 })
    const long = await origin.announce({ session: 'guest', statement: 'tier8', ttl: 2 })
    await settle()
    const stored = origin as unknown as {
      registry: { interests: Map<string, unknown> }, matchesByInterest: Map<string, unknown>
    }
    assert.equal(stored.matchesByInterest.size, 2)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.deepEqual([...stored.registry.interests.keys()], [long])
    assert.equal(stored.matchesByInterest.has(short), false)
    assert.equal(stored.matchesByInterest.has(long), true)
    await new Promise(resolve => setTimeout(resolve, 1000))
    assert.equal(stored.registry.interests.size, 0)
    assert.equal(stored.matchesByInterest.size, 0)
  } finally { await responder.stop(); await origin.stop() }
})

test('a failed replacement publish after restart cannot resurrect an old session interest', async () => {
  const net = createNetwork()
  const transport = await net.node()
  const discovery = new Discovery({ transport, embedder: makeEmbedder(), onMatch: () => {} })
  await discovery.start()
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const publish = transport.publish
  try {
    const old = await discovery.announce({ session: 'old', statement: 'base' })
    transport.publish = async () => { entered(); await gate; throw new Error('publish failed') }
    const failed = discovery.announce({ session: 'old', statement: 'exact', replaces: old }).catch(error => error)
    await ready
    await discovery.stop(); await discovery.start()
    transport.publish = publish
    const fresh = await discovery.announce({ session: 'fresh', statement: 'tier8' })
    release()
    assert.match((await failed).message, /publish failed/)
    assert.deepEqual(discovery.interests().map(interest => interest.id), [fresh])
  } finally { release(); await discovery.stop() }
})

test('an idle expired result is released while its local interest remains open', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: () => {} })
  await responder.start(); await origin.start()
  try {
    await responder.announce({ session: 'host', statement: 'base', ttl: 1 })
    const id = await origin.announce({ session: 'guest', statement: 'exact', ttl: 3 })
    await settle()
    const stored = origin as unknown as {
      registry: { interests: Map<string, unknown> }, matchesByInterest: Map<string, unknown>
    }
    assert.equal(stored.matchesByInterest.size, 1)
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(stored.registry.interests.has(id), true)
    assert.equal(stored.matchesByInterest.size, 0)
  } finally { await responder.stop(); await origin.stop() }
})

test('withdrawal, session end and stop release the last expiry timer', async () => {
  const net = createNetwork()
  const transport = await net.node()
  const discovery = new Discovery({ transport, embedder: makeEmbedder(), onMatch: () => {} })
  const stored = discovery as unknown as { expiryTimer: unknown }
  await discovery.start()
  try {
    const first = await discovery.announce({ session: 's', statement: 'base' })
    assert.notEqual(stored.expiryTimer, undefined)
    assert.equal(discovery.withdraw('s', first), true)
    assert.equal(stored.expiryTimer, undefined)
    const second = await discovery.announce({ session: 's', statement: 'exact' })
    assert.notEqual(stored.expiryTimer, undefined)
    assert.deepEqual(discovery.endSession('s'), [second])
    assert.equal(stored.expiryTimer, undefined)
    await discovery.announce({ session: 's', statement: 'tier8' })
    assert.notEqual(stored.expiryTimer, undefined)
    await discovery.stop()
    assert.equal(stored.expiryTimer, undefined)
    assert.deepEqual(discovery.interests(), [])
    await discovery.start()
    assert.equal(stored.expiryTimer, undefined)
    assert.deepEqual(discovery.interests(), [])
  } finally { await discovery.stop() }
})

test('a failed replacement restores the original interest and its retained matches', async () => {
  const net = createNetwork()
  const host = await net.node()
  const guest = await net.node()
  const responder = new Discovery({ transport: host, embedder: makeEmbedder(), onMatch: () => {} })
  const origin = new Discovery({ transport: guest, embedder: makeEmbedder(), onMatch: () => {} })
  await responder.start(); await origin.start()
  try {
    const record = await responder.announce({ session: 'host', statement: 'base' })
    const original = await origin.announce({ session: 'guest', statement: 'exact' })
    await settle()
    assert.deepEqual(origin.matches(original).map(match => match.record.id), [record])
    guest.failPublish = true
    await assert.rejects(origin.announce({ session: 'guest', statement: 'tier8', replaces: original }), /publish failed/)
    assert.deepEqual(origin.interests().map(interest => interest.id), [original])
    assert.deepEqual(origin.matches(original).map(match => match.record.id), [record])
  } finally { await responder.stop(); await origin.stop() }
})

for (const stage of ['embed', 'publish', 'successful publish'] as const) {
  test(`ending a session during ${stage} prevents an announcement from restoring that session`, async () => {
    const net = createNetwork()
    const transport = await net.node()
    const embedder = makeEmbedder()
    const discovery = new Discovery({ transport, embedder, onMatch: () => {} })
    await discovery.start()
    let release = () => {}
    let entered = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    try {
      const old = await discovery.announce({ session: 's', statement: 'base' })
      if (stage === 'embed') {
        const embed = embedder.embed
        embedder.embed = async text => { entered(); await gate; return embed(text) }
      } else {
        const publish = transport.publish
        transport.publish = async (topic, data) => {
          entered(); await gate
          if (stage === 'publish') throw new Error('publish failed')
          return publish(topic, data)
        }
      }
      const outcome = discovery.announce({ session: 's', statement: 'exact', replaces: old }).catch(error => error)
      await ready
      discovery.endSession('s')
      release()
      assert.ok(await outcome instanceof Error)
      assert.deepEqual(discovery.interests('s'), [])
    } finally { release(); await discovery.stop() }
  })
}

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

// Docs: VORTEX_v5.1.md section 5.3 — bounded match notification window.

/** One direct answer to an interest, sent at a moment the test chooses. */
async function answer (from: TestTransport, to: TestTransport, interestId: string, record: Uint8Array): Promise<void> {
  await from.send(to.peerId, resultPacket([{ announcementId: unhex(interestId), record, tier: 0, score: 1 }]), to.info().addrs)
  await settle()
}

/** Wait until a record id is retained for an interest (handler fully applied). */
async function retainedRecord (d: Discovery, interestId: string, recordId: string, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!d.matches(interestId).some(match => match.record.id === recordId)) {
    if (Date.now() > end) throw new Error('result not retained')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function lastBytes (d: Discovery, session: string): Uint8Array {
  const held = d.interests().filter(interest => interest.session === session)
  return held[held.length - 1].bytes
}

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
