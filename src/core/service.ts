
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
export * from './service-types.ts'
import { TOPIC, encode, type Peer, notEnabled, type ConferenceInfoOut, conferenceOut, type ServiceOptions, type ConferenceFeedbackOutcome, type ConferenceFeedback, type PublicSubscription, bytesToHex, unhexBytes, SaveError } from './service-types.ts'
import { orderMatchesByPeerOutcome, recordConference, routeMessage, backfillConferenceHistory, prepareFeedback, checkDisclosure, publishInterest, rememberContact, addressesFor, requireDiscovery, rejectInbound } from './service-conf.ts'
import { start, stop, coreOf, announceStatement, openInterests, matchesFor, subscribeConference, subscriptions, unsubscribeConference, createConference, reviseConference, joinConference, postToConference, conferenceHistory, leaveConference, conferenceList, peerMemoryStats, discover, announce } from './service-api.ts'
import { scheduleExpiry, runMaintenance, expirePeerMemoryRecords, enforcePeerMemoryBounds, expireDueSubscriptions, retryDueCloses, dropUnknownSubscription, dropClosedSubscription, ensureRecovery, cancelRecoveryRoom, runDueRecoveries, recoverRoom, leaveOrphanedRecoveryRoom, queueOrphanHostCleanup } from './service-maint.ts'

