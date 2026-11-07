/** Browser-safe conversation state. Authenticated transport identity supplies `peer`. */

import type { EmbeddingProfile } from '../types.ts';
import {
  checkPeerMemoryRecord, checkPeerMemorySubject, findPeerOutcome, peerMemoryIdentityKey, peerMemoryRecordBytes,
  prunePeerMemoryEntries, validatePeerMemoryLimits,
  type PeerMemoryLimits, type PeerMemoryRecord, type PeerMemorySubject, type PeerOutcome
} from './peer-memory.ts';
export * from './conversations-types.ts'
import { type Packet, type Room, type ConferenceKind, type ConferenceRecord, conferenceKinds, CONTROL_EVENT_KINDS, isControlEventKind, type Event, type Snapshot, type RoomSubscription, type ConversationRetention, type MessageRouting, type ConversationIO, settle, checkConferenceRecord, pushConferenceRecord, checkMembership, checkSubscriptionInput, sameSubject, newSubscriptionId } from './conversations-types.ts'
import { roomFor, notice, unreadEvents, unreadTopics, head, notificationState, read, ack, onEvents, onChange, wait, nudge, mutate, prune, fire, eventOf, storedPeerMemory, peerMemoryStats, nextPeerMemoryExpiry, expirePeerMemory, peerOutcome, receive, routeOf, applyOf } from './conversations-state.ts'
import { invite, accept, send, recordMatch, recordConference, setSubscription, subscriptions, storedSubscriptions, refreshSubscriptionMembership, removeSubscription, applySubscriptionHistory, flush, recordPeerOutcomes } from './conversations-io.ts'

