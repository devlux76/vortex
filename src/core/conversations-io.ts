import type { EmbeddingProfile } from '../types.ts';
import {
  checkPeerMemoryRecord, checkPeerMemorySubject, findPeerOutcome, peerMemoryIdentityKey, peerMemoryRecordBytes,
  prunePeerMemoryEntries, validatePeerMemoryLimits,
  type PeerMemoryLimits, type PeerMemoryRecord, type PeerMemorySubject, type PeerOutcome
} from './peer-memory.ts';
import type { Conversations } from './conversations.ts'
import { type Packet, type Room, type ConferenceKind, type ConferenceRecord, conferenceKinds, CONTROL_EVENT_KINDS, isControlEventKind, type Event, type Snapshot, type RoomSubscription, type ConversationRetention, type MessageRouting, type ConversationIO, settle, checkConferenceRecord, pushConferenceRecord, checkMembership, checkSubscriptionInput, sameSubject, newSubscriptionId } from './conversations-types.ts'
import { roomFor, mutate, eventOf, prune, fire } from './conversations-state.ts'

export async function invite (cv: Conversations, peer: string): Promise<string> {
  const room = roomFor(cv, peer);
  await mutate(cv, draft => {
    draft.rooms[room] ??= { peer, localConsent: false, remoteConsent: false };
    draft.rooms[room].localConsent = true;
  });
  await cv.io.send(peer, { kind: 'invite', room });
  return room;
}

export async function accept (cv: Conversations, room: string): Promise<void> {
  await mutate(cv, draft => {
    const record = draft.rooms[room];
    if (!record || !record.remoteConsent) throw new Error('no invitation to accept');
    record.localConsent = true;
  });
  await cv.io.send(cv.state.rooms[room].peer, { kind: 'accept', room });
}

export async function send (cv: Conversations, room: string, body: string): Promise<void> {
  const record = cv.state.rooms[room];
  if (!record?.localConsent || !record.remoteConsent) throw new Error('conversation lacks mutual consent: the peer has not accepted yet; wait for its accepted event, then send again');
  if (typeof body !== 'string' || !body || new TextEncoder().encode(body).length > 16384)
    throw new Error('message must contain 1–16384 bytes');
  await cv.io.send(record.peer, { kind: 'message', room, id: crypto.randomUUID(), body });
}

export async function recordMatch (cv: Conversations, match: { interest: string; record: string; peer: string; tier: 'exact' | number; score: number;
  fullScore: number; addrs: string[]; statement?: string; recordKind?: 'interest' | 'conference' }): Promise<void> {
  const { interest, record, peer, tier, score, fullScore, addrs, statement, recordKind } = match;
  if ((recordKind !== undefined && recordKind !== 'interest' && recordKind !== 'conference') || typeof record !== 'string' || !/^[0-9a-f]{32}$/.test(record) || typeof interest !== 'string' || !interest || typeof peer !== 'string' || !peer ||
    !(tier === 'exact' || (typeof tier === 'number' && Number.isFinite(tier))) ||
    typeof score !== 'number' || !Number.isFinite(score) ||
    typeof fullScore !== 'number' || !Number.isFinite(fullScore) ||
    !Array.isArray(addrs) || addrs.length < 1 || addrs.length > 8 ||
    !addrs.every(a => typeof a === 'string' && a.length < 512) ||
    (statement !== undefined && (typeof statement !== 'string' || new TextEncoder().encode(statement).length > 4096)))
    throw new Error('invalid match');
  await mutate(cv, draft => {
    eventOf(cv, draft, 'match', 'match:' + interest, peer, undefined,
      { interest, record, tier, score, fullScore, addrs: [...addrs], ...(recordKind === undefined ? {} : { recordKind }), ...(statement === undefined ? {} : { statement }) });
  });
}

export async function recordConference (cv: Conversations, event: ConferenceRecord): Promise<void> {
  const copy: ConferenceRecord = { ...event };
  checkConferenceRecord(copy);
  await mutate(cv, draft => {
    if (!pushConferenceRecord(draft, copy, (kind, room, peer, body, extra) =>
      eventOf(cv, draft, kind, room, peer, body, extra))) return false;
  });
}

