/**
 * The signed records conferences need: a session certificate, a descriptor
 * and a message (Sections 6.1 and 8.1). Each is built and signed by its
 * author and opened by every receiver before anything in it is used.
 *
 * Nothing here imports a Node built-in: the core runs in browsers.
 */
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf, publicKeyFromRaw } from '@libp2p/crypto/keys'
import type { EmbeddingProfile, PeerId } from '../types.ts'
import { decodeVector, encodeVector } from '../embed/vector.ts'
import { encodeContact, openContact } from './contact.ts'
import {
  Admission, ConferenceMessage as WireMessage, Descriptor as WireDescriptor,
  SessionCert as WireCert, SignedDescriptor, SignedMessage
} from './proto/conference.ts'

export type ConferenceFault =
  'too_large' | 'malformed' | 'unknown_namespace' | 'bad_vector' | 'bad_time' | 'expired' | 'bad_signature'

export class ConferenceRecordError extends Error {
  readonly fault: ConferenceFault
  constructor (fault: ConferenceFault, detail: string) {
    super(`conference record refused: ${detail}`)
    this.fault = fault
  }
}

/** Allowance for the author's clock running ahead of ours. */
export const DEFAULT_MAX_SKEW_MS = 120000
/** Largest signed descriptor accepted. */
export const MAX_DESCRIPTOR_BYTES = 16384
/** Largest conference: a count, never a list (Section 6.1). */
export const MAX_CAPACITY = 256
/** Longest a descriptor may run from creation to expiry: 7 days, in ms. */
export const MAX_DESCRIPTOR_LIFETIME_MS = 604800000
/** Largest message content accepted. */
export const MAX_MESSAGE_CONTENT_BYTES = 16384
/** Largest signed message accepted. */
export const MAX_SIGNED_MESSAGE_BYTES = 20000

/** Kept apart from every other use of the identity key. One prefix per record, never shared. */
const DESCRIPTOR_DOMAIN = new TextEncoder().encode('vortex-descriptor:1\n')
const CERT_DOMAIN = new TextEncoder().encode('vortex-session-cert:1\n')
const MESSAGE_DOMAIN = new TextEncoder().encode('vortex-message:1\n')

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

function unhex (text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('not lowercase hexadecimal')
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

function signedBytes (domain: Uint8Array, inner: Uint8Array): Uint8Array {
  const out = new Uint8Array(domain.length + inner.length)
  out.set(domain)
  out.set(inner, domain.length)
  return out
}

function u64be (value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, false)
  return out
}

export interface Session {
  /** The session's public key, 64 lowercase hex characters. */
  key: string
  sign (data: Uint8Array): Promise<Uint8Array>
}

/** A session with its exportable private key for trusted local persistence. */
export interface PersistableSession extends Session {
  /** Protobuf-encoded private key bytes. Never shared on the wire. */
  privateKey: Uint8Array
}

/** A fresh Ed25519 key pair for one agent session in one conference (Section 8.1). */
export async function createSession (): Promise<PersistableSession> {
  const privateKey = await generateKeyPair('Ed25519')
  return {
    key: hex(privateKey.publicKey.raw),
    sign: async (data: Uint8Array): Promise<Uint8Array> => privateKey.sign(data),
    privateKey: privateKeyToProtobuf(privateKey).slice()
  }
}

/**
 * Restore a session from its exported private key bytes. Requires an Ed25519
 * key (32-byte raw public key). Returns the same public key and sign function
 * with a private copy. Failures never echo the bytes.
 */
export async function restoreSession (bytes: Uint8Array): Promise<PersistableSession> {
  if (!(bytes instanceof Uint8Array)) throw new Error('invalid session private key')
  const input = bytes.slice()
  try {
    const key = privateKeyFromProtobuf(input)
    if (key.type !== 'Ed25519') throw new Error('invalid session private key')
    const probe = new TextEncoder().encode('vortex-session-restore:1\n')
    if (!await key.publicKey.verify(probe, await key.sign(probe))) throw new Error('invalid session private key')
    return {
      key: hex(key.publicKey.raw),
      sign: async (data: Uint8Array): Promise<Uint8Array> => key.sign(data),
      privateKey: input.slice()
    }
  } catch { throw new Error('invalid session private key') }
}

