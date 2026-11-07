import type { EmbeddingProfile } from '../types.ts';
import {
  checkPeerMemoryRecord, checkPeerMemorySubject, findPeerOutcome, peerMemoryIdentityKey, peerMemoryRecordBytes,
  prunePeerMemoryEntries, validatePeerMemoryLimits,
  type PeerMemoryLimits, type PeerMemoryRecord, type PeerMemorySubject, type PeerOutcome
} from './peer-memory.ts';
import type { Conversations } from './conversations.ts'
import { type Packet, type Room, type ConferenceKind, type ConferenceRecord, conferenceKinds, CONTROL_EVENT_KINDS, isControlEventKind, type Event, type Snapshot, type RoomSubscription, type ConversationRetention, type MessageRouting, type ConversationIO, settle, checkConferenceRecord, pushConferenceRecord, checkMembership, checkSubscriptionInput, sameSubject, newSubscriptionId } from './conversations-types.ts'

export function roomFor (cv: Conversations, peer: string): string {
  if (!peer || peer === cv.self) throw new Error('invalid peer');
  return JSON.stringify([cv.self, peer].sort());
}

export function notice (cv: Conversations): {cursor:number;unread:number} {
  return {cursor:cv.state.cursor,unread:unreadEvents(cv).length};
}

export function unreadEvents (cv: Conversations): Event[] {
  const acked = cv.state.acked ?? 0, handled = new Set(cv.state.handled);
  return cv.state.events.filter(e => e.cursor > acked && !handled.has(e.cursor));
}

export function unreadTopics (cv: Conversations): Pick<Event, 'cursor' | 'conference' | 'routingConference' | 'session'>[] {
  return unreadEvents(cv).map(({ cursor, conference, routingConference, session }) =>
    ({ cursor, ...(conference === undefined ? {} : { conference, session }),
      ...(routingConference === undefined ? {} : { routingConference }) }));
}

export function head (cv: Conversations): Pick<Event, 'cursor' | 'conference' | 'routingConference' | 'session'> | undefined {
  return unreadTopics(cv)[0];
}

export function notificationState (cv: Conversations): { acked: number; waiters: number; rooms: { room: string; unread: number; oldest: number; hasData: boolean }[] } {
  const acked=cv.state.acked ?? 0;
  const rooms=new Map<string,{room:string;unread:number;oldest:number;hasData:boolean}>();
  for(const event of unreadEvents(cv)) {
    // A match is this service's own discovery product, not a peer's say-so: no consent check.
    if(event.kind!=='match' && !conferenceKinds.includes(event.kind)) {
      const consent=cv.state.rooms[event.room];
      if(!consent?.localConsent || !consent.remoteConsent) continue;
    }
    const isControl = CONTROL_EVENT_KINDS.has(event.kind);
    const record=rooms.get(event.room);
    if(record) { record.unread++; if(!isControl) record.hasData = true; }
    else rooms.set(event.room,{room:event.room,unread:1,oldest:event.cursor,hasData:!isControl});
  }
  return {acked,waiters:cv.waiting,rooms:[...rooms.values()]};
}

export function read (cv: Conversations, after?: number, only?: (event: Event) => boolean): { events: Event[]; cursor: number } {
  const from = after ?? cv.state.acked ?? 0;
  if (!Number.isSafeInteger(from) || from < 0 || from > cv.state.cursor) throw new Error('invalid cursor');
  const events = (after === undefined ? unreadEvents(cv) : cv.state.events.filter(e => e.cursor > after))
    .filter(e => only === undefined || only(e)).slice(0, 100);
  return { events: structuredClone(events), cursor: events.at(-1)?.cursor ?? from };
}

export function ack (cv: Conversations, cursor: number, only?: (event: Event) => boolean): Promise<void> {
  if (!Number.isSafeInteger(cursor) || cursor < (cv.state.acked ?? 0) || cursor > cv.state.cursor)
    throw new Error('invalid acknowledgment cursor');
  return mutate(cv, draft => {
    if (!Number.isSafeInteger(cursor) || cursor < (draft.acked ?? 0) || cursor > draft.cursor)
      throw new Error('invalid acknowledgment cursor');
    if (only === undefined) draft.acked = cursor;
    else {
      const handled = new Set(draft.handled);
      for (const e of draft.events) if (e.cursor > (draft.acked ?? 0) && e.cursor <= cursor && only(e)) handled.add(e.cursor);
      draft.handled = [...handled].sort((x, y) => x - y);
    }
    settle(draft);
  });
}