export async function setSubscription (cv: Conversations, input: Omit<RoomSubscription, 'id' | 'historyCursor'>, maxCount = 32): Promise<RoomSubscription> {
  const conference = input.conference;
  const session = input.session;
  const host = input.host;
  const expires = input.expires;
  const membership = input.membership === undefined ? undefined :
    { descriptor: input.membership.descriptor, privateKey: input.membership.privateKey };
  const subject = input.subject === undefined ? undefined :
    { statement: input.subject.statement, vector: input.subject.vector,
      namespace: input.subject.namespace, profileVersion: input.subject.profileVersion };
  const limit = maxCount;
  checkSubscriptionInput({ conference, session, host, expires, membership }, limit);
  if (subject !== undefined) checkPeerMemorySubject(subject);
  return await cv.enqueue(async () => {
    const draft = structuredClone(cv.state);
    const stored = draft.subscriptions?.[conference];
    if (stored !== undefined && stored.session !== session) throw new Error('invalid subscription session');
    if (stored?.subject !== undefined && subject !== undefined && !sameSubject(stored.subject, subject)) {
      throw new Error('subscription subject does not match the original query');
    }
    draft.subscriptions ??= {};
    if (stored !== undefined) {
      const kept = draft.subscriptions[conference];
      kept.host = host;
      kept.expires = expires;
      if (membership === undefined) delete kept.membership;
      else kept.membership = { descriptor: membership.descriptor, privateKey: membership.privateKey };
      if (subject !== undefined && kept.subject === undefined) {
        kept.subject = { ...subject };
      }
    } else {
      if (Object.keys(draft.subscriptions).length >= limit) throw new Error('too many subscriptions');
      draft.subscriptions[conference] = { id: newSubscriptionId(), conference, session, host,
        expires, historyCursor: 0,
        ...(membership === undefined ? {} : { membership: { descriptor: membership.descriptor, privateKey: membership.privateKey } }),
        ...(subject === undefined ? {} : { subject: { ...subject } }) };
    }
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
    return structuredClone(cv.state.subscriptions![conference]);
  });
}

export function subscriptions (cv: Conversations, session?: string): Array<Pick<RoomSubscription, 'conference' | 'session' | 'host' | 'expires' | 'historyCursor'>> {
  const all = cv.state.subscriptions ?? {};
  return Object.values(all)
    .filter(entry => session === undefined || entry.session === session)
    .map(entry => ({ conference: entry.conference, session: entry.session, host: entry.host,
      expires: entry.expires, historyCursor: entry.historyCursor }));
}

export function storedSubscriptions (cv: Conversations): Record<string, RoomSubscription> {
  return structuredClone(cv.state.subscriptions ?? {});
}

export async function refreshSubscriptionMembership (cv: Conversations, conference: string, id: string,
  membership: { descriptor: string, privateKey: string }, expires?: number): Promise<boolean> {
  const room = conference;
  const subId = id;
  const member = { descriptor: membership.descriptor, privateKey: membership.privateKey };
  const clipped = expires;
  checkMembership(member);
  if (clipped !== undefined && (!Number.isSafeInteger(clipped) || clipped <= 0)) throw new Error('invalid subscription expiry');
  return await cv.enqueue(async () => {
    const draft = structuredClone(cv.state);
    const current = draft.subscriptions?.[room];
    if (current === undefined || current.id !== subId) return false;
    current.membership = { descriptor: member.descriptor, privateKey: member.privateKey };
    if (clipped !== undefined && clipped < current.expires) current.expires = clipped;
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
    return true;
  });
}

export async function removeSubscription (cv: Conversations, session: string, conference: string, expected?: { id: string; expires: number }): Promise<boolean> {
  const ownSession = session;
  const room = conference;
  const guard = expected === undefined ? undefined : { id: expected.id, expires: expected.expires };
  return await cv.enqueue(async () => {
    const draft = structuredClone(cv.state);
    const current = draft.subscriptions?.[room];
    if (current === undefined || current.session !== ownSession) return false;
    if (guard !== undefined && (current.id !== guard.id || current.expires !== guard.expires)) return false;
    delete draft.subscriptions![room];
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
    return true;
  });
}