/** Check a signature against a session key (64 hex). False for a malformed key. */
export async function verifySession (key: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  let raw: Uint8Array
  try {
    raw = unhex(key)
  } catch {
    return false
  }
  if (raw.length !== 32) return false
  try {
    return await publicKeyFromRaw(raw).verify(data, signature)
  } catch {
    return false
  }
}

export interface SessionCert {
  /** 32 hex. */
  conferenceId: string
  /** 64 hex. */
  sessionKey: string
  service: PeerId
  /** Milliseconds since the Unix epoch. */
  issuedAt: number
}

/** The exact bytes the service signs: prefix, conference id, session key, big-endian time, service. */
function certSignBytes (conferenceId: Uint8Array, sessionKey: Uint8Array, issuedAt: bigint, service: string): Uint8Array {
  const serviceBytes = new TextEncoder().encode(service)
  const out = new Uint8Array(CERT_DOMAIN.length + 16 + 32 + 8 + serviceBytes.length)
  out.set(CERT_DOMAIN)
  out.set(conferenceId, CERT_DOMAIN.length)
  out.set(sessionKey, CERT_DOMAIN.length + 16)
  out.set(u64be(issuedAt), CERT_DOMAIN.length + 48)
  out.set(serviceBytes, CERT_DOMAIN.length + 56)
  return out
}

/**
 * The service's peer identity vouches that a session key belongs to a session
 * of that service in one conference (Section 8.1). Returns the cert with the
 * bytes to share. It is opened here as a receiver would open it.
 */
export async function createSessionCert (options: {
  conferenceId: string, sessionKey: string, service: PeerId,
  sign: (data: Uint8Array) => Promise<Uint8Array>, now?: number
}): Promise<{ cert: SessionCert, bytes: Uint8Array }> {
  const now = options.now ?? Date.now()
  const conferenceId = unhex(options.conferenceId)
  const sessionKey = unhex(options.sessionKey)
  const issuedAt = BigInt(now)
  const bytes = WireCert.encode({
    conferenceId,
    sessionKey,
    service: options.service,
    issuedAt,
    signature: await options.sign(certSignBytes(conferenceId, sessionKey, issuedAt, options.service))
  })
  const cert = await openSessionCert(bytes, { verify: async () => true, now })
  return { cert, bytes }
}

/**
 * Decode and check a session certificate: size, shape, times and signature.
 * Throws a ConferenceRecordError naming the first fault.
 */
