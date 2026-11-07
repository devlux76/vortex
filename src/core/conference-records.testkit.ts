import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import { encodeVector } from '../embed/vector.ts'
import type { PeerId } from '../types.ts'
import { encodeContact } from './contact.ts'
import {
  ConferenceRecordError, DEFAULT_MAX_SKEW_MS, MAX_CAPACITY, MAX_DESCRIPTOR_BYTES,
  MAX_DESCRIPTOR_LIFETIME_MS, MAX_MESSAGE_CONTENT_BYTES, MAX_SIGNED_MESSAGE_BYTES,
  createDescriptor, createMessage, createSession, createSessionCert,
  openDescriptor, openMessage, openSessionCert, verifySession,
  type ConferenceFault
} from './conference-records.ts'
import { Admission, ConferenceMessage as WireMessage, Descriptor as WireDescriptor, SessionCert as WireCert, SignedDescriptor, SignedMessage } from './proto/conference.ts'


export const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 3, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
export const vector = Float32Array.from([0.5, -0.25, 0.125, 1, 0, 0, 0, 2])
export const NOW = 1_800_000_000_000
export const CERT_PREFIX = new TextEncoder().encode('vortex-session-cert:1\n')
export const DESCRIPTOR_PREFIX = new TextEncoder().encode('vortex-descriptor:1\n')
export const MESSAGE_PREFIX = new TextEncoder().encode('vortex-message:1\n')

export async function identity (): Promise<{ peer: PeerId, sign: (data: Uint8Array) => Promise<Uint8Array> }> {
  const key = await generateKeyPair('Ed25519')
  return { peer: peerIdFromPrivateKey(key).toString(), sign: async data => await key.sign(data) }
}

export async function verify (peer: PeerId, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = peerIdFromString(peer).publicKey
    if (key === undefined) return false
    return await key.verify(data, signature)
  } catch { return false }
}

export function countingVerify (): { verify: typeof verify, calls: () => number } {
  let calls = 0
  return {
    verify: (async (peer: PeerId, data: Uint8Array, signature: Uint8Array): Promise<boolean> => {
      calls++
      return verify(peer, data, signature)
    }) as typeof verify,
    calls: () => calls
  }
}

export async function refused (bytes: Uint8Array, fault: ConferenceFault, open: (bytes: Uint8Array) => Promise<unknown>): Promise<void> {
  await assert.rejects(open(bytes), (error: unknown) => {
    assert.ok(error instanceof ConferenceRecordError, String(error))
    assert.equal(error.fault, fault, (error as Error).message)
    return true
  })
}

export const openCert = (c: ReturnType<typeof countingVerify>, now = NOW): ((bytes: Uint8Array) => Promise<unknown>) =>
  (bytes: Uint8Array) => openSessionCert(bytes, { verify: c.verify, now })
export const openDesc = (c: ReturnType<typeof countingVerify>, now = NOW): ((bytes: Uint8Array) => Promise<unknown>) =>
  (bytes: Uint8Array) => openDescriptor(bytes, {
    profile: namespace => namespace === profile.id ? profile : undefined, verify: c.verify, now
  })

/** The custom content bytes a session certificate signs, as Section B2 lays them out. */
export function certContent (conferenceId: string, sessionKey: string, issuedAt: number, service: string): Uint8Array {
  const cid = Uint8Array.from(conferenceId.match(/../g) as string[], pair => parseInt(pair, 16))
  const sk = Uint8Array.from(sessionKey.match(/../g) as string[], pair => parseInt(pair, 16))
  const time = new Uint8Array(8)
  new DataView(time.buffer).setBigUint64(0, BigInt(issuedAt), false)
  const sb = new TextEncoder().encode(service)
  const out = new Uint8Array(16 + 32 + 8 + sb.length)
  out.set(cid)
  out.set(sk, 16)
  out.set(time, 48)
  out.set(sb, 56)
  return out
}

export function joined (first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length)
  out.set(first)
  out.set(second, first.length)
  return out
}
