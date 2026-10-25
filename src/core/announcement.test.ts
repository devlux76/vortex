import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import { encodeVector } from '../embed/vector.ts'
import type { PeerId } from '../types.ts'
import {
  AnnouncementError, MAX_ANNOUNCEMENT_BYTES, createAnnouncement, expiresAt, openAnnouncement,
  type AnnouncementFault, type OpenOptions
} from './announcement.ts'
import { Announcement as Wire, SignedAnnouncement } from './proto/discovery.ts'

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
const vector = Float32Array.from([0.5, -0.25, 0.125, 1, 0, 0, 0, 2])
const contact = Uint8Array.from([1, 2, 3])
const NOW = 1_800_000_000_000
const DOMAIN = new TextEncoder().encode('vortex-announcement:1\n')

async function identity (): Promise<{ peer: PeerId, sign: (data: Uint8Array) => Promise<Uint8Array> }> {
  const key = await generateKeyPair('Ed25519')
  return { peer: peerIdFromPrivateKey(key).toString(), sign: async data => await key.sign(data) }
}

/** The check a transport makes: the signature against the key embedded in the peer identity. */
async function verify (peer: PeerId, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const publicKey = peerIdFromString(peer).publicKey
  if (publicKey === undefined) return false
  return await publicKey.verify(data, signature)
}

const open: OpenOptions = { profile: namespace => namespace === profile.id ? profile : undefined, verify, now: NOW }

async function refused (bytes: Uint8Array, fault: AnnouncementFault, options: OpenOptions = open): Promise<void> {
  await assert.rejects(openAnnouncement(bytes, options), (error: unknown) => {
    assert.ok(error instanceof AnnouncementError, String(error))
    assert.equal(error.fault, fault, error.message)
    return true
  })
}

/** A correctly signed announcement with some wire fields replaced. */
async function forged (change: Partial<Parameters<typeof Wire.encode>[0]>): Promise<Uint8Array> {
  const { peer, sign } = await identity()
  const encoded = Wire.encode({
    announcementId: new Uint8Array(16).fill(7),
    namespace: Uint8Array.from(profile.id.match(/../g) as string[], pair => parseInt(pair, 16)),
    profileVersion: profile.version,
    vector: encodeVector(vector),
    origin: peer,
    contact,
    issuedAt: BigInt(NOW),
    ttl: 60,
    ...change
  })
  const data = new Uint8Array(DOMAIN.length + encoded.length)
  data.set(DOMAIN)
  data.set(encoded, DOMAIN.length)
  return SignedAnnouncement.encode({ announcement: encoded, signature: await sign(data) })
}

// Docs: VORTEX_v5.1.md section 4.2
test('an announcement is opened by a receiver exactly as its origin built it', async () => {
  const { peer, sign } = await identity()
  const { announcement, bytes } = await createAnnouncement({ profile, vector, origin: peer, contact, ttl: 60, sign, now: NOW })
  assert.match(announcement.id, /^[0-9a-f]{32}$/)
  assert.equal(announcement.namespace, profile.id)
  assert.equal(announcement.profileVersion, 3)
  assert.equal(announcement.origin, peer)
  assert.equal(announcement.issuedAt, NOW)
  assert.equal(expiresAt(announcement), NOW + 60000)
  assert.equal('statement' in announcement, false)
  const opened = await openAnnouncement(bytes, open)
  assert.deepEqual(opened, announcement)
  assert.deepEqual(opened.vector, vector)
  assert.deepEqual(Array.from(opened.contact), [1, 2, 3])
})

// Docs: VORTEX_v5.1.md sections 4.2 and 10.2
test('the statement travels only when given, and each announcement has its own id', async () => {
  const { peer, sign } = await identity()
  const make = async (statement?: string) =>
    await createAnnouncement({ profile, vector, origin: peer, contact, ttl: 60, sign, now: NOW, statement })
  const withText = await make('Intermittent compute shader failures; suspect resource lifetime.')
  assert.equal((await openAnnouncement(withText.bytes, open)).statement, 'Intermittent compute shader failures; suspect resource lifetime.')
  const without = await make()
  assert.equal((await openAnnouncement(without.bytes, open)).statement, undefined)
  assert.notEqual(withText.announcement.id, without.announcement.id)
})

