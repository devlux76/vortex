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

// Docs: VORTEX_v5.1.md section 8.1
test('session keys are fresh, distinct and verifiable', async () => {
  const a = await createSession()
  const b = await createSession()
  assert.match(a.key, /^[0-9a-f]{64}$/)
  assert.notEqual(a.key, b.key)
  const data = new TextEncoder().encode('hello')
  assert.equal(await verifySession(a.key, data, await a.sign(data)), true)
})

// Docs: VORTEX_v5.1.md section 8.1
test('verifySession is false for anything but the right key and never throws', async () => {
  const a = await createSession()
  const b = await createSession()
  const data = new TextEncoder().encode('hello')
  const good = await a.sign(data)
  assert.equal(await verifySession(b.key, data, good), false)
  const bad = Uint8Array.from(good)
  bad[0] ^= 1
  assert.equal(await verifySession(a.key, data, bad), false)
  assert.equal(await verifySession('ab', data, good), false)
  assert.equal(await verifySession('zz'.repeat(32), data, good), false)
  assert.equal(await verifySession(a.key.slice(0, 62), data, good), false)
  assert.equal(await verifySession('', data, new Uint8Array(0)), false)
})

// Docs: VORTEX_v5.1.md section 8.1
test('a session certificate round-trips exactly as built', async () => {
  const { peer, sign } = await identity()
  const session = await createSession()
  const conferenceId = '11'.repeat(16)
  const { cert, bytes } = await createSessionCert({ conferenceId, sessionKey: session.key, service: peer, sign, now: NOW })
  assert.deepEqual(cert, { conferenceId, sessionKey: session.key, service: peer, issuedAt: NOW })
  const opened = await openSessionCert(bytes, { verify, now: NOW })
  assert.deepEqual(opened, cert)
})

