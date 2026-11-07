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


export const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 3, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
export const vector = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0])

export async function settle (turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

export function unhex (text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

/** One conference packet on the wire: a leading 1 byte plus the encoding. */
export function frame (packet: Parameters<typeof ConferencePacket.encode>[0]): Uint8Array {
  const encoded = ConferencePacket.encode(packet)
  const out = new Uint8Array(1 + encoded.length)
  out[0] = 1
  out.set(encoded, 1)
  return out
}

export const DESCRIPTOR_PREFIX = new TextEncoder().encode('vortex-descriptor:1\n')

export function joinedBytes (first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length)
  out.set(first)
  out.set(second, first.length)
  return out
}

export type TestTransport = Transport & { peerId: PeerId }

export function createNetwork () {
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

export interface Node {
  transport: TestTransport
  conf: Conferences
  events: ConferenceEvent[]
  clock: { now: number }
  formables: Map<string, Formable>
  peerId: PeerId
  addrs: string[]
}

export async function makeNode (net: ReturnType<typeof createNetwork>, now = 1_800_000_000_000,
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

export let nextRef = 0
export function freshRef (): string {
  nextRef++
  return nextRef.toString(16).padStart(32, '0')
}

export function formable (id: string, session: string): Formable {
  return { id, session, namespace: profile.id, topicVector: vector }
}

/** A host post queued after a replay proves the participant has finished handling it. */
export async function replayBarrier (host: Node, participant: Node, ref: string): Promise<void> {
  const message = await host.conf.post(ref, 'sh', { type: 'text', content: new Uint8Array([1]) })
  const deadline = Date.now() + 2000
  while (!participant.events.some(e => e.kind === 'message' && e.message.id === message.id)) {
    assert.ok(Date.now() < deadline, 'host post reaches participant after replay')
    await settle()
  }
}

// Docs: VORTEX_v5.1.md sections 6.1 and 11.5 — host-only topic revision.
export const revisedVector = Float32Array.from([0, 1, 0, 0, 0, 1, 0, 0])

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — original-query subject retention.
export const subjectHex = Array.from(encodeVector(vector), byte => byte.toString(16).padStart(2, '0')).join('')
export function querySubject (overrides = {}): { statement: string, vector: string, namespace: string, profileVersion: number } {
  return { statement: 'flood query', vector: subjectHex, namespace: profile.id, profileVersion: 3, ...overrides }
}