export class VortexService {
  transport: Transport;
  save: (s: Snapshot) => void | Promise<void>;
  restored?: Snapshot;
  peers = new Map<string, Peer>();
  conversations?: Conversations;
  name: string;
  interest = '';
  removeDirect?: () => void;
  heartbeat?: ReturnType<typeof setInterval>;
  embedder?: Embedder;
  onError: (message: string) => void;
  discoveryOptions?: ServiceOptions['discovery'];
  discovery?: Discovery;
  conferences?: Conferences;
  conferenceOptions?: ServiceOptions['conferences'];
  retention?: ConversationRetention;
  disclosure?: DisclosureCheck;
  generation = 0;
  conferenceHosts = new Map<string, string>();
  backfilling = new Set<string>();
  pendingLive = new Map<string, ConferenceEvent[]>();
  contacts = new Map<string, string[]>();
  maxSubscriptionCount = 32;
  maxSubscriptionTtl = 86400;
  peerMemoryTtl = 2592000;
  peerMemoryLimits: { maxCount: number, maxBytes: number } = { maxCount: 128, maxBytes: 8388608 };
  running = false;
  expiryTimer?: ReturnType<typeof setTimeout>;
  maintenanceActive = false;
  retryNotBefore = 0;
  pendingClose = new Map<string, { id: string; expires: number; session: string; notBefore: number }>();
  recovery = new Map<string, { failures: number; notBefore: number; active: boolean;
    recheck: boolean; abort?: AbortController; resumePending: boolean }>();
  removePeer?: () => void;
  rejected = { policy: 0, save: 0 };
  constructor(transport: Transport, name: string, save: (s: Snapshot) => void | Promise<void>, restored?: Snapshot, options: ServiceOptions = {}) {
    this.transport = transport; this.name = name; this.save = save; this.restored = restored;
    this.embedder = options.embedder; this.onError = options.onError ?? (() => {});
    this.discoveryOptions = options.discovery; this.conferenceOptions = options.conferences;
    this.retention = options.retention;
    this.disclosure = options.disclosure;
    const maxCount = options.subscriptions?.maxCount ?? 32;
    const maxTtl = options.subscriptions?.maxTtl ?? 86400;
    if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 128) throw new Error('invalid subscription maxCount');
    if (!Number.isInteger(maxTtl) || maxTtl < 1 || maxTtl > 604800) throw new Error('invalid subscription maxTtl');
    this.maxSubscriptionCount = maxCount;
    this.maxSubscriptionTtl = maxTtl;
    const peerTtl = options.peerMemory?.ttl ?? 2592000;
    if (!Number.isInteger(peerTtl) || peerTtl < 1 || peerTtl > 31536000) throw new Error('invalid peer memory ttl');
    this.peerMemoryTtl = peerTtl;
    this.peerMemoryLimits = validatePeerMemoryLimits({ maxCount: options.peerMemory?.maxCount, maxBytes: options.peerMemory?.maxBytes });
  }
  private requireDiscovery(): Discovery {
    return requireDiscovery(this)
  }
  private rememberContact(peer: string, addrs: string[]): void {
    return rememberContact(this, peer, addrs)
  }
  private addressesFor(peer: string): string[] | undefined {
    return addressesFor(this, peer)
  }
  async start(): Promise<TransportInfo> {
    return start(this)
  }
  core(): Conversations {
    return coreOf(this)
  }
  info(): TransportInfo { return this.transport.info(); }
  inboundRejections(): { policy: number; save: number } { return { ...this.rejected }; }
  /** Count and log a rejected inbound direct packet; never logs the packet, peer text or error message. */
  private rejectInbound(e: unknown): void {
    return rejectInbound(this, e)
  }
  semanticNamespace(): string | undefined { return this.embedder?.profile().id; }
  async announceStatement(request: { session: string; statement: string; ttl?: number;
    publishStatement?: boolean; replaces?: string }): Promise<{ id: string; expires: number }> {
    return announceStatement(this, request)
  }
  withdrawInterest(session: string, id: string): boolean { return this.requireDiscovery().withdraw(session, id); }
  endSession(session: string): string[] { return this.requireDiscovery().endSession(session); }
  openInterests(session?: string): { id: string; session: string; statement: string; expires: number }[] {
    return openInterests(this, session)
  }
  matchesFor(id: string): { peer: string; tier: 'exact' | number; score: number; fullScore: number;
    kind: 'interest' | 'conference'; addrs: string[]; statement?: string; record: string;
    host?: string; count?: number; capacity?: number; admission?: 'open' | 'invitation' | 'group'; expires?: number }[] {
    return matchesFor(this, id)
  }
  /**
   * Stable subject-scoped preference over already-admitted matches only:
   * useful first, then neutral, then misleading. Never admits, removes or
   * annotates a candidate, and never publishes anything.
   */
  private orderMatchesByPeerOutcome(id: string, matches: MatchFound[]): MatchFound[] {
    return orderMatchesByPeerOutcome(this, id, matches)
  }
  private recordConference(event: ConferenceEvent): void {
    return recordConference(this, event)
  }
  async subscribeConference(request: { session: string; conference: string; ttl: number }): Promise<PublicSubscription> {
    return subscribeConference(this, request)
  }
  subscriptions(session?: string): PublicSubscription[] {
    return subscriptions(this, session)
  }
  async unsubscribeConference(session: string, conference: string, feedback?: ConferenceFeedback): Promise<boolean> {
    return unsubscribeConference(this, session, conference, feedback)
  }
  /** Topic routing: match a direct message body against this owner's own conferences (VORTEX_v5.1.md §§4–5). */
  private async routeMessage(body: string): Promise<MessageRouting | undefined> {
    return routeMessage(this, body)
  }
  async createConference(request: { session: string; statement: string } & ConferenceCreationOptions): Promise<ConferenceInfoOut> {
    return createConference(this, request)
  }
  async reviseConference(request: { session: string; conference: string; statement: string }): Promise<ConferenceInfoOut> {
    return reviseConference(this, request)
  }
  async joinConference(request: { session: string; ref: string }, timeoutMs = 20000): Promise<ConferenceInfoOut> {
    return joinConference(this, request, timeoutMs)
  }
  private async backfillConferenceHistory(info: { id: string; session: string; host: string }): Promise<void> {
    return backfillConferenceHistory(this, info)
  }

  async postToConference(request: { session: string; conference: string; text: string; type?: string; replyTo?: string }):
    Promise<{ posted: true; message: string }> {
    return postToConference(this, request)
  }
  async conferenceHistory(request: { session: string; conference: string; after?: number; limit?: number; timeout?: number }, signal?: AbortSignal) {
    return conferenceHistory(this, request, signal)
  }
  async leaveConference(session: string, conference: string, feedback?: ConferenceFeedback): Promise<boolean> {
    return leaveConference(this, session, conference, feedback)
  }

  /**
   * Validate feedback and build its records without side effects beyond one
   * override embedding. The caller owns the atomic save and the leave.
   */
  private async prepareFeedback(core: Conversations, engine: Conferences, ownSession: string, room: string,
    feedback: ConferenceFeedback, checkCurrent: () => void): Promise<PeerMemoryRecord[]> {
    return prepareFeedback(this, core, engine, ownSession, room, feedback, checkCurrent)
  }
  conferenceList(session?: string): ConferenceInfoOut[] {
    return conferenceList(this, session)
  }
  /** Private memory counts only: no sources, participants, outcomes or vectors. */
  peerMemoryStats(): { count: number, bytes: number } {
    return peerMemoryStats(this)
  }
  discover(): Peer[] {
    return discover(this)
  }
  async dial(addr: string): Promise<string> { return this.transport.dial(addr); }
  async announce(text: string): Promise<void> {
    return announce(this, text)
  }
  private async checkDisclosure(kind: 'announcement' | 'message', namespace: string, text: string): Promise<void> {
    return checkDisclosure(this, kind, namespace, text)
  }
  private async publishInterest(text: string): Promise<void> {
    return publishInterest(this, text)
  }
  async stop(): Promise<void> {
    return stop(this)
  }
  /** One timer for expiry and close/orphan retries: earliest safe deadline, never before backoff. */
  private scheduleExpiry(): void {
    return scheduleExpiry(this)
  }
  private async runMaintenance(generation: number, core: Conversations): Promise<void> {
    return runMaintenance(this, generation, core)
  }
  /** Durably expire peer-memory records; a failed save backs off and retries. */
  private async expirePeerMemoryRecords(generation: number, core: Conversations): Promise<void> {
    return expirePeerMemoryRecords(this, generation, core)
  }
  /**
   * Shrink an over-bound restored cache through the bounded store transaction,
   * only when it actually exceeds the configured count or bytes. A failed save
   * keeps the persisted records and backs off through the shared timer.
   */
  private async enforcePeerMemoryBounds(generation: number, core: Conversations): Promise<void> {
    return enforcePeerMemoryBounds(this, generation, core)
  }
  private async expireDueSubscriptions(generation: number, core: Conversations): Promise<void> {
    return expireDueSubscriptions(this, generation, core)
  }
  private async retryDueCloses(generation: number, core: Conversations): Promise<void> {
    return retryDueCloses(this, generation, core)
  }
  /**
   * Durably drop a subscription whose room definitively no longer exists at
   * the expected host. The guarded removal keeps a renewed or replaced record;
   * a failed save retries through the shared close-retry timer.
   */
  private async dropUnknownSubscription (room: string, captured: { id: string, expires: number, session: string },
    core: Conversations, engine: Conferences, generation: number): Promise<void> {
    return dropUnknownSubscription(this, room, captured, core, engine, generation)
  }

  private dropClosedSubscription(conference: string, generation: number, core: Conversations): void {
    return dropClosedSubscription(this, conference, generation, core)
  }
  /** Start (or recheck after) the single active recovery attempt for a room. */
  private ensureRecovery (room: string): void {
    return ensureRecovery(this, room)
  }

  /** Abort an owned attempt and forget its retry state; never touches another run. */
  private cancelRecoveryRoom (room: string): void {
    return cancelRecoveryRoom(this, room)
  }

  /** Start attempts whose backoff has elapsed. Called inside the maintenance pass. */
  private runDueRecoveries (generation: number, core: Conversations): void {
    return runDueRecoveries(this, generation, core)
  }

  private async recoverRoom (room: string, captured: { id: string, expires: number, session: string, host: string },
    generation: number, core: Conversations, engine: Conferences,
    rec: { failures: number, notBefore: number, active: boolean,
      recheck: boolean, abort?: AbortController, resumePending: boolean }): Promise<void> {
    return recoverRoom(this, room, captured, generation, core, engine, rec)
  }

  /** Leave a recovery-owned membership only: still ours, wanted by nobody. */
  private async leaveOrphanedRecoveryRoom (room: string, captured: { id: string, session: string },
    core: Conversations, engine: Conferences): Promise<void> {
    return leaveOrphanedRecoveryRoom(this, room, captured, core, engine)
  }

  private queueOrphanHostCleanup(): void {
    return queueOrphanHostCleanup(this)
  }
}