// Docs: VORTEX_v5.1.md section 8.1
test('changing any certified field breaks the certificate signature', async () => {
  const { peer, sign } = await identity()
  const session = await createSession()
  const other = await identity()
  const session2 = await createSession()
  const { bytes } = await createSessionCert({ conferenceId: '11'.repeat(16), sessionKey: session.key, service: peer, sign, now: NOW })
  const wire = WireCert.decode(bytes)
  const changes: Array<Partial<Parameters<typeof WireCert.encode>[0]>> = [
    { conferenceId: new Uint8Array(16).fill(9) },
    { sessionKey: unhexBytes(session2.key) },
    { service: other.peer },
    { issuedAt: BigInt(NOW + 1) }
  ]
  for (const change of changes) {
    const tampered = WireCert.encode({ ...wire, ...change })
    await refused(tampered, 'bad_signature', openCert(countingVerify()))
  }
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

// Docs: VORTEX_v5.1.md section 8.1
test('a certificate without its prefix, with another prefix, or from another identity is refused', async () => {
  const { peer, sign } = await identity()
  const other = await identity()
  const session = await createSession()
  const conferenceId = '11'.repeat(16)
  const content = certContent(conferenceId, session.key, NOW, peer)
  const bare = WireCert.encode({
    conferenceId: unhexBytes(conferenceId), sessionKey: unhexBytes(session.key), service: peer,
    issuedAt: BigInt(NOW), signature: await sign(content)
  })
  await refused(bare, 'bad_signature', openCert(countingVerify()))
  const crossed = WireCert.encode({
    conferenceId: unhexBytes(conferenceId), sessionKey: unhexBytes(session.key), service: peer,
    issuedAt: BigInt(NOW), signature: await sign(joined(MESSAGE_PREFIX, content))
  })
  await refused(crossed, 'bad_signature', openCert(countingVerify()))
  const foreign = await createSessionCert({ conferenceId, sessionKey: session.key, service: other.peer, sign, now: NOW })
  await refused(foreign.bytes, 'bad_signature', openCert(countingVerify()))
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

// Docs: VORTEX_v5.1.md sections 8.1 and 10.7
test('certificate shape, size and time faults come before any signature work', async () => {
  const { peer, sign } = await identity()
  const session = await createSession()
  const make = async (change: Partial<Parameters<typeof WireCert.encode>[0]>) => {
    const { bytes } = await createSessionCert({ conferenceId: '11'.repeat(16), sessionKey: session.key, service: peer, sign, now: NOW })
    const wire = WireCert.decode(bytes)
    return WireCert.encode({ ...wire, ...change })
  }
  const c = countingVerify()
  await refused(new Uint8Array(1025), 'too_large', openCert(c))
  await refused(Uint8Array.from([1, 2, 3]), 'malformed', openCert(c))
  await refused(await make({ conferenceId: new Uint8Array(8) }), 'malformed', openCert(c))
  await refused(await make({ sessionKey: new Uint8Array(8) }), 'malformed', openCert(c))
  await refused(await make({ service: '' }), 'malformed', openCert(c))
  await refused(await make({ service: 'x'.repeat(129) }), 'malformed', openCert(c))
  await refused(await make({ signature: new Uint8Array(0) }), 'malformed', openCert(c))
  await refused(await make({ issuedAt: BigInt(NOW + DEFAULT_MAX_SKEW_MS + 1) }), 'bad_time', openCert(c))
  await refused(await make({ issuedAt: 2n ** 60n }), 'bad_time', openCert(c))
  assert.equal(c.calls(), 0)
  await assert.rejects(createSessionCert({ conferenceId: '11'.repeat(16), sessionKey: session.key, service: '', sign, now: NOW }), /refused/)
})

// Docs: VORTEX_v5.1.md section 6.1
test('a descriptor round-trips exactly as built', async () => {
  const { peer, sign } = await identity()
  const id = '22'.repeat(16)
  const contact = encodeContact([`/ip4/127.0.0.1/tcp/7810/p2p/${peer}`])
  const { descriptor, bytes } = await createDescriptor({ id, profile, topicVector: vector, host: peer,
    addrs: [`/ip4/127.0.0.1/tcp/7810/p2p/${peer}`], participantCount: 1, capacity: 10,
    admission: 'invitation', createdAt: NOW - 1000, expiresAt: NOW + 3600000, sign, now: NOW })
  assert.equal(descriptor.id, id)
  assert.equal(descriptor.namespace, profile.id)
  assert.equal(descriptor.profileVersion, profile.version)
  assert.deepEqual(descriptor.topicVector, vector)
  assert.equal(descriptor.host, peer)
  assert.deepEqual(descriptor.addrs, [`/ip4/127.0.0.1/tcp/7810/p2p/${peer}`])
  assert.equal(descriptor.participantCount, 1)
  assert.equal(descriptor.capacity, 10)
  assert.equal(descriptor.admission, 'invitation')
  assert.equal(descriptor.createdAt, NOW - 1000)
  assert.equal(descriptor.expiresAt, NOW + 3600000)
  assert.equal(descriptor.revision, 1)
  void contact
  const opened = await openDescriptor(bytes, {
    profile: namespace => namespace === profile.id ? profile : undefined, verify, now: NOW
  })
  assert.deepEqual(opened, descriptor)
})

// Docs: VORTEX_v5.1.md section 6.1
test('changing any descriptor field breaks its signature', async () => {
  const otherProfile = makeProfile({ model: 'n', revision: 'r1', weights: 'q4', prompt: 'p: ',
    maxTokens: 64, truncation: 'tail', pooling: 'mean', normalization: 'l2',
    dims: [8, 4, 2], encoding: 'float32le', version: 4, tolerance: 0.001,
    thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 } })
  const lookup = (namespace: string): typeof profile | undefined =>
    namespace === profile.id ? profile : namespace === otherProfile.id ? otherProfile : undefined
  const { peer, sign } = await identity()
  const addr = `/ip4/127.0.0.1/tcp/7810/p2p/${peer}`
  const other = await identity()
  const otherAddr = `/ip4/127.0.0.1/tcp/7811/p2p/${other.peer}`
  const open = (bytes: Uint8Array): Promise<unknown> => openDescriptor(bytes, { profile: lookup, verify, now: NOW })
  const { bytes } = await createDescriptor({ id: '22'.repeat(16), profile, topicVector: vector, host: peer,
    addrs: [addr], participantCount: 1, capacity: 10, admission: 'open',
    createdAt: NOW - 1000, expiresAt: NOW + 3600000, sign, now: NOW })
  const signed = SignedDescriptor.decode(bytes)
  const inner = WireDescriptor.decode(signed.descriptor)
  // Each change keeps every earlier check passing so it reaches the signature.
  // The namespace travels with its version, and the host with its contact.
  const changes: Array<Partial<Parameters<typeof WireDescriptor.encode>[0]>> = [
    { conferenceId: new Uint8Array(16).fill(9) },
    { namespace: unhexBytes(otherProfile.id), profileVersion: otherProfile.version },
    { topicVector: encodeVector(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])) },
    { host: other.peer, contact: encodeContact([otherAddr]) },
    { contact: encodeContact([`/ip4/127.0.0.1/tcp/7812/p2p/${peer}`]) },
    { participantCount: 2 },
    { capacity: 11 },
    { admission: Admission.INVITATION },
    { createdAt: BigInt(NOW - 1001) },
    { expiresAt: BigInt(NOW + 3600001) },
    { revision: 2n }
  ]
  for (const change of changes) {
    const tampered = SignedDescriptor.encode({
      descriptor: WireDescriptor.encode({ ...inner, ...change }), signature: signed.signature
    })
    await refused(tampered, 'bad_signature', open)
  }
  // A lone profile version cannot reach the signature: the version gate fires first by construction.
  const versioned = SignedDescriptor.encode({
    descriptor: WireDescriptor.encode({ ...inner, profileVersion: 99 }), signature: signed.signature
  })
  await refused(versioned, 'malformed', open)
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

test('descriptor revisions must be positive safe integers and are checked before signatures', async () => {
  const { peer, sign } = await identity()
  const base = { id: '22'.repeat(16), profile, topicVector: vector, host: peer,
    addrs: [`/ip4/127.0.0.1/tcp/7810/p2p/${peer}`], participantCount: 1, capacity: 10,
    admission: 'open' as const, createdAt: NOW, expiresAt: NOW + 60000, sign, now: NOW }
  const { bytes } = await createDescriptor({ ...base, revision: 7 })
  const signed = SignedDescriptor.decode(bytes)
  const inner = WireDescriptor.decode(signed.descriptor)
  const c = countingVerify()
  for (const revision of [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    await refused(SignedDescriptor.encode({ ...signed,
      descriptor: WireDescriptor.encode({ ...inner, revision }) }), 'malformed', openDesc(c))
  }
  assert.equal(c.calls(), 0)
  for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0
    await assert.rejects(createDescriptor({ ...base, revision, sign: async data => { calls++; return sign(data) } }), /revision/)
    assert.equal(calls, 0)
  }
  const maximum = await createDescriptor({ ...base, revision: Number.MAX_SAFE_INTEGER })
  assert.equal((await openDescriptor(maximum.bytes, { profile: () => profile, verify, now: NOW })).revision,
    Number.MAX_SAFE_INTEGER)
})

// Docs: VORTEX_v5.1.md section 6.1
test('a descriptor without its prefix, with another prefix, or from another identity is refused', async () => {
  const { peer, sign } = await identity()
  const other = await identity()
  const addr = `/ip4/127.0.0.1/tcp/7810/p2p/${peer}`
  const inner = WireDescriptor.encode({ conferenceId: new Uint8Array(16).fill(3), namespace: unhexBytes(profile.id),
    profileVersion: profile.version, topicVector: encodeVector(vector), host: peer,
    contact: encodeContact([addr]), participantCount: 0, capacity: 10, admission: Admission.OPEN,
    createdAt: BigInt(NOW), expiresAt: BigInt(NOW + 60000), revision: 1n })
  const bare = SignedDescriptor.encode({ descriptor: inner, signature: await sign(inner) })
  await refused(bare, 'bad_signature', openDesc(countingVerify()))
  const crossed = SignedDescriptor.encode({ descriptor: inner, signature: await sign(joined(MESSAGE_PREFIX, inner)) })
  await refused(crossed, 'bad_signature', openDesc(countingVerify()))
  const foreign = await createDescriptor({ id: '22'.repeat(16), profile, topicVector: vector, host: other.peer,
    addrs: [`/ip4/127.0.0.1/tcp/7810/p2p/${other.peer}`], participantCount: 0, capacity: 10,
    admission: 'open', createdAt: NOW, expiresAt: NOW + 60000, sign, now: NOW })
  await refused(foreign.bytes, 'bad_signature', openDesc(countingVerify()))
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

// Docs: VORTEX_v5.1.md sections 6.1 and 10.7
test('descriptor shape, namespace, vector, time and expiry faults come before any signature work', async () => {
  const { peer, sign } = await identity()
  const addr = `/ip4/127.0.0.1/tcp/7810/p2p/${peer}`
  const base = { id: '22'.repeat(16), profile, topicVector: vector, host: peer, addrs: [addr],
    participantCount: 1, capacity: 10, admission: 'invitation' as const, sign, now: NOW }
  const seal = async (change: Partial<Parameters<typeof WireDescriptor.encode>[0]>, createdAt = NOW - 1000, expiresAt = NOW + 3600000) => {
    const inner = WireDescriptor.encode({ conferenceId: unhexBytes('22'.repeat(16)),
      namespace: unhexBytes(profile.id), profileVersion: profile.version, topicVector: encodeVector(vector),
      host: peer, contact: encodeContact([addr]), participantCount: 1, capacity: 10,
      admission: Admission.INVITATION, revision: 1n, createdAt: BigInt(createdAt), expiresAt: BigInt(expiresAt), ...change })
    return SignedDescriptor.encode({ descriptor: inner, signature: await sign(joined(DESCRIPTOR_PREFIX, inner)) })
  }
  const c = countingVerify()
  await refused(new Uint8Array(MAX_DESCRIPTOR_BYTES + 1), 'too_large', openDesc(c))
  await refused(Uint8Array.from([1, 2, 3]), 'malformed', openDesc(c))
  await refused(await seal({ conferenceId: new Uint8Array(8) }), 'malformed', openDesc(c))
  await refused(await seal({ namespace: new Uint8Array(31) }), 'malformed', openDesc(c))
  await refused(await seal({ host: '' }), 'malformed', openDesc(c))
  await refused(await seal({ host: 'x'.repeat(129) }), 'malformed', openDesc(c))
  await refused(await seal({ capacity: 1 }), 'malformed', openDesc(c))
  await refused(await seal({ capacity: MAX_CAPACITY + 1 }), 'malformed', openDesc(c))
  await refused(await seal({ participantCount: 11 }), 'malformed', openDesc(c))
  await refused(await seal({ contact: encodeContact([]) }), 'malformed', openDesc(c))
  await refused(await seal({ namespace: new Uint8Array(32).fill(7) }), 'unknown_namespace', openDesc(c))
  await refused(await seal({ profileVersion: profile.version + 1 }), 'malformed', openDesc(c))
  await refused(await seal({ topicVector: new Uint8Array(16) }), 'bad_vector', openDesc(c))
  await refused(await seal({}, NOW + DEFAULT_MAX_SKEW_MS + 1), 'bad_time', openDesc(c))
  await refused(await seal({ createdAt: BigInt(NOW), expiresAt: BigInt(NOW) }), 'bad_time', openDesc(c))
  await refused(await seal({ createdAt: BigInt(NOW), expiresAt: BigInt(NOW + MAX_DESCRIPTOR_LIFETIME_MS + 1) }), 'bad_time', openDesc(c))
  await refused(await seal({}, NOW - 7200000, NOW - 3600000), 'expired', openDesc(c))
  assert.equal(c.calls(), 0)
  // Admission outside the three policies is malformed: flip the encoded value byte.
  const opened = WireDescriptor.encode({ conferenceId: unhexBytes('22'.repeat(16)),
    namespace: unhexBytes(profile.id), profileVersion: profile.version, topicVector: encodeVector(vector),
    host: peer, contact: encodeContact([addr]), participantCount: 1, capacity: 10,
    admission: Admission.OPEN, revision: 1n, createdAt: BigInt(NOW - 1000), expiresAt: BigInt(NOW + 3600000) })
  const invited = WireDescriptor.encode({ conferenceId: unhexBytes('22'.repeat(16)),
    namespace: unhexBytes(profile.id), profileVersion: profile.version, topicVector: encodeVector(vector),
    host: peer, contact: encodeContact([addr]), participantCount: 1, capacity: 10,
    admission: Admission.INVITATION, revision: 1n, createdAt: BigInt(NOW - 1000), expiresAt: BigInt(NOW + 3600000) })
  let at = -1
  for (let i = 0; i < opened.length; i++) {
    if (opened[i] !== invited[i]) { at = i; break }
  }
  assert.ok(at >= 0)
  const forged = Uint8Array.from(opened)
  forged[at] = 5
  const sealed = SignedDescriptor.encode({ descriptor: forged, signature: await sign(joined(DESCRIPTOR_PREFIX, forged)) })
  await refused(sealed, 'malformed', openDesc(c))
  assert.equal(c.calls(), 0)
  // createDescriptor refuses what openDescriptor would refuse.
  await assert.rejects(createDescriptor({ ...base, capacity: 1, createdAt: NOW - 1000, expiresAt: NOW + 3600000 }), /refused/)
  await assert.rejects(createDescriptor({ ...base, participantCount: 11, capacity: 10, createdAt: NOW - 1000, expiresAt: NOW + 3600000 }), /refused/)
  await assert.rejects(createDescriptor({ ...base, createdAt: NOW, expiresAt: NOW + MAX_DESCRIPTOR_LIFETIME_MS + 1 }), /refused/)
  await assert.rejects(createDescriptor({ ...base, host: peer, addrs: [`/ip4/127.0.0.1/tcp/1/p2p/${(await identity()).peer}`], createdAt: NOW - 1000, expiresAt: NOW + 3600000 }), /refused/)
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

// Docs: VORTEX_v5.1.md section 8.1
test('a conference message round-trips exactly as built, with distinct ids', async () => {
  const session = await createSession()
  const conferenceId = '33'.repeat(16)
  const replyTo = '44'.repeat(16)
  const content = new TextEncoder().encode('hello conference')
  const first = await createMessage({ conferenceId, session, type: 'text', content, replyTo, now: NOW })
  assert.match(first.message.id, /^[0-9a-f]{32}$/)
  assert.equal(first.message.conferenceId, conferenceId)
  assert.equal(first.message.sender, session.key)
  assert.equal(first.message.timestamp, NOW)
  assert.equal(first.message.type, 'text')
  assert.deepEqual(first.message.content, content)
  assert.equal(first.message.replyTo, replyTo)
  const opened = await openMessage(first.bytes, { now: NOW })
  assert.deepEqual(opened, first.message)
  const second = await createMessage({ conferenceId, session, type: 'text', content, now: NOW })
  assert.notEqual(second.message.id, first.message.id)
  assert.equal(second.message.replyTo, undefined)
  // History is old: an old timestamp opens fine.
  const old = await createMessage({ conferenceId, session, type: 'text', content, now: NOW - 10000000 })
  assert.equal((await openMessage(old.bytes, { now: NOW })).timestamp, NOW - 10000000)
})

// Docs: VORTEX_v5.1.md section 8.1
test('changing any message field breaks its signature', async () => {
  const session = await createSession()
  const other = await createSession()
  const { message, bytes } = await createMessage({ conferenceId: '33'.repeat(16), session,
    type: 'text', content: new TextEncoder().encode('hi'), replyTo: '44'.repeat(16), now: NOW })
  void message
  const signed = SignedMessage.decode(bytes)
  const inner = WireMessage.decode(signed.message)
  const changes: Array<Partial<Parameters<typeof WireMessage.encode>[0]>> = [
    { messageId: new Uint8Array(16).fill(9) },
    { conferenceId: new Uint8Array(16).fill(9) },
    { sender: unhexBytes(other.key) },
    { timestamp: BigInt(NOW + 1) },
    { type: 'note' },
    { content: new TextEncoder().encode('bye') },
    { replyTo: unhexBytes('55'.repeat(16)) },
    { replyTo: undefined }
  ]
  for (const change of changes) {
    const tampered = SignedMessage.encode({
      message: WireMessage.encode({ ...inner, ...change }), signature: signed.signature
    })
    await refused(tampered, 'bad_signature', b => openMessage(b, { now: NOW }))
  }
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

// Docs: VORTEX_v5.1.md section 8.1
test('a message without its prefix, with another prefix, or from another session is refused', async () => {
  const session = await createSession()
  const other = await createSession()
  const inner = WireMessage.encode({ messageId: new Uint8Array(16).fill(3),
    conferenceId: unhexBytes('33'.repeat(16)), sender: unhexBytes(session.key), timestamp: BigInt(NOW),
    type: 'text', content: new TextEncoder().encode('hi') })
  const bare = SignedMessage.encode({ message: inner, signature: await session.sign(inner) })
  await refused(bare, 'bad_signature', b => openMessage(b, { now: NOW }))
  const crossed = SignedMessage.encode({ message: inner, signature: await session.sign(joined(DESCRIPTOR_PREFIX, inner)) })
  await refused(crossed, 'bad_signature', b => openMessage(b, { now: NOW }))
  const innerForeign = WireMessage.encode({ messageId: new Uint8Array(16).fill(3),
    conferenceId: unhexBytes('33'.repeat(16)), sender: unhexBytes(other.key), timestamp: BigInt(NOW),
    type: 'text', content: new TextEncoder().encode('hi') })
  const foreign = SignedMessage.encode({ message: innerForeign, signature: await session.sign(joined(MESSAGE_PREFIX, innerForeign)) })
  await refused(foreign, 'bad_signature', b => openMessage(b, { now: NOW }))
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})

// Docs: VORTEX_v5.1.md sections 8.1 and 10.7
test('message shape, size and time faults are named', async () => {
  const session = await createSession()
  const seal = async (change: Partial<Parameters<typeof WireMessage.encode>[0]>, timestamp = NOW) => {
    const inner = WireMessage.encode({ messageId: new Uint8Array(16).fill(3),
      conferenceId: unhexBytes('33'.repeat(16)), sender: unhexBytes(session.key), timestamp: BigInt(timestamp),
      type: 'text', content: new TextEncoder().encode('hi'), ...change })
    return SignedMessage.encode({ message: inner, signature: await session.sign(joined(MESSAGE_PREFIX, inner)) })
  }
  const open = (b: Uint8Array): Promise<unknown> => openMessage(b, { now: NOW })
  await refused(new Uint8Array(MAX_SIGNED_MESSAGE_BYTES + 1), 'too_large', open)
  await refused(Uint8Array.from([1, 2, 3]), 'malformed', open)
  await refused(await seal({ messageId: new Uint8Array(8) }), 'malformed', open)
  await refused(await seal({ conferenceId: new Uint8Array(8) }), 'malformed', open)
  await refused(await seal({ sender: new Uint8Array(8) }), 'malformed', open)
  await refused(await seal({ type: 'Text' }), 'malformed', open)
  await refused(await seal({ type: '' }), 'malformed', open)
  await refused(await seal({ type: 'a'.repeat(33) }), 'malformed', open)
  await refused(await seal({ content: new Uint8Array(0) }), 'malformed', open)
  await refused(await seal({ content: new Uint8Array(MAX_MESSAGE_CONTENT_BYTES + 1) }), 'malformed', open)
  await refused(await seal({ replyTo: new Uint8Array(8) }), 'malformed', open)
  await refused(await seal({}, NOW + DEFAULT_MAX_SKEW_MS + 1), 'bad_time', open)
  await assert.rejects(createMessage({ conferenceId: '33'.repeat(16), session, type: 'text',
    content: new Uint8Array(0), now: NOW }), /refused/)
  await assert.rejects(createMessage({ conferenceId: '33'.repeat(16), session, type: 'NOPE',
    content: new TextEncoder().encode('hi'), now: NOW }), /refused/)
  function unhexBytes (text: string): Uint8Array {
    return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
  }
})