export async function openSessionCert (bytes: Uint8Array, options: {
  verify: (peer: PeerId, data: Uint8Array, signature: Uint8Array) => Promise<boolean>,
  now?: number, maxSkewMs?: number
}): Promise<SessionCert> {
  const now = options.now ?? Date.now()
  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS
  if (bytes.length > 1024) throw new ConferenceRecordError('too_large', `${bytes.length} bytes`)
  let wire: WireCert
  try {
    wire = WireCert.decode(bytes)
  } catch {
    throw new ConferenceRecordError('malformed', 'not a session certificate')
  }
  if (wire.conferenceId.length !== 16) throw new ConferenceRecordError('malformed', 'conference_id must be 16 bytes')
  if (wire.sessionKey.length !== 32) throw new ConferenceRecordError('malformed', 'session_key must be 32 bytes')
  if (wire.service === '' || wire.service.length > 128) throw new ConferenceRecordError('malformed', 'service missing or too long')
  if (wire.signature.length === 0 || wire.signature.length > 512) throw new ConferenceRecordError('malformed', 'signature missing or too large')
  if (wire.issuedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConferenceRecordError('bad_time', 'issued_at out of range')
  const issuedAt = Number(wire.issuedAt)
  if (issuedAt > now + maxSkewMs) throw new ConferenceRecordError('bad_time', 'issued in the future')
  let valid = false
  try {
    valid = await options.verify(wire.service,
      certSignBytes(wire.conferenceId, wire.sessionKey, wire.issuedAt, wire.service), wire.signature)
  } catch { /* An unusable service identity cannot have signed anything. */ }
  if (!valid) throw new ConferenceRecordError('bad_signature', 'signature does not verify against service')
  return { conferenceId: hex(wire.conferenceId), sessionKey: hex(wire.sessionKey), service: wire.service, issuedAt }
}

export type AdmissionPolicy = 'open' | 'invitation' | 'group'

function admissionToPolicy (admission: Admission): AdmissionPolicy | undefined {
  if (admission === Admission.OPEN) return 'open'
  if (admission === Admission.INVITATION) return 'invitation'
  if (admission === Admission.GROUP) return 'group'
  return undefined
}

function policyToAdmission (policy: AdmissionPolicy): Admission {
  if (policy === 'open') return Admission.OPEN
  if (policy === 'invitation') return Admission.INVITATION
  return Admission.GROUP
}

export interface ConferenceDescriptor {
  /** 32 hex. */
  id: string
  /** The profile hash, 64 hex. */
  namespace: string
  profileVersion: number
  /** The topic embedding, valid under the namespace's profile. */
  topicVector: Float32Array
  host: PeerId
  /** Where the host can be dialed, from the contact, already checked to name the host. */
  addrs: string[]
  participantCount: number
  capacity: number
  admission: AdmissionPolicy
  /** Milliseconds since the Unix epoch. */
  createdAt: number
  /** Milliseconds since the Unix epoch. */
  expiresAt: number
  /** Positive safe integer, increasing with every signed host update. */
  revision: number
}

/**
 * Build and sign a conference descriptor (Section 6.1). Returns it with the
 * bytes to share. It is opened here as a receiver would open it.
 */
export async function createDescriptor (options: {
  id: string, profile: EmbeddingProfile, topicVector: Float32Array, host: PeerId, addrs: string[],
  participantCount: number, capacity: number, admission: AdmissionPolicy,
  createdAt: number, expiresAt: number,
  revision?: number,
  sign: (data: Uint8Array) => Promise<Uint8Array>, now?: number
}): Promise<{ descriptor: ConferenceDescriptor, bytes: Uint8Array }> {
  const now = options.now ?? Date.now()
  const { profile, host } = options
  const revision = options.revision ?? 1
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ConferenceRecordError('malformed', 'revision must be a positive safe integer')
  }
  const encoded = WireDescriptor.encode({
    conferenceId: unhex(options.id),
    namespace: unhex(profile.id),
    profileVersion: profile.version,
    topicVector: encodeVector(options.topicVector),
    host,
    contact: encodeContact(options.addrs),
    participantCount: options.participantCount,
    capacity: options.capacity,
    admission: policyToAdmission(options.admission),
    createdAt: BigInt(options.createdAt),
    expiresAt: BigInt(options.expiresAt),
    revision: BigInt(revision)
  })
  const bytes = SignedDescriptor.encode({ descriptor: encoded, signature: await options.sign(signedBytes(DESCRIPTOR_DOMAIN, encoded)) })
  const descriptor = await openDescriptor(bytes, {
    profile: namespace => namespace === profile.id ? profile : undefined,
    verify: async () => true,
    now
  })
  return { descriptor, bytes }
}

/**
 * Decode and check a descriptor: size, shape, contact, namespace, vector,
 * times and signature. Throws a ConferenceRecordError naming the first fault.
 */