export function onEvents (cv: Conversations, handler: () => void): () => void {
  cv.listeners.add(handler);
  return () => { cv.listeners.delete(handler); };
}

export function onChange (cv: Conversations, handler: () => void): () => void {
  cv.changes.add(handler);
  return () => { cv.changes.delete(handler); };
}

export function wait (cv: Conversations, after?: number, timeoutMs = 30000, signal?: AbortSignal): Promise<{ events: Event[]; cursor: number; nudged?: true }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return Promise.reject(new Error('wait timeout must be 1–60000 ms'));
  signal?.throwIfAborted();
  const page=read(cv, after);
  if (page.events.length) return Promise.resolve(page);
  return new Promise((resolve,reject) => {
    cv.waiting++;
    const finish=(error?: Error, nudged?: boolean) => {
      clearTimeout(timer); off(); signal?.removeEventListener('abort',aborted); cv.waiting--;
      cv.nudgers.delete(release);
      if (error) reject(error);
      else resolve(nudged ? { ...read(cv, after), nudged: true as const } : read(cv, after));
      cv.changed();
    };
    const release=() => { finish(undefined, true); };
    cv.nudgers.add(release);
    const aborted=() => { finish(new Error('wait canceled')); };
    const off=onEvents(cv, () => { if (read(cv, after).events.length) finish(); });
    const timer=setTimeout(() => { finish(new Error('wait timed out')); },timeoutMs);
    signal?.addEventListener('abort',aborted,{once:true});
    cv.changed();
  });
}

export function nudge (cv: Conversations): number {
  const pending=[...cv.nudgers];
  cv.nudgers.clear();
  for(const release of pending) release();
  return pending.length;
}

export function mutate (cv: Conversations, apply: (draft: Snapshot) => boolean | void): Promise<void> {
  return cv.enqueue(async () => {
    const draft = structuredClone(cv.state);
    if (apply(draft) === false) return;
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
  });
}

export function prune (cv: Conversations, draft: Snapshot): void {
  const acked = draft.acked ?? 0;
  const acknowledged = draft.events.filter(e => e.cursor <= acked);
  const keepFrom = acknowledged.length > cv.historyLimit
    ? acknowledged[acknowledged.length - cv.historyLimit - 1].cursor : 0;
  draft.events = draft.events.filter(e => e.cursor > keepFrom);
  const recentFrom = Math.max(0, draft.seen.length - cv.dedupLimit);
  draft.seen = draft.seen.filter((key, index) => {
    if (index >= recentFrom || draft.seenAt![key] > acked) return true;
    delete draft.seenAt![key];
    return false;
  });
}

export function fire (cv: Conversations): void {
  for (const listener of cv.listeners) listener();
  cv.changed();
}

export function eventOf (cv: Conversations, draft: Snapshot, kind: Event['kind'], room: string, peer: string, body?: string, extra?: Partial<Omit<Event, 'cursor' | 'kind' | 'room' | 'peer' | 'body' | 'trust'>>): void {
  draft.events.push({ cursor: ++draft.cursor, kind, room, peer,
    ...(body === undefined ? {} : { body }), ...(extra ?? {}), trust: 'untrusted_peer_content' });
}

export function storedPeerMemory (cv: Conversations): PeerMemoryRecord[] {
  return structuredClone(cv.state.peerMemory ?? []);
}

export function peerMemoryStats (cv: Conversations, now?: number): { count: number, bytes: number } {
  const at = now ?? Date.now();
  let count = 0;
  let bytes = 0;
  for (const entry of cv.state.peerMemory ?? []) {
    if (entry.expires <= at) continue;
    count++;
    bytes += peerMemoryRecordBytes(entry);
  }
  return { count, bytes };
}

export function nextPeerMemoryExpiry (cv: Conversations): number | undefined {
  let next: number | undefined;
  for (const entry of cv.state.peerMemory ?? []) {
    if (next === undefined || entry.expires < next) next = entry.expires;
  }
  return next;
}