// Docs: VORTEX_v5.1.md section 4.2
test('the signature covers every field: any change to the signed bytes is refused', async () => {
  const { peer, sign } = await identity()
  const { bytes } = await createAnnouncement({ profile, vector, origin: peer, contact, ttl: 60, sign, now: NOW, statement: 'a' })
  const signed = SignedAnnouncement.decode(bytes)
  const wire = Wire.decode(signed.announcement)
  const changes: Array<Partial<Parameters<typeof Wire.encode>[0]>> = [
    { announcementId: new Uint8Array(16) }, { vector: encodeVector(Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1])) },
    { contact: Uint8Array.from([9]) }, { issuedAt: BigInt(NOW - 1) }, { ttl: 61 }, { statement: 'b' }, { statement: undefined }
  ]
  for (const change of changes) {
    const tampered = SignedAnnouncement.encode({ announcement: Wire.encode({ ...wire, ...change }), signature: signed.signature })
    await refused(tampered, 'bad_signature')
  }
})

// Docs: VORTEX_v5.1.md section 4.2
test('an announcement signed by one identity and naming another as origin is refused', async () => {
  const other = await identity()
  await refused(await forged({ origin: other.peer }), 'bad_signature')
  await refused(await forged({ origin: 'not-a-peer-id' }), 'bad_signature')
})

// Docs: VORTEX_v5.1.md section 4.2
test('a signature made without the domain prefix is refused', async () => {
  const { peer, sign } = await identity()
  const { bytes } = await createAnnouncement({ profile, vector, origin: peer, contact, ttl: 60, sign, now: NOW })
  const { announcement } = SignedAnnouncement.decode(bytes)
  await refused(SignedAnnouncement.encode({ announcement, signature: await sign(announcement) }), 'bad_signature')
})

// Docs: VORTEX_v5.1.md sections 2.4 and 4.2
test('malformed, oversized and foreign announcements are refused before any signature work', async () => {
  let verified = 0
  const counting: OpenOptions = { ...open, verify: async (...args) => { verified++; return await verify(...args) } }
  await refused(new Uint8Array(MAX_ANNOUNCEMENT_BYTES + 1), 'too_large', counting)
  await refused(Uint8Array.from([0xff, 0xff, 0xff]), 'malformed', counting)
  await refused(await forged({ announcementId: new Uint8Array(8) }), 'malformed', counting)
  await refused(await forged({ namespace: new Uint8Array(31) }), 'malformed', counting)
  await refused(await forged({ contact: new Uint8Array(0) }), 'malformed', counting)
  await refused(await forged({ contact: new Uint8Array(2049) }), 'malformed', counting)
  await refused(await forged({ statement: 'x'.repeat(4097) }), 'malformed', counting)
  await refused(await forged({ profileVersion: 4 }), 'malformed', counting)
  await refused(await forged({ namespace: new Uint8Array(32).fill(1) }), 'unknown_namespace', counting)
  assert.equal(verified, 0)
})

// Docs: VORTEX_v5.1.md section 2.4
test('a vector of the wrong size, with a non-finite component or all zero is refused', async () => {
  await refused(await forged({ vector: new Uint8Array(16) }), 'bad_vector')
  await refused(await forged({ vector: encodeVector(Float32Array.from([1, Infinity, 0, 0, 0, 0, 0, 0])) }), 'bad_vector')
  await refused(await forged({ vector: new Uint8Array(32) }), 'bad_vector')
})

// Docs: VORTEX_v5.1.md section 4.2
test('issue time and lifetime are bounded', async () => {
  await refused(await forged({ ttl: 0 }), 'bad_time')
  await refused(await forged({ ttl: 3601 }), 'bad_time')
  await refused(await forged({ issuedAt: BigInt(NOW + 120001) }), 'bad_time')
  await refused(await forged({ issuedAt: 2n ** 60n }), 'bad_time')
  await refused(await forged({ issuedAt: BigInt(NOW - 60000) }), 'expired')
  // Just inside each bound.
  assert.equal((await openAnnouncement(await forged({ issuedAt: BigInt(NOW + 120000) }), open)).issuedAt, NOW + 120000)
  assert.equal((await openAnnouncement(await forged({ issuedAt: BigInt(NOW - 59999) }), open)).ttl, 60)
  assert.equal((await openAnnouncement(await forged({ ttl: 7200 }), { ...open, maxTtl: 7200 })).ttl, 7200)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an origin cannot publish what a receiver with the default limits would refuse', async () => {
  const { peer, sign } = await identity()
  const base = { profile, vector, origin: peer, contact, sign, now: NOW }
  await assert.rejects(createAnnouncement({ ...base, ttl: 3601 }), /ttl/)
  await assert.rejects(createAnnouncement({ ...base, ttl: 0 }), /ttl/)
  await assert.rejects(createAnnouncement({ ...base, ttl: 60, statement: 'x'.repeat(4097) }), /statement/)
  await assert.rejects(createAnnouncement({ ...base, ttl: 60, vector: Float32Array.from([1, 2]) }), /bytes/)
  await assert.rejects(createAnnouncement({ ...base, ttl: 60, contact: new Uint8Array(0) }), /contact/)
})
