import type { EmbeddingProfile } from '../types.ts';
import {
  checkPeerMemoryRecord, checkPeerMemorySubject, findPeerOutcome, peerMemoryIdentityKey, peerMemoryRecordBytes,
  prunePeerMemoryEntries, validatePeerMemoryLimits,
  type PeerMemoryLimits, type PeerMemoryRecord, type PeerMemorySubject, type PeerOutcome
} from './peer-memory.ts';

export type Packet =
  | { kind: 'invite'; room: string }
  | { kind: 'accept'; room: string }
  | { kind: 'message'; room: string; id: string; body: string };
export type Room = { peer: string; localConsent: boolean; remoteConsent: boolean };
export type ConferenceKind = 'formed' | 'arrival' | 'departure' | 'conference_message' | 'closed';
export type ConferenceRecord = { kind: ConferenceKind; conference: string; session: string; peer: string;
  participant?: string; service?: string; count?: number; message?: string; type?: string; replyTo?: string; reason?: string; body?: string; backlog?: boolean };
export const conferenceKinds: readonly string[] = ['formed', 'arrival', 'departure', 'conference_message', 'closed'];
export const CONTROL_EVENT_KINDS: ReadonlySet<string> = new Set(['match', 'invitation', 'accepted', 'formed', 'arrival', 'departure', 'closed']);
export function isControlEventKind (kind: string): boolean { return CONTROL_EVENT_KINDS.has(kind); }
export type Event = { cursor: number; kind: 'invitation' | 'accepted' | 'message' | 'match' | ConferenceKind; room: string;
  peer: string; body?: string; interest?: string; tier?: 'exact' | number; score?: number; fullScore?: number;
  addrs?: string[]; statement?: string; record?: string; recordKind?: 'interest' | 'conference'; conference?: string; session?: string;
  participant?: string; service?: string; count?: number; message?: string; type?: string; replyTo?: string; reason?: string;
  /** True when this conference message was delivered from retained history rather than live. */
  backlog?: boolean;
  /** A direct message that topic routing matched to one of this owner's conferences. Routing is not membership. */
  routingConference?: string; trust: 'untrusted_peer_content' };
export type Snapshot = { rooms: Record<string, Room>; events: Event[]; seen: string[]; cursor: number; acked?: number;
  /** Cursors above `acked` that a session-scoped ack already handled, ascending. */
  handled?: number[];
  seenAt?: Record<string, number>; subscriptions?: Record<string, RoomSubscription>; peerMemory?: PeerMemoryRecord[] };
export type RoomSubscription = { id: string; conference: string; session: string;
  host: string; expires: number; historyCursor: number;
  membership?: { descriptor: string; privateKey: string };
  /** Original query sibling of membership, private-only. Never listed. */
  subject?: PeerMemorySubject };
export type ConversationRetention = { historyLimit?: number; dedupLimit?: number };
export type MessageRouting = { conference: string; tier: 'exact' | number; score: number };
export interface ConversationIO {
  send(peer: string, packet: Packet): Promise<void>;
  save(state: Snapshot): void | Promise<void>;
  /**
   * Optional topic routing for an unlabelled direct message: the receiver's
   * conference it belongs to, or undefined for a new topic. A rejection or a
   * malformed answer delivers the plain message; routing never drops mail.
   */
  route?(peer: string, body: string): Promise<MessageRouting | undefined>;
}

/** Moves the watermark across a contiguous handled run and drops handled cursors it passed. */
export function settle(draft: Snapshot): void {
  if (draft.handled === undefined) return;
  const handled = new Set(draft.handled);
  let acked = draft.acked ?? 0;
  for (const e of draft.events) {
    if (e.cursor <= acked) continue;
    if (!handled.has(e.cursor)) break;
    acked = e.cursor;
  }
  if (acked !== (draft.acked ?? 0)) draft.acked = acked;
  draft.handled = draft.handled.filter(c => c > acked);
  if (!draft.handled.length) delete draft.handled;
}


