/**
 * The announcement of Section 4.2: built and signed by its origin, and opened
 * by every receiver before anything in it is used.
 *
 * Nothing here imports a Node built-in: the core runs in browsers.
 */
import { decodeVector, encodeVector } from '../embed/vector.ts'
import type { EmbeddingProfile, PeerId } from '../types.ts'
import { Announcement as Wire, SignedAnnouncement } from './proto/discovery.ts'

/** Largest signed announcement accepted. A 768-dimension vector is 3,072 bytes of it. */
export const MAX_ANNOUNCEMENT_BYTES = 16384
export const MAX_STATEMENT_BYTES = 4096
export const MAX_CONTACT_BYTES = 2048
/** Seconds. A match against an agent that never returns is the common failure, so lifetimes are short (Section 4.3). */
export const DEFAULT_MAX_TTL = 3600
/** Allowance for the origin's clock running ahead of ours. */
export const DEFAULT_MAX_SKEW_MS = 120000

/** Kept apart from every other use of the identity key. Changes with the wire format. */
const DOMAIN = new TextEncoder().encode('vortex-announcement:1\n')

export interface Announcement {
  /** 32 hexadecimal characters. */
  id: string
  /** The profile hash, 64 hexadecimal characters. */
  namespace: string
  profileVersion: number
  /** The full vector, valid under the namespace's profile. */
  vector: Float32Array
  /** The peer identity that signed this. */
  origin: PeerId
  /** Encoded Contact (dial addresses), covered by this announcement's signature; callers validate it with openContact (contact.ts). */
  contact: Uint8Array
  /** Milliseconds since the Unix epoch. */
  issuedAt: number
  /** Seconds from `issuedAt`. */
  ttl: number
  /** Peer-authored text when present. Untrusted. */
  statement?: string
}

/** Why an announcement was refused. `unknown_namespace` is no fault of the sender. */
export type AnnouncementFault =
  'too_large' | 'malformed' | 'unknown_namespace' | 'bad_vector' | 'bad_time' | 'expired' | 'bad_signature'