export async function applySubscriptionHistory (cv: Conversations, conference: string, id: string, after: number, cursor: number, events: ConferenceRecord[]): Promise<number> {
  const room = conference;
  const subscriptionId = id;
  const from = after;
  const to = cursor;
  if (!Array.isArray(events)) throw new Error('invalid history page');
  const page: ConferenceRecord[] = events.map(row => ({ ...row }));
  if (!/^[0-9a-f]{32}$/.test(room)) throw new Error('invalid conference');
  if (typeof subscriptionId !== 'string' || !subscriptionId) throw new Error('invalid subscription id');
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to < 0 || to < from)
    throw new Error('invalid history cursor');
  for (const event of page) {
    checkConferenceRecord(event);
    if (event.kind !== 'conference_message' || event.conference !== room ||
      typeof event.message !== 'string' || !/^[0-9a-f]{32}$/.test(event.message)) {
      throw new Error('invalid history page');
    }
  }
  return await cv.enqueue(async () => {
    const draft = structuredClone(cv.state);
    const stored = draft.subscriptions?.[room];
    if (stored === undefined || stored.id !== subscriptionId || stored.historyCursor !== from) return 0;
    let added = 0;
    for (const event of page) {
      if (pushConferenceRecord(draft, event, (kind, eventRoom, peer, body, extra) =>
        eventOf(cv, draft, kind, eventRoom, peer, body, extra))) added++;
    }
    if (added === 0 && to === from) return 0;
    stored.historyCursor = to;
    draft.subscriptions![room] = stored;
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
    return added;
  });
}

export async function flush (cv: Conversations): Promise<void> {
  await cv.tail;
}

export async function recordPeerOutcomes (cv: Conversations, 
  records: PeerMemoryRecord[],
  limits?: PeerMemoryLimits,
  removal?: { session: string, conference: string, expected?: { id: string, expires: number } }
): Promise<{ stored: number, unsubscribed: boolean }> {
  if (!Array.isArray(records)) throw new Error('invalid peer memory batch');
  const batch = records.map(record => ({ ...record }));
  const bounds = validatePeerMemoryLimits(limits);
  let owned: { session: string, conference: string, expected?: { id: string, expires: number } } | undefined;
  if (removal !== undefined) {
    if (typeof removal !== 'object' || removal === null) throw new Error('invalid peer memory removal');
    owned = { session: removal.session, conference: removal.conference,
      expected: removal.expected === undefined
        ? undefined : { id: removal.expected.id, expires: removal.expected.expires } };
  }
  if (batch.length > 256) throw new Error('peer memory batch too large');
  const identities = new Set<string>();
  let batchBytes = 0;
  for (const record of batch) {
    checkPeerMemoryRecord(record);
    const key = peerMemoryIdentityKey(record);
    if (identities.has(key)) throw new Error('duplicate peer memory identity in batch');
    identities.add(key);
    batchBytes += peerMemoryRecordBytes(record);
  }
  if (batch.length > bounds.maxCount) throw new Error('peer memory batch exceeds count bound');
  if (batchBytes > bounds.maxBytes) throw new Error('peer memory batch exceeds byte bound');
  return await cv.enqueue(async () => {
    const draft = structuredClone(cv.state);
    let unsubscribed = false;
    if (owned !== undefined) {
      const current = draft.subscriptions?.[owned.conference];
      if (current !== undefined && current.session === owned.session &&
        (owned.expected === undefined || (current.id === owned.expected.id && current.expires === owned.expected.expires))) {
        delete draft.subscriptions![owned.conference];
        unsubscribed = true;
      }
    }
    const merged = (draft.peerMemory ?? []).filter(entry => !identities.has(peerMemoryIdentityKey(entry)));
    for (const record of batch) merged.push({ ...record });
    const pruned = prunePeerMemoryEntries(merged, bounds, Date.now());
    if (pruned.length === 0) delete draft.peerMemory;
    else draft.peerMemory = pruned;
    prune(cv, draft);
    await cv.io.save(structuredClone(draft));
    cv.state = draft;
    fire(cv);
    return { stored: batch.length, unsubscribed };
  });
}

