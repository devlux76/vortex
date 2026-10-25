/**
 * Private durable peer-outcome memory (Sections 5.5 and 10.7): which certified
 * peers proved useful on which subjects. Browser-safe pure helpers only; the
 * Conversations store owns persistence. Nothing here ever sends, publishes or
 * summarizes: later service code reads outcomes to rank candidates.
 */
import { peerIdFromString } from '@libp2p/peer-id'
import type { EmbeddingProfile } from '../types.ts'
import { decodeVector, isValidVector } from '../embed/vector.ts'
import { matchTier } from '../embed/match.ts'

export type PeerOutcome = 'useful' | 'neutral' | 'misleading'

const OUTCOMES: readonly string[] = ['useful', 'neutral', 'misleading']

export interface PeerMemoryRecord {
  /** Certifying service peer identity, canonical string form. */
  peer: string
  /** Subject session public key, 64 lowercase hex characters. */
  participant: string
  /** Embedding profile id, 64 lowercase hex characters. */
  namespace: string
  profileVersion: number
  statement: string
  /** float32LE vector bytes as lowercase hex: at most 32768 chars, a multiple of 8. */
  vector: string
  outcome: PeerOutcome
  /** Milliseconds since the Unix epoch. */
  recordedAt: number
  /** Milliseconds since the Unix epoch, after recordedAt. */
  expires: number
}

/** The original query behind a membership: statement, vector, namespace and version. */
export interface PeerMemorySubject {
  statement: string
  /** float32LE vector bytes as lowercase hex: at most 32768 chars, a multiple of 8. */
  vector: string
  /** Embedding profile id, 64 lowercase hex characters. */
  namespace: string
  profileVersion: number
}

export interface PeerMemoryLimits {
  maxCount?: number
  maxBytes?: number
}

/** Private local defaults: operator policy, never protocol constants. */
export const DEFAULT_PEER_MEMORY_LIMITS: Required<PeerMemoryLimits> = { maxCount: 128, maxBytes: 8388608 }

/** Largest batch accepted in one call. Larger batches are refused outright. */
export const MAX_PEER_MEMORY_BATCH = 256

const hexed = (value: unknown, length: number, max: number): boolean =>
  typeof value === 'string' && value.length === length && value.length <= max && /^[0-9a-f]+$/.test(value)

/** Structural validation of a subject; never echoes its text. */
export function checkPeerMemorySubject (subject: PeerMemorySubject): void {
  if (subject === undefined || subject === null || typeof subject !== 'object') throw new Error('invalid peer subject')
  if (!hexed(subject.namespace, 64, 64)) throw new Error('invalid peer subject')
  if (!Number.isSafeInteger(subject.profileVersion) || subject.profileVersion < 1) {
    throw new Error('invalid peer subject')
  }
  if (typeof subject.statement !== 'string' || subject.statement.length < 1 ||
    new TextEncoder().encode(subject.statement).length > 4096) {
    throw new Error('invalid peer subject')
  }
  try {
    checkPeerMemoryVector(subject.vector)
  } catch {
    throw new Error('invalid peer subject')
  }
}

/** Structural validation only; actual participation is verified by the trusted service. */
export function checkPeerMemoryRecord (record: PeerMemoryRecord): void {
  if (record === undefined || typeof record !== 'object') throw new Error('invalid peer memory record: not an object')
  try {
    if (peerIdFromString(record.peer).toString() !== record.peer) throw new Error('peer is not canonical')
  } catch {
    throw new Error('invalid peer memory record: peer')
  }
  if (!hexed(record.participant, 64, 64)) throw new Error('invalid peer memory record: participant')
  try {
    checkPeerMemorySubject({ statement: record.statement, vector: record.vector,
      namespace: record.namespace, profileVersion: record.profileVersion })
  } catch {
    throw new Error('invalid peer memory record: subject')
  }
  if (!OUTCOMES.includes(record.outcome)) throw new Error('invalid peer memory record: outcome')
  if (!Number.isSafeInteger(record.recordedAt) || record.recordedAt < 0) {
    throw new Error('invalid peer memory record: recordedAt')
  }
  if (!Number.isSafeInteger(record.expires) || record.expires <= record.recordedAt) {
    throw new Error('invalid peer memory record: expires')
  }
}