export async function openDescriptor (bytes: Uint8Array, options: {
  profile: (namespace: string) => EmbeddingProfile | undefined,
  verify: (peer: PeerId, data: Uint8Array, signature: Uint8Array) => Promise<boolean>,
  now?: number, maxSkewMs?: number
}): Promise<ConferenceDescriptor> {
  const now = options.now ?? Date.now()
  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS
  if (bytes.length > MAX_DESCRIPTOR_BYTES) throw new ConferenceRecordError('too_large', `${bytes.length} bytes`)
  let signed: SignedDescriptor
  let wire: WireDescriptor
  try {
    signed = SignedDescriptor.decode(bytes)
    wire = WireDescriptor.decode(signed.descriptor)
  } catch {
    throw new ConferenceRecordError('malformed', 'not a signed descriptor')
  }
  if (wire.conferenceId.length !== 16) throw new ConferenceRecordError('malformed', 'conference_id must be 16 bytes')
  if (wire.namespace.length !== 32) throw new ConferenceRecordError('malformed', 'namespace must be 32 bytes')
  if (wire.host === '' || wire.host.length > 128) throw new ConferenceRecordError('malformed', 'host missing or too long')
  if (signed.signature.length === 0 || signed.signature.length > 512) throw new ConferenceRecordError('malformed', 'signature missing or too large')
  if (wire.revision < 1n || wire.revision > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConferenceRecordError('malformed', 'revision must be a positive safe integer')
  }
  if (wire.capacity < 2 || wire.capacity > MAX_CAPACITY) throw new ConferenceRecordError('malformed', `capacity must be 2 to ${MAX_CAPACITY}`)
  if (wire.participantCount < 0 || wire.participantCount > wire.capacity) throw new ConferenceRecordError('malformed', 'participant_count outside capacity')
  const admission = admissionToPolicy(wire.admission)
  if (admission === undefined) throw new ConferenceRecordError('malformed', 'admission is not a known policy')
  const addrs = openContact(wire.contact, wire.host)
  if (addrs === undefined) throw new ConferenceRecordError('malformed', 'contact does not name the host')
  const namespace = hex(wire.namespace)
  const profile = options.profile(namespace)
  if (profile === undefined) throw new ConferenceRecordError('unknown_namespace', 'namespace is not one this service evaluates')
  if (wire.profileVersion !== profile.version) throw new ConferenceRecordError('malformed', 'profile_version does not belong to the namespace')
  let topicVector: Float32Array
  try {
    topicVector = decodeVector(wire.topicVector, profile)
  } catch (error) {
    throw new ConferenceRecordError('bad_vector', (error as Error).message)
  }
  for (const stamp of [wire.createdAt, wire.expiresAt]) {
    if (stamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConferenceRecordError('bad_time', 'time out of range')
  }
  const createdAt = Number(wire.createdAt)
  const expiresAt = Number(wire.expiresAt)
  if (createdAt > now + maxSkewMs) throw new ConferenceRecordError('bad_time', 'created in the future')
  if (expiresAt <= createdAt) throw new ConferenceRecordError('bad_time', 'expiry is not after creation')
  if (expiresAt - createdAt > MAX_DESCRIPTOR_LIFETIME_MS) throw new ConferenceRecordError('bad_time', 'lifetime above 7 days')
  if (expiresAt <= now) throw new ConferenceRecordError('expired', 'lifetime has passed')
  let valid = false
  try {
    valid = await options.verify(wire.host, signedBytes(DESCRIPTOR_DOMAIN, signed.descriptor), signed.signature)
  } catch { /* An origin that is not a usable peer identity cannot have signed anything. */ }
  if (!valid) throw new ConferenceRecordError('bad_signature', 'signature does not verify against host')
  return {
    id: hex(wire.conferenceId), namespace, profileVersion: wire.profileVersion, topicVector,
    host: wire.host, addrs, participantCount: wire.participantCount, capacity: wire.capacity,
    admission, createdAt, expiresAt, revision: Number(wire.revision)
  }
}

export interface ConferenceMessage {
  /** 32 hex. */
  id: string
  /** 32 hex. */
  conferenceId: string
  /** The sending session's public key, 64 hex. */
  sender: string
  /** Milliseconds since the Unix epoch. */
  timestamp: number
  /** Message category, for example 'text'. */
  type: string
  /** Application data. Untrusted peer content. */
  content: Uint8Array
  /** 32 hex, when this answers another message. */
  replyTo?: string
}

/**
 * Build and sign a conference message (Section 8.1). Returns it with the
 * bytes to share. It is opened here as a receiver would open it.
 */
export async function createMessage (options: {
  conferenceId: string, session: Session, type: string, content: Uint8Array, replyTo?: string, now?: number
}): Promise<{ message: ConferenceMessage, bytes: Uint8Array }> {
  const now = options.now ?? Date.now()
  const encoded = WireMessage.encode({
    messageId: crypto.getRandomValues(new Uint8Array(16)),
    conferenceId: unhex(options.conferenceId),
    sender: unhex(options.session.key),
    timestamp: BigInt(now),
    type: options.type,
    content: options.content,
    replyTo: options.replyTo === undefined ? undefined : unhex(options.replyTo)
  })
  const bytes = SignedMessage.encode({ message: encoded, signature: await options.session.sign(signedBytes(MESSAGE_DOMAIN, encoded)) })
  const message = await openMessage(bytes, { now })
  return { message, bytes }
}

/**
 * Decode and check a conference message: size, shape, times and signature.
 * It does NOT check that the sender belongs to the conference: it has no
 * roster. The caller does that. Throws a ConferenceRecordError naming the
 * first fault.
 */
export async function openMessage (bytes: Uint8Array, options: { now?: number, maxSkewMs?: number } = {}): Promise<ConferenceMessage> {
  const now = options.now ?? Date.now()
  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS
  if (bytes.length > MAX_SIGNED_MESSAGE_BYTES) throw new ConferenceRecordError('too_large', `${bytes.length} bytes`)
  let signed: SignedMessage
  let wire: WireMessage
  try {
    signed = SignedMessage.decode(bytes)
    wire = WireMessage.decode(signed.message)
  } catch {
    throw new ConferenceRecordError('malformed', 'not a signed message')
  }
  if (wire.messageId.length !== 16) throw new ConferenceRecordError('malformed', 'message_id must be 16 bytes')
  if (wire.conferenceId.length !== 16) throw new ConferenceRecordError('malformed', 'conference_id must be 16 bytes')
  if (wire.sender.length !== 32) throw new ConferenceRecordError('malformed', 'sender must be 32 bytes')
  if (signed.signature.length === 0 || signed.signature.length > 512) throw new ConferenceRecordError('malformed', 'signature missing or too large')
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(wire.type)) throw new ConferenceRecordError('malformed', 'type is not a message category')
  if (wire.content.length < 1 || wire.content.length > MAX_MESSAGE_CONTENT_BYTES) throw new ConferenceRecordError('malformed', 'content has no acceptable length')
  if (wire.replyTo !== undefined && wire.replyTo.length !== 16) throw new ConferenceRecordError('malformed', 'reply_to must be 16 bytes')
  if (wire.timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConferenceRecordError('bad_time', 'timestamp out of range')
  const timestamp = Number(wire.timestamp)
  if (timestamp > now + maxSkewMs) throw new ConferenceRecordError('bad_time', 'sent in the future')
  const sender = hex(wire.sender)
  let valid = false
  try {
    valid = await verifySession(sender, signedBytes(MESSAGE_DOMAIN, signed.message), signed.signature)
  } catch {
    valid = false
  }
  if (!valid) throw new ConferenceRecordError('bad_signature', 'signature does not verify against sender')
  const message: ConferenceMessage = {
    id: hex(wire.messageId), conferenceId: hex(wire.conferenceId), sender, timestamp,
    type: wire.type, content: wire.content
  }
  if (wire.replyTo !== undefined) message.replyTo = hex(wire.replyTo)
  return message
}
