import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import type { DirectEvent, Embedder, GossipEvent, GossipHandler, Multiaddr, PeerId, Transport, TransportInfo } from '../types.ts'
import { createAnnouncement } from './announcement.ts'
import { Contact, DiscoveryPacket } from './proto/discovery.ts'
import { createNodeTransport } from '../net/node.ts'
import { encodeVector } from '../embed/vector.ts'
import { VortexService } from './service.ts'
import type { Conferences } from './conferences.ts'
import type { Snapshot, RoomSubscription } from './conversations.ts'
import { createDisclosurePolicy } from './disclosure.ts'

// Fake table embedder, copied pattern from discovery.test.ts (never imported from it).
export const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64, truncation: 'tail',
  pooling: 'mean', normalization: 'l2', dims: [8, 4, 2], encoding: 'float32le', version: 1,
  tolerance: 0.001, thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
export const table: Record<string, Float32Array> = {
  base: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]),
  exact: Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0]),
  tier8: Float32Array.from([1, 0.2, 0, 0, 1, 0.3, 0, 0]),
  tier4: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0]),
  far: Float32Array.from([0, 1, 0, 0, 0, 0, 1, 0])
}
export const fakeEmbedder = (): Embedder => ({
  profile: () => profile,
  embed: async (text: string): Promise<Float32Array> => {
    const found = table[text]
    if (found === undefined) throw new Error(`unknown statement: ${text}`)
    return found
  }
})

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const subjectHex = (text: string): string =>
  Array.from(encodeVector(table[text]), byte => byte.toString(16).padStart(2, '0')).join('')

export async function pair (saveA?: (s: Snapshot) => void, saveB?: (s: Snapshot) => void) {
  const ta = await createNodeTransport()
  const tbRaw = await createNodeTransport()
  // B's sends are recorded so tests can see which address chose the dial.
  const sentTo: Array<{ peer: string, addrs?: Multiaddr[] }> = []
  const tb = {
    ...tbRaw,
    send: (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]): Promise<void> => {
      sentTo.push({ peer, addrs })
      return tbRaw.send(peer, data, addrs)
    }
  }
  const sa = new VortexService(ta, 'a', saveA ?? (() => {}), undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', saveB ?? (() => {}), undefined, { embedder: fakeEmbedder() })
  const infoA = await sa.start()
  const infoB = await sb.start()
  await sa.dial(infoB.addrs[0])
  await sleep(2500)
  return { sa, sb, infoA, infoB, sentTo, stop: async (): Promise<void> => { await sa.stop(); await sb.stop() } }
}

export const LEGACY_TOPIC = '/vortex/local-discovery/1'

export async function until (check: () => boolean, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('condition timed out')
    await sleep(20)
  }
}
// Docs: VORTEX_v5.1.md sections 6.2, 6.3, 6.4, 7.3, 9.3 and 12.6

// Docs: VORTEX_v5.1.md section 6.5 — service subscription lifecycle (subscribe/renew/expire/leave/stop/closed).
export async function singleService(options: Record<string, unknown> = {}, save?: (s: Snapshot) => void) {
  const service = new VortexService(await createNodeTransport(), 'test', save ?? (() => {}), undefined,
    { embedder: fakeEmbedder(), ...(options as object) })
  await service.start()
  return service
}
