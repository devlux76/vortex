/** Browser-safe conversation state. Authenticated transport identity supplies `peer`. */
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
const conferenceKinds: readonly string[] = ['formed', 'arrival', 'departure', 'conference_message', 'closed'];
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
function settle(draft: Snapshot): void {
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

export class Conversations {
  readonly self: string;
  private io: ConversationIO;
  private state: Snapshot;
  private listeners = new Set<() => void>();
  private changes = new Set<() => void>();
  private waiting = 0;
  private nudgers = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  /** Arrival order of received packets, kept while a message waits for its route. */
  private arrivals: Promise<void> = Promise.resolve();
  private routing = new Map<string, Promise<MessageRouting | undefined>>();
  private historyLimit: number;
  private dedupLimit: number;
  constructor(self: string, io: ConversationIO, restored?: Snapshot, retention: ConversationRetention = {}) {
    this.self = self;
    this.io = io;
    this.historyLimit = retention.historyLimit ?? 1000;
    this.dedupLimit = retention.dedupLimit ?? 4096;
    if (![this.historyLimit, this.dedupLimit].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new Error('retention limits must be non-negative safe integers');
    this.state = structuredClone(restored ?? { rooms: {}, events: [], seen: [], cursor: 0 });
    if (this.state.peerMemory !== undefined) {
      const valid = Array.isArray(this.state.peerMemory) ? this.state.peerMemory.filter(record => {
        try { checkPeerMemoryRecord(record); return true; } catch { return false; }
      }) : [];
      if (valid.length) this.state.peerMemory = valid;
      else delete this.state.peerMemory;
    }
    this.state.seenAt ??= {};
    if (this.state.handled !== undefined) {
      const acked = this.state.acked ?? 0;
      this.state.handled = Array.isArray(this.state.handled) ? this.state.handled.filter(c =>
        Number.isSafeInteger(c) && c > acked && c <= this.state.cursor) : [];
      settle(this.state);
    }
    // Legacy snapshots cannot associate IDs with events: protect them until all legacy mail is acked.
    for (const key of this.state.seen) this.state.seenAt[key] ??= this.state.cursor;
  }
  roomFor(peer: string): string {
    if (!peer || peer === this.self) throw new Error('invalid peer');
    return JSON.stringify([this.self, peer].sort());
  }
  /** Current durable cursor and total unread count, without copying peer bodies. */
  notice(): {cursor:number;unread:number} {
    return {cursor:this.state.cursor,unread:this.unreadEvents().length};
  }
  snapshot(): Snapshot { return structuredClone(this.state); }
  /** Unread events in order: above the ack watermark and not handled by a scoped ack. */
  private unreadEvents(): Event[] {
    const acked = this.state.acked ?? 0, handled = new Set(this.state.handled);
    return this.state.events.filter(e => e.cursor > acked && !handled.has(e.cursor));
  }
  /** Topic metadata of every unread event, in order, without bodies: who should handle what. */
  unreadTopics(): Pick<Event, 'cursor' | 'conference' | 'routingConference' | 'session'>[] {
    return this.unreadEvents().map(({ cursor, conference, routingConference, session }) =>
      ({ cursor, ...(conference === undefined ? {} : { conference, session }),
        ...(routingConference === undefined ? {} : { routingConference }) }));
  }
  /** Topic metadata of the oldest unread event, without its body: who should handle the queue's head. */
  head(): Pick<Event, 'cursor' | 'conference' | 'routingConference' | 'session'> | undefined {
    return this.unreadTopics()[0];
  }
  rooms(): Record<string, Room> { return structuredClone(this.state.rooms); }
  /** Body-free, complete unread metadata for the local wake scheduler. */
  notificationState(): { acked: number; waiters: number; rooms: { room: string; unread: number; oldest: number; hasData: boolean }[] } {
    const acked=this.state.acked ?? 0;
    const rooms=new Map<string,{room:string;unread:number;oldest:number;hasData:boolean}>();
    for(const event of this.unreadEvents()) {
      // A match is this service's own discovery product, not a peer's say-so: no consent check.
      if(event.kind!=='match' && !conferenceKinds.includes(event.kind)) {
        const consent=this.state.rooms[event.room];
        if(!consent?.localConsent || !consent.remoteConsent) continue;
      }
      const isControl = CONTROL_EVENT_KINDS.has(event.kind);
      const record=rooms.get(event.room);
      if(record) { record.unread++; if(!isControl) record.hasData = true; }
      else rooms.set(event.room,{room:event.room,unread:1,oldest:event.cursor,hasData:!isControl});
    }
    return {acked,waiters:this.waiting,rooms:[...rooms.values()]};
  }
  /**
   * With no `after`, the unread view: events above the watermark that no
   * scoped ack handled. With `after`, history: every retained event after it.
   * `only` narrows either view (a session reading just its own topics).
   */
  read(after?: number, only?: (event: Event) => boolean): { events: Event[]; cursor: number } {
    const from = after ?? this.state.acked ?? 0;
    if (!Number.isSafeInteger(from) || from < 0 || from > this.state.cursor) throw new Error('invalid cursor');
    const events = (after === undefined ? this.unreadEvents() : this.state.events.filter(e => e.cursor > after))
      .filter(e => only === undefined || only(e)).slice(0, 100);
    return { events: structuredClone(events), cursor: events.at(-1)?.cursor ?? from };
  }
  /**
   * Without `only`, acknowledges every event through `cursor`. With it, marks
   * just the unread events through `cursor` that it selects as handled, so a
   * session-scoped reader can never discard another topic's unread mail; the
   * watermark then moves only across a contiguous handled run.
   */
  ack(cursor: number, only?: (event: Event) => boolean): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < (this.state.acked ?? 0) || cursor > this.state.cursor)
      throw new Error('invalid acknowledgment cursor');
    return this.mutate(draft => {
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
  onEvents(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }
  onChange(handler: () => void): () => void {
    this.changes.add(handler);
    return () => { this.changes.delete(handler); };
  }
  private changed(): void { for(const listener of this.changes) listener(); }
  waiters(): number { return this.waiting; }
  wait(after?: number, timeoutMs = 30000, signal?: AbortSignal): Promise<{ events: Event[]; cursor: number; nudged?: true }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      return Promise.reject(new Error('wait timeout must be 1–60000 ms'));
    signal?.throwIfAborted();
    const page=this.read(after);
    if (page.events.length) return Promise.resolve(page);
    return new Promise((resolve,reject) => {
      this.waiting++;
      const finish=(error?: Error, nudged?: boolean) => {
        clearTimeout(timer); off(); signal?.removeEventListener('abort',aborted); this.waiting--;
        this.nudgers.delete(release);
        if (error) reject(error);
        else resolve(nudged ? { ...this.read(after), nudged: true as const } : this.read(after));
        this.changed();
      };
      const release=() => { finish(undefined, true); };
      this.nudgers.add(release);
      const aborted=() => { finish(new Error('wait canceled')); };
      const off=this.onEvents(() => { if (this.read(after).events.length) finish(); });
      const timer=setTimeout(() => { finish(new Error('wait timed out')); },timeoutMs);
      signal?.addEventListener('abort',aborted,{once:true});
      this.changed();
    });
  }
  /** Ends every pending wait at once with its current page marked nudged; stores nothing. */
  nudge(): number {
    const pending=[...this.nudgers];
    this.nudgers.clear();
    for(const release of pending) release();
    return pending.length;
  }
  /**
   * ONE serial queue for every state change: a mutation starts only after the
   * previous one's save has settled, so two saves are never in flight and a
   * rollback can never discard another mutation's work. The change is applied
   * to a working copy and swapped in after the save resolves; listeners fire
   * only then, so read/wait/notificationState never show an unsaved change.
   * A rejected save undoes nothing (the committed state was never touched),
   * rejects this mutation, and later queued mutations still run.
   */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private mutate(apply: (draft: Snapshot) => boolean | void): Promise<void> {
    return this.enqueue(async () => {
      const draft = structuredClone(this.state);
      if (apply(draft) === false) return;
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
    });
  }
  private prune(draft: Snapshot): void {
    const acked = draft.acked ?? 0;
    const acknowledged = draft.events.filter(e => e.cursor <= acked);
    const keepFrom = acknowledged.length > this.historyLimit
      ? acknowledged[acknowledged.length - this.historyLimit - 1].cursor : 0;
    draft.events = draft.events.filter(e => e.cursor > keepFrom);
    const recentFrom = Math.max(0, draft.seen.length - this.dedupLimit);
    draft.seen = draft.seen.filter((key, index) => {
      if (index >= recentFrom || draft.seenAt![key] > acked) return true;
      delete draft.seenAt![key];
      return false;
    });
  }
  private fire(): void {
    for (const listener of this.listeners) listener();
    this.changed();
  }
  private event(draft: Snapshot, kind: Event['kind'], room: string, peer: string, body?: string, extra?: Partial<Omit<Event, 'cursor' | 'kind' | 'room' | 'peer' | 'body' | 'trust'>>): void {
    draft.events.push({ cursor: ++draft.cursor, kind, room, peer,
      ...(body === undefined ? {} : { body }), ...(extra ?? {}), trust: 'untrusted_peer_content' });
  }
  async invite(peer: string): Promise<string> {
    const room = this.roomFor(peer);
    await this.mutate(draft => {
      draft.rooms[room] ??= { peer, localConsent: false, remoteConsent: false };
      draft.rooms[room].localConsent = true;
    });
    await this.io.send(peer, { kind: 'invite', room });
    return room;
  }
  async accept(room: string): Promise<void> {
    await this.mutate(draft => {
      const record = draft.rooms[room];
      if (!record || !record.remoteConsent) throw new Error('no invitation to accept');
      record.localConsent = true;
    });
    await this.io.send(this.state.rooms[room].peer, { kind: 'accept', room });
  }
  async send(room: string, body: string): Promise<void> {
    const record = this.state.rooms[room];
    if (!record?.localConsent || !record.remoteConsent) throw new Error('conversation lacks mutual consent: the peer has not accepted yet; wait for its accepted event, then send again');
    if (typeof body !== 'string' || !body || new TextEncoder().encode(body).length > 16384)
      throw new Error('message must contain 1–16384 bytes');
    await this.io.send(record.peer, { kind: 'message', room, id: crypto.randomUUID(), body });
  }
  /** A match this service's own discovery produced; saved before it is visible, like every other event. */
  async recordMatch(match: { interest: string; record: string; peer: string; tier: 'exact' | number; score: number;
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
    await this.mutate(draft => {
      this.event(draft, 'match', 'match:' + interest, peer, undefined,
        { interest, record, tier, score, fullScore, addrs: [...addrs], ...(recordKind === undefined ? {} : { recordKind }), ...(statement === undefined ? {} : { statement }) });
    });
  }
  /** Only the local conference engine may produce these events. Peer packets cannot. */
  async recordConference(event: ConferenceRecord): Promise<void> {
    const copy: ConferenceRecord = { ...event };
    checkConferenceRecord(copy);
    await this.mutate(draft => {
      if (!pushConferenceRecord(draft, copy, (kind, room, peer, body, extra) =>
        this.event(draft, kind, room, peer, body, extra))) return false;
    });
  }
  /** Copy inputs before awaiting; renew preserves id/cursor/subject, new rooms mint an id with cursor 0. */
  async setSubscription(input: Omit<RoomSubscription, 'id' | 'historyCursor'>, maxCount = 32): Promise<RoomSubscription> {
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
    return await this.enqueue(async () => {
      const draft = structuredClone(this.state);
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
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
      return structuredClone(this.state.subscriptions![conference]);
    });
  }
  /** Public copies without private membership or subscription ids. */
  subscriptions(session?: string): Array<Pick<RoomSubscription, 'conference' | 'session' | 'host' | 'expires' | 'historyCursor'>> {
    const all = this.state.subscriptions ?? {};
    return Object.values(all)
      .filter(entry => session === undefined || entry.session === session)
      .map(entry => ({ conference: entry.conference, session: entry.session, host: entry.host,
        expires: entry.expires, historyCursor: entry.historyCursor }));
  }
  /** Full private copies for the trusted service. */
  storedSubscriptions(): Record<string, RoomSubscription> {
    return structuredClone(this.state.subscriptions ?? {});
  }
  /**
   * Update only the cached membership (and optionally clip a shorter expiry)
   * for the subscription with the matching id. Never creates a record:
   * missing or replaced incarnations are a no-op. Copies inputs before queueing.
   */
  async refreshSubscriptionMembership (conference: string, id: string,
    membership: { descriptor: string, privateKey: string }, expires?: number): Promise<boolean> {
    const room = conference;
    const subId = id;
    const member = { descriptor: membership.descriptor, privateKey: membership.privateKey };
    const clipped = expires;
    checkMembership(member);
    if (clipped !== undefined && (!Number.isSafeInteger(clipped) || clipped <= 0)) throw new Error('invalid subscription expiry');
    return await this.enqueue(async () => {
      const draft = structuredClone(this.state);
      const current = draft.subscriptions?.[room];
      if (current === undefined || current.id !== subId) return false;
      current.membership = { descriptor: member.descriptor, privateKey: member.privateKey };
      if (clipped !== undefined && clipped < current.expires) current.expires = clipped;
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
      return true;
    });
  }
  async removeSubscription(session: string, conference: string, expected?: { id: string; expires: number }): Promise<boolean> {
    const ownSession = session;
    const room = conference;
    const guard = expected === undefined ? undefined : { id: expected.id, expires: expected.expires };
    return await this.enqueue(async () => {
      const draft = structuredClone(this.state);
      const current = draft.subscriptions?.[room];
      if (current === undefined || current.session !== ownSession) return false;
      if (guard !== undefined && (current.id !== guard.id || current.expires !== guard.expires)) return false;
      delete draft.subscriptions![room];
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
      return true;
    });
  }
  async applySubscriptionHistory(conference: string, id: string, after: number, cursor: number, events: ConferenceRecord[]): Promise<number> {
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
    return await this.enqueue(async () => {
      const draft = structuredClone(this.state);
      const stored = draft.subscriptions?.[room];
      if (stored === undefined || stored.id !== subscriptionId || stored.historyCursor !== from) return 0;
      let added = 0;
      for (const event of page) {
        if (pushConferenceRecord(draft, event, (kind, eventRoom, peer, body, extra) =>
          this.event(draft, kind, eventRoom, peer, body, extra))) added++;
      }
      if (added === 0 && to === from) return 0;
      stored.historyCursor = to;
      draft.subscriptions![room] = stored;
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
      return added;
    });
  }
  async flush(): Promise<void> {
    await this.tail;
  }
  /**
   * Store peer-outcome records and, in the same serialized save, optionally
   * remove one owned subscription (for example on ordinary conference leave).
   * Inputs are copied before queueing; a missing subscription still permits
   * ratings, while a wrong session or mismatched incarnation removes nothing.
   * Records are not inbox events: cursor, acked and seen never advance.
   */
  async recordPeerOutcomes(
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
    return await this.enqueue(async () => {
      const draft = structuredClone(this.state);
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
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
      return { stored: batch.length, unsubscribed };
    });
  }
  /** Full private copies for the trusted service. Never exposed publicly. */
  storedPeerMemory(): PeerMemoryRecord[] {
    return structuredClone(this.state.peerMemory ?? []);
  }
  /** Public counts only: no identities, statements, vectors or outcomes. */
  peerMemoryStats(now?: number): { count: number, bytes: number } {
    const at = now ?? Date.now();
    let count = 0;
    let bytes = 0;
    for (const entry of this.state.peerMemory ?? []) {
      if (entry.expires <= at) continue;
      count++;
      bytes += peerMemoryRecordBytes(entry);
    }
    return { count, bytes };
  }
  /** Earliest expiry among stored records, or undefined when empty. */
  nextPeerMemoryExpiry(): number | undefined {
    let next: number | undefined;
    for (const entry of this.state.peerMemory ?? []) {
      if (next === undefined || entry.expires < next) next = entry.expires;
    }
    return next;
  }
  /**
   * Durably remove expired records, reevaluated against current queued state
   * so a renewal racing a stale timer survives. No save when nothing expires.
   */
  async expirePeerMemory(now?: number): Promise<number> {
    return await this.enqueue(async () => {
      const at = now ?? Date.now();
      const draft = structuredClone(this.state);
      const kept = (draft.peerMemory ?? []).filter(entry => entry.expires > at);
      const removed = (draft.peerMemory ?? []).length - kept.length;
      if (removed === 0) return 0;
      if (kept.length === 0) delete draft.peerMemory;
      else draft.peerMemory = kept;
      this.prune(draft);
      await this.io.save(structuredClone(draft));
      this.state = draft;
      this.fire();
      return removed;
    });
  }
  /**
   * The latest committed outcome for a peer on a subject, same namespace
   * only. Unknown, expired and unmatched entries score neutral.
   */
  peerOutcome(peer: string, subjectVector: Float32Array, profile: EmbeddingProfile,
    thresholds?: Record<number, number>, now?: number): PeerOutcome {
    return findPeerOutcome(this.state.peerMemory ?? [], peer, subjectVector, profile, thresholds, now);
  }
  receive(peer: string, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') throw new Error('invalid packet');
    const packet = value as Record<string, unknown>;
    const room = this.roomFor(peer);
    if (packet.room !== room) throw new Error('room does not bind authenticated peers');
    if (packet.kind !== 'invite' && packet.kind !== 'accept' && packet.kind !== 'message')
      throw new Error('unknown packet kind');
    const routing = packet.kind === 'message' ? this.routeOf(peer, room, packet) : undefined;
    // Every packet waits for the ones that arrived before it, so a slow route
    // cannot let a later packet overtake an earlier message.
    const result = this.arrivals.then(async () => {
      const routed = routing === undefined ? undefined : await routing;
      return this.apply(peer, room, packet, routed);
    });
    this.arrivals = result.then(() => undefined, () => undefined);
    return result;
  }
  private routeOf(peer: string, room: string, packet: Record<string, unknown>): Promise<MessageRouting | undefined> | undefined {
    const route = this.io.route, body = packet.body, id = packet.id;
    if (!route || typeof body !== 'string' || !body || typeof id !== 'string' || !id || id.length > 128) return undefined;
    const record = this.state.rooms[room];
    if (!record?.localConsent || !record.remoteConsent) return undefined;
    const key = JSON.stringify([peer, id]);
    if (this.state.seen.includes(key)) return undefined;
    const inFlight = this.routing.get(key);
    if (inFlight) return inFlight;
    const valid = (r: MessageRouting | undefined): MessageRouting | undefined =>
      r && typeof r.conference === 'string' && /^[0-9a-f]{32}$/.test(r.conference) &&
      (r.tier === 'exact' || (Number.isSafeInteger(r.tier) && r.tier > 0)) && Number.isFinite(r.score)
        ? { conference: r.conference, tier: r.tier, score: r.score } : undefined;
    let pending: Promise<MessageRouting | undefined>;
    try { pending = route.call(this.io, peer, body).then(valid, () => undefined); }
    catch { pending = Promise.resolve(undefined); }
    const tracked = pending.finally(() => { this.routing.delete(key); });
    this.routing.set(key, tracked);
    return tracked;
  }
  private apply(peer: string, room: string, packet: Record<string, unknown>, routed: MessageRouting | undefined): Promise<void> {
    return this.mutate(draft => {
      const record = draft.rooms[room];
      if (packet.kind === 'invite') {
        const next = record ?? { peer, localConsent: false, remoteConsent: false };
        if (!next.remoteConsent) this.event(draft, 'invitation', room, peer);
        next.remoteConsent = true;
        draft.rooms[room] = next;
      } else if (packet.kind === 'accept') {
        if (!record?.localConsent) throw new Error('unsolicited acceptance');
        if (!record.remoteConsent) this.event(draft, 'accepted', room, peer);
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
        this.event(draft, 'message', room, peer, body, routed === undefined ? undefined
          : { routingConference: routed.conference, tier: routed.tier, score: routed.score });
        draft.seenAt![key] = draft.cursor;
      }
    });
  }
}

function checkConferenceRecord(event: ConferenceRecord): void {
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

function pushConferenceRecord(draft: Snapshot,
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

function checkMembership (membership: { descriptor: string, privateKey: string } | undefined): void {
  const hexed = (value: unknown, max: number): boolean => typeof value === 'string' && value.length > 0 &&
    value.length % 2 === 0 && value.length <= max && /^[0-9a-f]+$/.test(value);
  if (membership === undefined || !hexed(membership.descriptor, 32768) || !hexed(membership.privateKey, 1024)) {
    throw new Error('invalid subscription membership');
  }
}

function checkSubscriptionInput(input: { conference: string; session: string; host: string; expires: number;
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
function sameSubject (left: PeerMemorySubject | undefined, right: PeerMemorySubject | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.statement === right.statement && left.vector === right.vector &&
    left.namespace === right.namespace && left.profileVersion === right.profileVersion;
}

function newSubscriptionId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through to hex */ }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