export function checkConferenceRecord(event: ConferenceRecord): void {
  const { kind, conference, session, peer, participant, service, count, message, type, replyTo, reason, body, backlog } = event;
  const hex = (value: unknown, length: number): boolean => typeof value === 'string' &&
    value.length === length && /^[0-9a-f]+$/.test(value);
  if (!conferenceKinds.includes(kind) || !hex(conference, 32) ||
    typeof session !== 'string' || !session || typeof peer !== 'string' || !peer ||
    (participant !== undefined && !hex(participant, 64)) ||
    (service !== undefined && (typeof service !== 'string' || !service)) ||
    (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) ||
    (message !== undefined && !hex(message, 32)) || (replyTo !== undefined && !hex(replyTo, 32)) ||
    (type !== undefined && (typeof type !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(type))) ||
    (reason !== undefined && typeof reason !== 'string') ||
    (body !== undefined && (typeof body !== 'string' || new TextEncoder().encode(body).length > 16384)))
    throw new Error('invalid conference event');
}

export function pushConferenceRecord(draft: Snapshot,
  event: ConferenceRecord,
  append: (kind: Event['kind'], room: string, peer: string, body: string | undefined,
    extra: Partial<Omit<Event, 'cursor' | 'kind' | 'room' | 'peer' | 'body' | 'trust'>>) => void): boolean {
  const { kind, conference, session, peer, participant, service, count, message, type, replyTo, reason, body, backlog } = event;
  const extra = { conference, session,
    ...(participant === undefined ? {} : { participant }), ...(service === undefined ? {} : { service }),
    ...(count === undefined ? {} : { count }), ...(message === undefined ? {} : { message }),
    ...(type === undefined ? {} : { type }), ...(replyTo === undefined ? {} : { replyTo }),
    ...(reason === undefined ? {} : { reason }), ...(backlog === undefined ? {} : { backlog }) };
  if (kind === 'conference_message' && message !== undefined) {
    const key = JSON.stringify(['conference', conference, message]);
    if (draft.seen.includes(key)) return false;
    draft.seen.push(key);
    append(kind, 'conference:' + conference, peer, body, extra);
    draft.seenAt ??= {};
    draft.seenAt[key] = draft.cursor;
    return true;
  }
  append(kind, 'conference:' + conference, peer, body, extra);
  return true;
}

export function checkMembership (membership: { descriptor: string, privateKey: string } | undefined): void {
  const hexed = (value: unknown, max: number): boolean => typeof value === 'string' && value.length > 0 &&
    value.length % 2 === 0 && value.length <= max && /^[0-9a-f]+$/.test(value);
  if (membership === undefined || !hexed(membership.descriptor, 32768) || !hexed(membership.privateKey, 1024)) {
    throw new Error('invalid subscription membership');
  }
}

export function checkSubscriptionInput(input: { conference: string; session: string; host: string; expires: number;
  membership?: { descriptor: string; privateKey: string } }, maxCount: number): void {
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 128) throw new Error('invalid subscription limit');
  if (!/^[0-9a-f]{32}$/.test(input.conference)) throw new Error('invalid subscription conference');
  if (typeof input.session !== 'string' || input.session.length < 1 || input.session.length > 128) {
    throw new Error('invalid subscription session');
  }
  if (typeof input.host !== 'string' || input.host.length < 1 || input.host.length > 128) {
    throw new Error('invalid subscription host');
  }
  if (!Number.isSafeInteger(input.expires) || input.expires <= 0) throw new Error('invalid subscription expiry');
  if (input.membership !== undefined) {
    checkMembership(input.membership);
  }
}

/** Exact agreement across all four subject fields. */
export function sameSubject (left: PeerMemorySubject | undefined, right: PeerMemorySubject | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.statement === right.statement && left.vector === right.vector &&
    left.namespace === right.namespace && left.profileVersion === right.profileVersion;
}

export function newSubscriptionId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through to hex */ }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