export async function expirePeerMemory (cv: Conversations, now?: number): Promise<number> {
  return await cv.enqueue(async () => {
    const at = now ?? Date.now();
    const draft = structuredClone(cv.state);
    const kept = (draft.peerMemory ?? []).filter(entry => entry.expires > at);
    const removed = (draft.peerMemory ?? []).length - kept.length;
    if (removed === 0) return 0;
    if (kept.length === 0) delete draft.peerMemory;
    else draft.peerMemory = kept;
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
    return removed;
  });
}

export function peerOutcome (cv: Conversations, peer: string, subjectVector: Float32Array, profile: EmbeddingProfile,
  thresholds?: Record<number, number>, now?: number): PeerOutcome {
  return findPeerOutcome(cv.state.peerMemory ?? [], peer, subjectVector, profile, thresholds, now);
}

export function receive (cv: Conversations, peer: string, value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') throw new Error('invalid packet');
  const packet = value as Record<string, unknown>;
  const room = roomFor(cv, peer);
  if (packet.room !== room) throw new Error('room does not bind authenticated peers');
  if (packet.kind !== 'invite' && packet.kind !== 'accept' && packet.kind !== 'message')
    throw new Error('unknown packet kind');
  const routing = packet.kind === 'message' ? routeOf(cv, peer, room, packet) : undefined;
  // Every packet waits for the ones that arrived before it, so a slow route
  // cannot let a later packet overtake an earlier message.
  const result = cv.arrivals.then(async () => {
    const routed = routing === undefined ? undefined : await routing;
    return applyOf(cv, peer, room, packet, routed);
  });
  cv.arrivals = result.then(() => undefined, () => undefined);
  return result;
}

export function routeOf (cv: Conversations, peer: string, room: string, packet: Record<string, unknown>): Promise<MessageRouting | undefined> | undefined {
  const route = cv.io.route, body = packet.body, id = packet.id;
  if (!route || typeof body !== 'string' || !body || typeof id !== 'string' || !id || id.length > 128) return undefined;
  const record = cv.state.rooms[room];
  if (!record?.localConsent || !record.remoteConsent) return undefined;
  const key = JSON.stringify([peer, id]);
  if (cv.state.seen.includes(key)) return undefined;
  const inFlight = cv.routing.get(key);
  if (inFlight) return inFlight;
  const valid = (r: MessageRouting | undefined): MessageRouting | undefined =>
    r && typeof r.conference === 'string' && /^[0-9a-f]{32}$/.test(r.conference) &&
    (r.tier === 'exact' || (Number.isSafeInteger(r.tier) && r.tier > 0)) && Number.isFinite(r.score)
      ? { conference: r.conference, tier: r.tier, score: r.score } : undefined;
  let pending: Promise<MessageRouting | undefined>;
  try { pending = route.call(cv.io, peer, body).then(valid, () => undefined); }
  catch { pending = Promise.resolve(undefined); }
  const tracked = pending.finally(() => { cv.routing.delete(key); });
  cv.routing.set(key, tracked);
  return tracked;
}

export function applyOf (cv: Conversations, peer: string, room: string, packet: Record<string, unknown>, routed: MessageRouting | undefined): Promise<void> {
  return mutate(cv, draft => {
    const record = draft.rooms[room];
    if (packet.kind === 'invite') {
      const next = record ?? { peer, localConsent: false, remoteConsent: false };
      if (!next.remoteConsent) eventOf(cv, draft, 'invitation', room, peer);
      next.remoteConsent = true;
      draft.rooms[room] = next;
    } else if (packet.kind === 'accept') {
      if (!record?.localConsent) throw new Error('unsolicited acceptance');
      if (!record.remoteConsent) eventOf(cv, draft, 'accepted', room, peer);
      record.remoteConsent = true;
    } else {
      if (!record?.localConsent || !record.remoteConsent) throw new Error('message before mutual consent');
      const id = packet.id, body = packet.body;
      if (typeof id !== 'string' || id.length > 128 || !id ||
          typeof body !== 'string' || !body || new TextEncoder().encode(body).length > 16384)
        throw new Error('invalid message');
      const key = JSON.stringify([peer, id]);
      if (draft.seen.includes(key)) return false;
      draft.seen.push(key);
      eventOf(cv, draft, 'message', room, peer, body, routed === undefined ? undefined
        : { routingConference: routed.conference, tier: routed.tier, score: routed.score });
      draft.seenAt![key] = draft.cursor;
    }
  });
}

