import type { Embedder, GossipEvent, PeerId, Tier, Transport } from '../types.ts'
import { AnnouncementError, createAnnouncement, expiresAt, openAnnouncement } from './announcement.ts'
import type { Announcement } from './announcement.ts'
import { openDescriptor } from './conference-records.ts'
import type { ConferenceDescriptor } from './conference-records.ts'
import { OpenInterests, SeenAnnouncements } from './interests.ts'
import type { OpenInterest, OpenInterestsOptions } from './interests.ts'
import { DiscoveryPacket } from './proto/discovery.ts'
import { encodeContact, openContact } from './contact.ts'
import { announceTopic } from './topics.ts'
import { compareCandidates, matchTier, resolveThresholds } from '../embed/match.ts'
import { similarity } from '../embed/vector.ts'

/** A record another service holds that matches one of this service's open interests. */
export interface MatchCommon {
  /** This service's announcement id that was answered. */
  interest: string
  /** The local agent session holding that interest. */
  session: string
  /** The responder. Equal to the record's origin or host. */
  peer: PeerId
  /** Where the responder can be dialed, from the record's contact. */
  addrs: string[]
  /** Recomputed here from the record's vector; the responder's claim is not used. */
  tier: Tier
  /** Cosine similarity at the profile's full length, computed here. */
  fullScore: number
}

export type MatchFound = MatchCommon & (
  | { kind: 'interest', record: Announcement }
  | { kind: 'conference', record: ConferenceDescriptor }
)

export type MatchRecord = { kind: 'interest', record: Announcement } | { kind: 'conference', record: ConferenceDescriptor }

export function recordVector (match: MatchRecord): Float32Array {
  return match.kind === 'interest' ? match.record.vector : match.record.topicVector
}

export function recordExpiry (match: MatchRecord): number {
  return match.kind === 'interest' ? expiresAt(match.record) : match.record.expiresAt
}

export interface DiscoveryOptions {
  transport: Transport
  embedder: Embedder
  /** Called once for each match newly retained. */
  onMatch: (match: MatchFound) => void
  /** Local thresholds laid over the profile's defaults (resolveThresholds). */
  thresholds?: Record<number, number>
  /** Disclosure policy hook: throws to refuse a statement. Default allows everything. */
  checkOutbound?: (statement: string) => void | Promise<void>
  now?: () => number
  /** Seconds. Default 300. */
  defaultTtl?: number
  /** Most records this service returns for one announcement. Default 3. */
  maxResultsPerAnnouncement?: number
  /** Most matches kept for one of its own interests. Default 8. */
  maxMatchesPerInterest?: number
  /** Most announcements accepted from one origin in any 60 seconds. Default 6. */
  announcementsPerOriginPerMinute?: number
  /**
   * Milliseconds to collect newly retained matches before notifying, so a
   * stronger arrival can displace a weaker one before any callback. Integer
   * 0 to 60000, default 500. Zero keeps immediate callbacks.
   */
  matchWindowMs?: number
  /** Already signed public metadata for locally hosted conferences. */
  conferences?: () => { descriptor: ConferenceDescriptor, bytes: Uint8Array }[]
  interests?: OpenInterestsOptions
}

/** Hex of bytes, lowercase (Section 4.2). */
export function hex (bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Raw bytes of 32 hex characters. Throws on bad input. */
export function unhex (text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('not lowercase hexadecimal')
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16))
}