export class Conversations {
  readonly self: string;
  io: ConversationIO;
  state: Snapshot;
  listeners = new Set<() => void>();
  changes = new Set<() => void>();
  waiting = 0;
  nudgers = new Set<() => void>();
  tail: Promise<void> = Promise.resolve();
  /** Arrival order of received packets, kept while a message waits for its route. */
  arrivals: Promise<void> = Promise.resolve();
  routing = new Map<string, Promise<MessageRouting | undefined>>();
  historyLimit: number;
  dedupLimit: number;
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
    return roomFor(this, peer)
  }
  /** Current durable cursor and total unread count, without copying peer bodies. */
  notice(): {cursor:number;unread:number} {
    return notice(this)
  }
  snapshot(): Snapshot { return structuredClone(this.state); }
  /** Unread events in order: above the ack watermark and not handled by a scoped ack. */
  private unreadEvents(): Event[] {
    return unreadEvents(this)
  }
  /** Topic metadata of every unread event, in order, without bodies: who should handle what. */
  unreadTopics(): Pick<Event, 'cursor' | 'conference' | 'routingConference' | 'session'>[] {
    return unreadTopics(this)
  }
  /** Topic metadata of the oldest unread event, without its body: who should handle the queue's head. */
  head(): Pick<Event, 'cursor' | 'conference' | 'routingConference' | 'session'> | undefined {
    return head(this)
  }
  rooms(): Record<string, Room> { return structuredClone(this.state.rooms); }
  /** Body-free, complete unread metadata for the local wake scheduler. */
  notificationState(): { acked: number; waiters: number; rooms: { room: string; unread: number; oldest: number; hasData: boolean }[] } {
    return notificationState(this)
  }
  /**
   * With no `after`, the unread view: events above the watermark that no
   * scoped ack handled. With `after`, history: every retained event after it.
   * `only` narrows either view (a session reading just its own topics).
   */
  read(after?: number, only?: (event: Event) => boolean): { events: Event[]; cursor: number } {
    return read(this, after, only)
  }
  /**
   * Without `only`, acknowledges every event through `cursor`. With it, marks
   * just the unread events through `cursor` that it selects as handled, so a
   * session-scoped reader can never discard another topic's unread mail; the
   * watermark then moves only across a contiguous handled run.
   */
  ack(cursor: number, only?: (event: Event) => boolean): Promise<void> {
    return ack(this, cursor, only)
  }
  onEvents(handler: () => void): () => void {
    return onEvents(this, handler)
  }
  onChange(handler: () => void): () => void {
    return onChange(this, handler)
  }
  changed(): void { for(const listener of this.changes) listener(); }
  waiters(): number { return this.waiting; }
  wait(after?: number, timeoutMs = 30000, signal?: AbortSignal): Promise<{ events: Event[]; cursor: number; nudged?: true }> {
    return wait(this, after, timeoutMs, signal)
  }
  /** Ends every pending wait at once with its current page marked nudged; stores nothing. */
  nudge(): number {
    return nudge(this)
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
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private mutate(apply: (draft: Snapshot) => boolean | void): Promise<void> {
    return mutate(this, apply)
  }
  private prune(draft: Snapshot): void {
    return prune(this, draft)
  }
  private fire(): void {
    return fire(this)
  }
  private event(draft: Snapshot, kind: Event['kind'], room: string, peer: string, body?: string, extra?: Partial<Omit<Event, 'cursor' | 'kind' | 'room' | 'peer' | 'body' | 'trust'>>): void {
    return eventOf(this, draft, kind, room, peer, body, extra)
  }
  async invite(peer: string): Promise<string> {
    return invite(this, peer)
  }
  async accept(room: string): Promise<void> {
    return accept(this, room)
  }
  async send(room: string, body: string): Promise<void> {
    return send(this, room, body)
  }
  /** A match this service's own discovery produced; saved before it is visible, like every other event. */
  async recordMatch(match: { interest: string; record: string; peer: string; tier: 'exact' | number; score: number;
    fullScore: number; addrs: string[]; statement?: string; recordKind?: 'interest' | 'conference' }): Promise<void> {
    return recordMatch(this, match)
  }
  /** Only the local conference engine may produce these events. Peer packets cannot. */
  async recordConference(event: ConferenceRecord): Promise<void> {
    return recordConference(this, event)
  }
  /** Copy inputs before awaiting; renew preserves id/cursor/subject, new rooms mint an id with cursor 0. */
  async setSubscription(input: Omit<RoomSubscription, 'id' | 'historyCursor'>, maxCount = 32): Promise<RoomSubscription> {
    return setSubscription(this, input, maxCount)
  }
  /** Public copies without private membership or subscription ids. */
  subscriptions(session?: string): Array<Pick<RoomSubscription, 'conference' | 'session' | 'host' | 'expires' | 'historyCursor'>> {
    return subscriptions(this, session)
  }
  /** Full private copies for the trusted service. */
  storedSubscriptions(): Record<string, RoomSubscription> {
    return storedSubscriptions(this)
  }
  /**
   * Update only the cached membership (and optionally clip a shorter expiry)
   * for the subscription with the matching id. Never creates a record:
   * missing or replaced incarnations are a no-op. Copies inputs before queueing.
   */
  async refreshSubscriptionMembership (conference: string, id: string,
    membership: { descriptor: string, privateKey: string }, expires?: number): Promise<boolean> {
    return refreshSubscriptionMembership(this, conference, id, membership, expires)
  }
  async removeSubscription(session: string, conference: string, expected?: { id: string; expires: number }): Promise<boolean> {
    return removeSubscription(this, session, conference, expected)
  }
  async applySubscriptionHistory(conference: string, id: string, after: number, cursor: number, events: ConferenceRecord[]): Promise<number> {
    return applySubscriptionHistory(this, conference, id, after, cursor, events)
  }
  async flush(): Promise<void> {
    return flush(this)
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
    return recordPeerOutcomes(this, records, limits, removal)
  }
  /** Full private copies for the trusted service. Never exposed publicly. */
  storedPeerMemory(): PeerMemoryRecord[] {
    return storedPeerMemory(this)
  }
  /** Public counts only: no identities, statements, vectors or outcomes. */
  peerMemoryStats(now?: number): { count: number, bytes: number } {
    return peerMemoryStats(this, now)
  }
  /** Earliest expiry among stored records, or undefined when empty. */
  nextPeerMemoryExpiry(): number | undefined {
    return nextPeerMemoryExpiry(this)
  }
  /**
   * Durably remove expired records, reevaluated against current queued state
   * so a renewal racing a stale timer survives. No save when nothing expires.
   */
  async expirePeerMemory(now?: number): Promise<number> {
    return expirePeerMemory(this, now)
  }
  /**
   * The latest committed outcome for a peer on a subject, same namespace
   * only. Unknown, expired and unmatched entries score neutral.
   */
  peerOutcome(peer: string, subjectVector: Float32Array, profile: EmbeddingProfile,
    thresholds?: Record<number, number>, now?: number): PeerOutcome {
    return peerOutcome(this, peer, subjectVector, profile, thresholds, now)
  }
  receive(peer: string, value: unknown): Promise<void> {
    return receive(this, peer, value)
  }
  private routeOf(peer: string, room: string, packet: Record<string, unknown>): Promise<MessageRouting | undefined> | undefined {
    return routeOf(this, peer, room, packet)
  }
  private apply(peer: string, room: string, packet: Record<string, unknown>, routed: MessageRouting | undefined): Promise<void> {
    return applyOf(this, peer, room, packet, routed)
  }
}
