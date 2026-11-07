import type { Embedder, PeerId, Transport, TransportInfo } from '../types.ts';
import { Conversations } from './conversations.ts';
import type { ConversationRetention, MessageRouting, RoomSubscription, Snapshot } from './conversations.ts';
import { routeToConference, routingThresholds } from './routing.ts';
import { openDescriptor } from './conference-records.ts';
import { Conferences, ConferenceRoomUnknownError, validateConferenceCreationOptions } from './conferences.ts';
import { encodeVector, isValidVector } from '../embed/vector.ts';
import { checkPeerMemorySubject, validatePeerMemoryLimits } from './peer-memory.ts';
import type { PeerMemoryRecord, PeerMemorySubject } from './peer-memory.ts';
import type { ConferenceCreationOptions, ConferenceEvent, ConferenceInfo, ConferencesOptions } from './conferences.ts';
import { Discovery } from './discovery.ts';
import type { DiscoveryOptions, MatchFound } from './discovery.ts';
import { DisclosureError } from './disclosure.ts';
import type { DisclosureCheck } from './disclosure.ts';

export const TOPIC = '/vortex/local-discovery/1';
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export type Peer = { id: string; name: string; interest: string; addrs: string[]; expires: number;
  trust: 'untrusted_peer_content' };
export const notEnabled = 'semantic discovery is not enabled: start the service with --semantic';
export type ConferenceInfoOut = Omit<ConferenceInfo, 'descriptor'> & { count: number; capacity: number; expires: number; admission: 'open' | 'invitation' | 'group'; revision: number };
export const conferenceOut = (info: ConferenceInfo): ConferenceInfoOut => ({ id: info.id, role: info.role,
  session: info.session, key: info.key, host: info.host, participants: [...info.participants],
  count: info.descriptor.participantCount, capacity: info.descriptor.capacity, expires: info.descriptor.expiresAt, admission: info.descriptor.admission, revision: info.descriptor.revision });
export interface ServiceOptions {
  disclosure?: DisclosureCheck;
  retention?: ConversationRetention;
  conferences?: Partial<Pick<ConferencesOptions, 'capacity' | 'maxHosted' | 'maxJoined' | 'lifetimeMs' | 'historyLimit' | 'historyBytes'>>;
  embedder?: Embedder;
  onError?: (message: string) => void;
  discovery?: Partial<Pick<DiscoveryOptions, 'thresholds' | 'defaultTtl' | 'maxResultsPerAnnouncement' |
    'maxMatchesPerInterest' | 'announcementsPerOriginPerMinute' | 'interests' | 'now'>>;
  subscriptions?: { maxCount?: number; maxTtl?: number };
  peerMemory?: { ttl?: number; maxCount?: number; maxBytes?: number };
}
export type ConferenceFeedbackOutcome = 'useful' | 'neutral' | 'misleading';
export interface ConferenceFeedback {
  outcomes: { participant: string, outcome: ConferenceFeedbackOutcome }[];
  statement?: string;
}
export type PublicSubscription = { conference: string; session: string; host: string; expires: number; historyCursor: number };
export const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const unhexBytes = (text: string): Uint8Array => {
  if (typeof text !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('invalid cached membership');
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16));
};
export class SaveError extends Error {}