export class AnnouncementError extends Error {
  readonly fault: AnnouncementFault
  constructor (fault: AnnouncementFault, detail: string) {
    super(`announcement refused: ${detail}`)
    this.fault = fault
  }
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

function unhex (text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('not lowercase hexadecimal')
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

function signedBytes (announcement: Uint8Array): Uint8Array {
  const out = new Uint8Array(DOMAIN.length + announcement.length)
  out.set(DOMAIN)
  out.set(announcement, DOMAIN.length)
  return out
}

export interface CreateOptions {
  profile: EmbeddingProfile
  /** As the embedder returned it. */
  vector: Float32Array
  origin: PeerId
  contact: Uint8Array
  /** Seconds. */
  ttl: number
  /** Included only when the agent asked for it and policy permitted. */
  statement?: string
  /** Signs with the key of `origin`. */
  sign: (data: Uint8Array) => Promise<Uint8Array>
  now?: number
}

/**
 * Build and sign an announcement. Returns it with the bytes to publish. It is
 * opened here as a receiver would open it, so nothing is published that a
 * receiver holding the same limits would refuse.
 */
export async function createAnnouncement (options: CreateOptions): Promise<{ announcement: Announcement, bytes: Uint8Array }> {
  const { profile, origin, contact, ttl, statement, sign } = options
  const now = options.now ?? Date.now()
  const encoded = Wire.encode({
    announcementId: crypto.getRandomValues(new Uint8Array(16)),
    namespace: unhex(profile.id),
    profileVersion: profile.version,
    vector: encodeVector(options.vector),
    origin,
    contact,
    issuedAt: BigInt(now),
    ttl,
    statement
  })
  const bytes = SignedAnnouncement.encode({ announcement: encoded, signature: await sign(signedBytes(encoded)) })
  const announcement = await openAnnouncement(bytes, {
    profile: namespace => namespace === profile.id ? profile : undefined,
    // The signature was made a moment ago by the caller's own key.
    verify: async () => true,
    now
  })
  return { announcement, bytes }
}

export interface OpenOptions {
  /** The profile for a namespace this service can evaluate, or undefined. */
  profile: (namespace: string) => EmbeddingProfile | undefined
  /** Checks a signature against the key embedded in a peer identity. */
  verify: (peer: PeerId, data: Uint8Array, signature: Uint8Array) => Promise<boolean>
  now?: number
  maxSkewMs?: number
  /** Seconds. */
  maxTtl?: number
}

/**
 * Decode and check a received announcement: size, shape, namespace, vector,
 * times and signature. Throws an AnnouncementError naming the first fault.
 * The caller still has to check that `origin` is the peer that published it.
 */
export async function openAnnouncement (bytes: Uint8Array, options: OpenOptions): Promise<Announcement> {
  const now = options.now ?? Date.now()
  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS
  const maxTtl = options.maxTtl ?? DEFAULT_MAX_TTL
  if (bytes.length > MAX_ANNOUNCEMENT_BYTES) throw new AnnouncementError('too_large', `${bytes.length} bytes`)

  let signed: SignedAnnouncement
  let wire: Wire
  try {
    signed = SignedAnnouncement.decode(bytes)
    wire = Wire.decode(signed.announcement)
  } catch {
    throw new AnnouncementError('malformed', 'not a signed announcement')
  }
  if (wire.announcementId.length !== 16) throw new AnnouncementError('malformed', 'announcement_id must be 16 bytes')
  if (wire.namespace.length !== 32) throw new AnnouncementError('malformed', 'namespace must be 32 bytes')
  if (wire.origin === '' || wire.origin.length > 128) throw new AnnouncementError('malformed', 'origin missing or too long')
  if (wire.contact.length === 0 || wire.contact.length > MAX_CONTACT_BYTES) throw new AnnouncementError('malformed', 'contact missing or too large')
  if (signed.signature.length === 0 || signed.signature.length > 512) throw new AnnouncementError('malformed', 'signature missing or too large')
  if (wire.statement !== undefined && new TextEncoder().encode(wire.statement).length > MAX_STATEMENT_BYTES) {
    throw new AnnouncementError('malformed', `statement above ${MAX_STATEMENT_BYTES} bytes`)
  }

  const namespace = hex(wire.namespace)
  const profile = options.profile(namespace)
  if (profile === undefined) throw new AnnouncementError('unknown_namespace', 'namespace is not one this service evaluates')
  if (wire.profileVersion !== profile.version) throw new AnnouncementError('malformed', 'profile_version does not belong to the namespace')
  let vector: Float32Array
  try {
    vector = decodeVector(wire.vector, profile)
  } catch (error) {
    throw new AnnouncementError('bad_vector', (error as Error).message)
  }

  if (wire.issuedAt > BigInt(Number.MAX_SAFE_INTEGER)) throw new AnnouncementError('bad_time', 'issued_at out of range')
  const issuedAt = Number(wire.issuedAt)
  if (wire.ttl < 1 || wire.ttl > maxTtl) throw new AnnouncementError('bad_time', `ttl must be 1 to ${maxTtl} seconds`)
  if (issuedAt > now + maxSkewMs) throw new AnnouncementError('bad_time', 'issued in the future')
  if (issuedAt + wire.ttl * 1000 <= now) throw new AnnouncementError('expired', 'lifetime has passed')

  let valid = false
  try {
    valid = await options.verify(wire.origin, signedBytes(signed.announcement), signed.signature)
  } catch { /* An origin that is not a usable peer identity cannot have signed anything. */ }
  if (!valid) throw new AnnouncementError('bad_signature', 'signature does not verify against origin')

  const announcement: Announcement = {
    id: hex(wire.announcementId),
    namespace,
    profileVersion: wire.profileVersion,
    vector,
    origin: wire.origin,
    contact: wire.contact,
    issuedAt,
    ttl: wire.ttl
  }
  if (wire.statement !== undefined) announcement.statement = wire.statement
  return announcement
}

/** Milliseconds since the Unix epoch at which an announcement stops being live. */
export function expiresAt (announcement: Announcement): number {
  return announcement.issuedAt + announcement.ttl * 1000
}
