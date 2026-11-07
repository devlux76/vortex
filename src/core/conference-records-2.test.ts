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

import { profile, vector, NOW, CERT_PREFIX, DESCRIPTOR_PREFIX, MESSAGE_PREFIX, identity, verify, countingVerify, refused, openCert, openDesc, certContent, joined } from './conference-records.testkit.ts'

// Docs: TODO.md C8 — private membership persistence.
test('persistable session round-trips its private key and signs as the same key', async () => {
  const { restoreSession } = await import('./conference-records.ts')
  const session = await createSession() as unknown as { key: string, sign: (d: Uint8Array) => Promise<Uint8Array>, privateKey: Uint8Array }
  assert.ok(session.privateKey instanceof Uint8Array)
  assert.ok(session.privateKey.length > 0)
  const restored = await restoreSession(session.privateKey)
  assert.equal(restored.key, session.key)
  const data = new TextEncoder().encode('persist me')
  assert.equal(await verifySession(restored.key, data, await restored.sign(data)), true)
  assert.equal(await verifySession(session.key, data, await session.sign(data)), true)
  const copy = restored.privateKey.slice()
  restored.privateKey.fill(0)
  const again = await restoreSession(copy)
  assert.equal(again.key, session.key)
})

test('restoreSession requires an Ed25519 key and never echoes bytes', async () => {
  const { restoreSession } = await import('./conference-records.ts')
  const session = await createSession() as unknown as { privateKey: Uint8Array, key: string }
  const secret = session.privateKey.slice()
  const secretHex = Buffer.from(secret).toString('hex')
  await assert.rejects(restoreSession(new Uint8Array(0)), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(String((error as Error).message).includes(secretHex), false)
    return true
  })
  await assert.rejects(restoreSession(Uint8Array.from([1, 2, 3])), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as Error).message.includes('010203'), false)
    return true
  })
  // A single-bit flip must never echo the bytes: it either rejects or restores a different key.
  const tampered = secret.slice()
  tampered[tampered.length - 1] ^= 1
  const tamperedHex = Buffer.from(tampered).toString('hex')
  try {
    const other = await restoreSession(tampered)
    assert.notEqual(other.key, session.key)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal((error as Error).message.includes(tamperedHex), false)
  }
})

test('restore rejects an Ed25519 private key whose stored public half no longer matches its signer', async () => {
  const { restoreSession } = await import('./conference-records.ts')
  const session = await createSession()
  const corrupted = session.privateKey.slice()
  corrupted[corrupted.length - 1] ^= 1
  await assert.rejects(restoreSession(corrupted), /invalid session private key/)
})
