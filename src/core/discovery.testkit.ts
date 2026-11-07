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


export const profile = makeProfile({
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

export const topic = announceTopic(profile.id)

// Vectors: first two components keep every prefix valid (Section 5.1).
export const vBase = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0])
export const vExact = Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0])
export const v8 = Float32Array.from([1, 0.2, 0, 0, 1, 0.3, 0, 0])
export const v4 = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0])
export const v2 = Float32Array.from([1, 0.1, 1, 1, 0, 0, 0, 0])
export const vFar = Float32Array.from([0, 1, 0, 0, 0, 0, 1, 0])
export const vR2 = Float32Array.from([1, 0.3, 0.2, 0.1, 0.5, 1, 0, 0])

export const table: Record<string, Float32Array> = {
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

export function makeEmbedder (calls?: { count: number }) {
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

export function hex (bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function unhex (text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

/** One hand-built direct answer to an interest, for the forged-response cases. */
export function directPacket (announcementId: string, record: Uint8Array, tier: number, score: number): Uint8Array {
  const encoded = DiscoveryPacket.encode({ results: [{ announcementId: unhex(announcementId), record, tier, score }] })
  const packet = new Uint8Array(1 + encoded.length)
  packet[0] = 0
  packet.set(encoded, 1)
  return packet
}

export async function settle (turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

export async function sleep (ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export type TestTransport = Transport & {
  verdicts: GossipVerdict[]
  sent: Array<{ peer: PeerId, data: Uint8Array }>
  directs: DirectEvent[]
  peerId: PeerId
  failPublish: boolean
}

export function createNetwork () {
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

export async function verify (peer: PeerId, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const publicKey = peerIdFromString(peer).publicKey
  if (publicKey === undefined) return false
  return await publicKey.verify(data, signature)
}

/** A signed host record with no admission credentials or roster. */
export async function hostedRecord (host: TestTransport, id = 'ab'.repeat(16), topicVector = vBase, now = Date.now()) {
  return createDescriptor({ id, profile, topicVector, host: host.peerId, addrs: host.info().addrs,
    participantCount: 2, capacity: 8, admission: 'open', createdAt: now, expiresAt: now + 60000,
    sign: data => host.sign(data), now })
}

export function resultPacket (results: Parameters<typeof DiscoveryPacket.encode>[0]['results']): Uint8Array {
  const encoded = DiscoveryPacket.encode({ results })
  const packet = new Uint8Array(1 + encoded.length)
  packet.set(encoded, 1)
  return packet
}

// Docs: VORTEX_v5.1.md section 5.3 — bounded match notification window.

/** One direct answer to an interest, sent at a moment the test chooses. */
export async function answer (from: TestTransport, to: TestTransport, interestId: string, record: Uint8Array): Promise<void> {
  await from.send(to.peerId, resultPacket([{ announcementId: unhex(interestId), record, tier: 0, score: 1 }]), to.info().addrs)
  await settle()
}

/** Wait until a record id is retained for an interest (handler fully applied). */
export async function retainedRecord (d: Discovery, interestId: string, recordId: string, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!d.matches(interestId).some(match => match.record.id === recordId)) {
    if (Date.now() > end) throw new Error('result not retained')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export function lastBytes (d: Discovery, session: string): Uint8Array {
  const held = d.interests().filter(interest => interest.session === session)
  return held[held.length - 1].bytes
}