function checkPeerMemoryVector (vector: string): void {
  if (typeof vector !== 'string' || vector.length < 8 || vector.length % 8 !== 0 ||
    vector.length > 32768 || !/^[0-9a-f]+$/.test(vector)) {
    throw new Error('invalid peer memory record: vector')
  }
  const bytes = Uint8Array.from(vector.match(/../g) as string[], pair => parseInt(pair, 16))
  const view = new DataView(bytes.buffer)
  let nonZero = false
  for (let at = 0; at < bytes.length; at += 4) {
    const component = view.getFloat32(at, true)
    if (!Number.isFinite(component)) throw new Error('invalid peer memory record: vector')
    if (component !== 0) nonZero = true
  }
  if (!nonZero) throw new Error('invalid peer memory record: vector')
}

export function validatePeerMemoryLimits (limits?: PeerMemoryLimits): Required<PeerMemoryLimits> {
  const maxCount = limits?.maxCount ?? DEFAULT_PEER_MEMORY_LIMITS.maxCount
  const maxBytes = limits?.maxBytes ?? DEFAULT_PEER_MEMORY_LIMITS.maxBytes
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 4096 ||
    !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 67108864) {
    throw new Error('invalid peer memory limits: maxCount 1 to 4096, maxBytes 1 to 67108864')
  }
  return { maxCount, maxBytes }
}

/** Renewal identity: peer, participant, namespace and vector. Other fields overwrite. */
export function peerMemoryIdentityKey (record: PeerMemoryRecord): string {
  return JSON.stringify([record.peer, record.participant, record.namespace, record.vector])
}

/** Serialized size of one record for operator bound accounting. */
export function peerMemoryRecordBytes (record: PeerMemoryRecord): number {
  return new TextEncoder().encode(JSON.stringify(record)).length
}

/** Drop expired entries, then oldest committed first, until count and bytes fit. */
export function prunePeerMemoryEntries (entries: PeerMemoryRecord[], limits: Required<PeerMemoryLimits>, now?: number): PeerMemoryRecord[] {
  const at = now ?? Date.now()
  const kept = entries.filter(entry => entry.expires > at)
  let bytes = kept.reduce((sum, entry) => sum + peerMemoryRecordBytes(entry), 0)
  while ((kept.length > limits.maxCount || bytes > limits.maxBytes) && kept.length > 0) {
    const removed = kept.shift()!
    bytes -= peerMemoryRecordBytes(removed)
  }
  return kept
}

/**
 * The latest committed outcome for a peer on a subject, same namespace only.
 * Unknown peers, expired or unmatched entries, and malformed restored entries
 * all score neutral, without leaking their content.
 */
export function findPeerOutcome (records: PeerMemoryRecord[], peer: string, subjectVector: Float32Array,
  profile: EmbeddingProfile, thresholds?: Record<number, number>, now?: number): PeerOutcome {
  if (!(subjectVector instanceof Float32Array) || !isValidVector(subjectVector, profile)) {
    throw new Error('peer memory subject vector is not valid under the profile')
  }
  const at = now ?? Date.now()
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    try {
      checkPeerMemoryRecord(record)
      if (record.peer !== peer || record.namespace !== profile.id || record.expires <= at) continue
      const stored = decodeVector(Uint8Array.from(record.vector.match(/../g) as string[],
        pair => parseInt(pair, 16)), profile)
      if (matchTier(stored, subjectVector, profile, thresholds ?? profile.thresholds) === null) continue
      return record.outcome
    } catch {
      continue
    }
  }
  return 'neutral'
}
