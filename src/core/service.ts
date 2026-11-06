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

const TOPIC = '/vortex/local-discovery/1';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export type Peer = { id: string; name: string; interest: string; addrs: string[]; expires: number;
  trust: 'untrusted_peer_content' };
const notEnabled = 'semantic discovery is not enabled: start the service with --semantic';
export type ConferenceInfoOut = Omit<ConferenceInfo, 'descriptor'> & { count: number; capacity: number; expires: number; admission: 'open' | 'invitation' | 'group'; revision: number };
const conferenceOut = (info: ConferenceInfo): ConferenceInfoOut => ({ id: info.id, role: info.role,
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
const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhexBytes = (text: string): Uint8Array => {
  if (typeof text !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error('invalid cached membership');
  return Uint8Array.from(text.match(/../g) as string[], pair => parseInt(pair, 16));
};
class SaveError extends Error {}
export class VortexService {
  private transport: Transport;
  private save: (s: Snapshot) => void | Promise<void>;
  private restored?: Snapshot;
  private peers = new Map<string, Peer>();
  private conversations?: Conversations;
  private name: string;
  private interest = '';
  private removeDirect?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private embedder?: Embedder;
  private onError: (message: string) => void;
  private discoveryOptions?: ServiceOptions['discovery'];
  private discovery?: Discovery;
  private conferences?: Conferences;
  private conferenceOptions?: ServiceOptions['conferences'];
  private retention?: ConversationRetention;
  private disclosure?: DisclosureCheck;
  private generation = 0;
  private conferenceHosts = new Map<string, string>();
  private backfilling = new Set<string>();
  private pendingLive = new Map<string, ConferenceEvent[]>();
  private contacts = new Map<string, string[]>();
  private maxSubscriptionCount = 32;
  private maxSubscriptionTtl = 86400;
  private peerMemoryTtl = 2592000;
  private peerMemoryLimits: { maxCount: number, maxBytes: number } = { maxCount: 128, maxBytes: 8388608 };
  private running = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private maintenanceActive = false;
  private retryNotBefore = 0;
  private pendingClose = new Map<string, { id: string; expires: number; session: string; notBefore: number }>();
  private recovery = new Map<string, { failures: number; notBefore: number; active: boolean;
    recheck: boolean; abort?: AbortController; resumePending: boolean }>();
  private removePeer?: () => void;
  private rejected = { policy: 0, save: 0 };
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
    const discovery = this.discovery;
    if (!discovery) throw new Error(notEnabled);
    return discovery;
  }
  private rememberContact(peer: string, addrs: string[]): void {
    this.contacts.delete(peer);
    this.contacts.set(peer, [...addrs]);
    while (this.contacts.size > 256) {
      const oldest = this.contacts.keys().next().value;
      if (oldest === undefined) break;
      this.contacts.delete(oldest);
    }
  }
  private addressesFor(peer: string): string[] | undefined {
    const known = this.contacts.get(peer);
    if (known) return [...known];
    const legacy = this.peers.get(peer);
    if (legacy && legacy.expires > Date.now()) return legacy.addrs;
    return undefined;
  }
  async start(): Promise<TransportInfo> {
    this.generation++;
    const info = await this.transport.start();
    this.conversations = new Conversations(info.peerId, {
      send: async (peer, packet) => {
        if (packet.kind === 'message') await this.checkDisclosure('message', 'legacy', packet.body);
        await this.transport.send(peer, encode(packet), this.addressesFor(peer));
      },
      save: async s => { try { await this.save(s); } catch (e) { throw new SaveError(e instanceof Error ? e.message : String(e), { cause: e }); } },
      ...(this.embedder ? { route: (_peer: string, body: string) => this.routeMessage(body) } : {})
    }, this.restored, this.retention);
    this.removeDirect = this.transport.onDirect(event => {
      try { this.core().receive(event.from, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data))).catch(e => this.rejectInbound(e)); }
      catch (e) { this.rejectInbound(e); /* Invalid peer packets have no authority to alter local state. */ }
    });
    await this.transport.subscribe(TOPIC, event => {
      try {
        if (event.data.byteLength > 8192) return 'reject';
        const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data));
        if (p.id !== event.origin || typeof p.name !== 'string' || p.name.length > 64 ||
          typeof p.interest !== 'string' || new TextEncoder().encode(p.interest).length > 4096 ||
          !Array.isArray(p.addrs) || p.addrs.length > 8 || !p.addrs.every((a: unknown) => typeof a === 'string' && a.length < 512 && a.endsWith('/p2p/' + event.origin)) ||
          !Number.isFinite(p.expires) || p.expires <= Date.now() || p.expires > Date.now() + 120000) return 'reject';
        if (p.id !== info.peerId && (this.peers.has(p.id) || this.peers.size < 100))
          this.peers.set(p.id, {id:p.id,name:p.name,interest:p.interest,addrs:p.addrs,expires:p.expires,trust:'untrusted_peer_content'});
        return 'accept';
      } catch { return 'reject'; }
    });
    if (this.embedder) {
      const discovery = new Discovery({ transport: this.transport, embedder: this.embedder,
        ...(this.discoveryOptions ?? {}),
        checkOutbound: statement => this.checkDisclosure('announcement', this.embedder!.profile().id, statement),
        conferences: () => this.conferences?.hostedRecords() ?? [],
        onMatch: (match) => {
          this.rememberContact(match.peer, match.addrs);
          this.core().recordMatch({ interest: match.interest, record: match.record.id, recordKind: match.kind, peer: match.peer, tier: match.tier.tier,
            score: match.tier.score, fullScore: match.fullScore, addrs: match.addrs,
            ...(match.kind === 'interest' && match.record.statement !== undefined ? { statement: match.record.statement } : {}) })
            .catch(() => { this.onError('match for interest ' + match.interest + ' could not be saved'); });
        } });
      this.discovery = discovery;
      await discovery.start();
      const embedder = this.embedder;
      this.conferences = new Conferences({ transport: this.transport,
        profile: ns => ns === embedder.profile().id ? embedder.profile() : undefined,
        formable: id => {
          const interest = discovery.interests().find(i => i.id === id);
          return interest && { id: interest.id, session: interest.session,
            namespace: interest.announcement.namespace, topicVector: interest.announcement.vector,
            statement: interest.statement };
        }, ...(this.conferenceOptions ?? {}), onEvent: event => this.recordConference(event) });
      this.conferences.start();
    }
    this.heartbeat = setInterval(() => { void this.publishInterest(this.interest).catch(() => {}); }, 5000);
    try { await this.publishInterest(''); }
    catch (error) { if (!(error instanceof DisclosureError)) throw error; }
    if (this.conferences && this.discovery) {
      this.running = true;
      this.maintenanceActive = false;
      this.retryNotBefore = 0;
      this.queueOrphanHostCleanup();
      void this.enforcePeerMemoryBounds(this.generation, this.core()).catch(() => {});
      this.removePeer = this.transport.onPeer(event => {
        if (event.kind !== 'connect') return;
        const core = this.conversations;
        if (!core) return;
        for (const sub of Object.values(core.storedSubscriptions())) {
          if (sub.host === event.peer && sub.expires > Date.now()) this.ensureRecovery(sub.conference);
        }
      });
      for (const sub of Object.values(this.core().storedSubscriptions())) {
        if (sub.expires > Date.now()) this.ensureRecovery(sub.conference);
      }
      this.scheduleExpiry();
    }
    return info;
  }
  core(): Conversations {
    if (!this.conversations) throw new Error('service not started');
    return this.conversations;
  }
  info(): TransportInfo { return this.transport.info(); }
  inboundRejections(): { policy: number; save: number } { return { ...this.rejected }; }
  /** Count and log a rejected inbound direct packet; never logs the packet, peer text or error message. */
  private rejectInbound(e: unknown): void {
    const kind = e instanceof SaveError ? 'save' : 'policy';
    this.rejected[kind]++;
    console.error(`vortex: inbound direct packet rejected (${kind})`);
  }
  semanticNamespace(): string | undefined { return this.embedder?.profile().id; }
  async announceStatement(request: { session: string; statement: string; ttl?: number;
    publishStatement?: boolean; replaces?: string }): Promise<{ id: string; expires: number }> {
    const discovery = this.requireDiscovery();
    const id = await discovery.announce(request);
    const stored = discovery.interests().find(interest => interest.id === id);
    if (!stored) throw new Error('announcement vanished after publish');
    return { id, expires: stored.expires };
  }
  withdrawInterest(session: string, id: string): boolean { return this.requireDiscovery().withdraw(session, id); }
  endSession(session: string): string[] { return this.requireDiscovery().endSession(session); }
  openInterests(session?: string): { id: string; session: string; statement: string; expires: number }[] {
    return this.requireDiscovery().interests(session)
      .map(interest => ({ id: interest.id, session: interest.session, statement: interest.statement, expires: interest.expires }));
  }
  matchesFor(id: string): { peer: string; tier: 'exact' | number; score: number; fullScore: number;
    kind: 'interest' | 'conference'; addrs: string[]; statement?: string; record: string;
    host?: string; count?: number; capacity?: number; admission?: 'open' | 'invitation' | 'group'; expires?: number }[] {
    const discovery = this.requireDiscovery();
    const ordered = this.orderMatchesByPeerOutcome(id, discovery.matches(id));
    const ranked = ordered.map(match => ({ kind: match.kind, peer: match.peer, tier: match.tier.tier,
      score: match.tier.score, fullScore: match.fullScore, addrs: [...match.addrs],
      ...(match.kind === 'interest' && match.record.statement !== undefined ? { statement: match.record.statement } : {}), record: match.record.id,
      ...(match.kind === 'conference' ? { host: match.record.host, count: match.record.participantCount,
        capacity: match.record.capacity, admission: match.record.admission, expires: match.record.expiresAt } : {}) }));
    return ranked;
  }
  /**
   * Stable subject-scoped preference over already-admitted matches only:
   * useful first, then neutral, then misleading. Never admits, removes or
   * annotates a candidate, and never publishes anything.
   */
  private orderMatchesByPeerOutcome(id: string, matches: MatchFound[]): MatchFound[] {
    try {
      const interest = this.requireDiscovery().interests().find(entry => entry.id === id);
      if (interest === undefined || this.embedder === undefined) return matches;
      const profile = this.embedder.profile();
      if (interest.announcement.namespace !== profile.id ||
        interest.announcement.profileVersion !== profile.version) return matches;
      const core = this.conversations;
      if (core === undefined) return matches;
      const thresholds = this.discoveryOptions?.thresholds;
      const classes = new Map<string, number>();
      for (const match of matches) {
        if (!classes.has(match.peer)) {
          let outcome = 'neutral';
          try {
            outcome = core.peerOutcome(match.peer, interest.announcement.vector, profile, thresholds);
          } catch {
            outcome = 'neutral';
          }
          classes.set(match.peer, outcome === 'useful' ? 0 : outcome === 'misleading' ? 2 : 1);
        }
      }
      return matches.map((match, index) => ({ match, index }))
        .sort((a, b) => (classes.get(a.match.peer) ?? 1) - (classes.get(b.match.peer) ?? 1) || a.index - b.index)
        .map(entry => entry.match);
    } catch {
      return matches;
    }
  }
  private recordConference(event: ConferenceEvent): void {
    const host = this.conferences?.get(event.conference)?.host ?? this.conferenceHosts.get(event.conference);
    if (host) this.conferenceHosts.set(event.conference, host);
    const peer = 'service' in event ? event.service : host ?? this.info().peerId;
    if (event.kind === 'closed') this.conferenceHosts.delete(event.conference);
    if (event.kind === 'message' && this.backfilling.has(event.conference)) {
      const queue = this.pendingLive.get(event.conference);
      if (queue !== undefined) { queue.push(event); return; }
    }
    const record = event.kind === 'message' ? {
      kind: 'conference_message' as const, conference: event.conference, session: event.session, peer,
      participant: event.message.sender, service: event.service, message: event.message.id,
      type: event.message.type, ...(event.message.replyTo === undefined ? {} : { replyTo: event.message.replyTo }),
      body: new TextDecoder('utf-8', { fatal: false }).decode(event.message.content),
      ...(event.backlog === undefined ? {} : { backlog: event.backlog })
    } : { ...event, peer };
    const generation = this.generation;
    const core = this.conversations;
    const done = this.core().recordConference(record)
      .catch(() => { this.onError('conference event for ' + event.conference + ' could not be saved'); });
    if (event.kind === 'closed' && core) {
      void done.then(() => { this.dropClosedSubscription(event.conference, generation, core); });
    }
  }
  async subscribeConference(request: { session: string; conference: string; ttl: number }): Promise<PublicSubscription> {
    const session = request.session;
    const conference = request.conference;
    const ttl = request.ttl;
    this.requireDiscovery();
    if (typeof session !== 'string' || session.length < 1 || session.length > 128) throw new Error('invalid subscription session');
    if (!/^[0-9a-f]{32}$/.test(conference)) throw new Error('invalid subscription conference');
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > this.maxSubscriptionTtl) throw new Error('invalid subscription ttl');
    const conferences = this.conferences!;
    const info = conferences.get(conference);
    if (!info || info.session !== session) throw new Error('not a member of this conference with this session');
    const expires = Math.min(Date.now() + ttl * 1000, info.descriptor.expiresAt);
    let membership: { descriptor: string; privateKey: string } | undefined;
    let subject: PeerMemorySubject | undefined;
    if (info.role !== 'host') {
      const saved = conferences.exportMembership(conference, session);
      membership = { descriptor: bytesToHex(saved.descriptor), privateKey: bytesToHex(saved.privateKey) };
      const held = conferences.membershipSubject(conference, session);
      if (held !== undefined) subject = held;
    }
    const generation = this.generation;
    const core = this.core();
    const engine = this.conferences!;
    const stored = await core.setSubscription({ conference, session, host: info.host, expires,
      ...(membership === undefined ? {} : { membership }),
      ...(subject === undefined ? {} : { subject }) }, this.maxSubscriptionCount);
    if (!this.running || generation !== this.generation || this.conversations !== core || this.conferences !== engine) {
      throw new Error('service stopped during subscribe');
    }
    if (engine.get(conference) === undefined) {
      this.pendingClose.set(conference, { id: stored.id, expires: stored.expires, session, notBefore: Date.now() });
      this.scheduleExpiry();
      throw new Error('conference closed during subscribe');
    }
    this.scheduleExpiry();
    this.ensureRecovery(conference);
    return { conference: stored.conference, session: stored.session, host: stored.host,
      expires: stored.expires, historyCursor: stored.historyCursor };
  }
  subscriptions(session?: string): PublicSubscription[] {
    this.requireDiscovery();
    return this.core().subscriptions(session);
  }
  async unsubscribeConference(session: string, conference: string, feedback?: ConferenceFeedback): Promise<boolean> {
    this.requireDiscovery();
    const ownSession = session;
    const room = conference;
    const generation = this.generation;
    const core = this.core();
    const engine = this.conferences!;
    const checkCurrent = (): void => {
      if (generation !== this.generation) throw new Error('service stopped during unsubscribe');
    };
    let removed = false;
    try {
      if (feedback === undefined) {
        removed = await core.removeSubscription(ownSession, room);
      } else {
        const owned = core.storedSubscriptions()[room];
        if (owned === undefined || owned.session !== ownSession) return false;
        const atCall = engine.get(room);
        const records = await this.prepareFeedback(core, engine, ownSession, room, feedback, checkCurrent);
        const current = core.storedSubscriptions()[room];
        if (current === undefined || current.session !== ownSession ||
          current.id !== owned.id || current.expires !== owned.expires) {
          throw new Error('membership changed during feedback');
        }
        const before = engine.get(room);
        if (before === undefined || before.session !== ownSession ||
          atCall === undefined || atCall.session !== ownSession || before.key !== atCall.key) {
          throw new Error('membership changed during feedback');
        }
        const outcome = await core.recordPeerOutcomes(records, this.peerMemoryLimits,
          { session: ownSession, conference: room, expected: { id: owned.id, expires: owned.expires } });
        removed = outcome.unsubscribed;
        checkCurrent();
        const after = engine.get(room);
        if (after === undefined || after.session !== ownSession || after.key !== before.key) {
          if (this.running && generation === this.generation && this.conversations === core) this.scheduleExpiry();
          return removed;
        }
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error('subscription removal failed');
    }
    if (!this.running || generation !== this.generation || this.conversations !== core || this.conferences !== engine) {
      return removed;
    }
    if (removed) this.cancelRecoveryRoom(room);
    this.scheduleExpiry();
    if (!removed) return false;
    const info = engine.get(room);
    if (info && info.session === ownSession) {
      await engine.leave(room, ownSession);
    }
    return true;
  }
  /** Topic routing: match a direct message body against this owner's own conferences (VORTEX_v5.1.md §§4–5). */
  private async routeMessage(body: string): Promise<MessageRouting | undefined> {
    const embedder = this.embedder, conferences = this.conferences?.list() ?? [];
    if (!embedder || conferences.length === 0) return undefined;
    const vector = await embedder.embed(body);
    const profile = embedder.profile();
    return routeToConference(vector, conferences, profile, routingThresholds(profile, this.discoveryOptions?.thresholds)) ?? undefined;
  }
  async createConference(request: { session: string; statement: string } & ConferenceCreationOptions): Promise<ConferenceInfoOut> {
    request = { ...request, peers: Array.isArray(request.peers) ? [...request.peers] : request.peers };
    this.requireDiscovery();
    const generation = this.generation;
    const conferences = this.conferences!;
    if (typeof request.session !== 'string' || request.session.length < 1 || request.session.length > 128)
      throw new Error('session must contain 1 to 128 characters');
    if (typeof request.statement !== 'string' || !request.statement || new TextEncoder().encode(request.statement).length > 4096)
      throw new Error('statement must contain 1–4096 bytes');
    validateConferenceCreationOptions(request);
    const checkCurrent = (): void => {
      if (generation !== this.generation) throw new Error('service stopped during conference creation');
    };
    await this.checkDisclosure('announcement', this.embedder!.profile().id, request.statement);
    checkCurrent();
    const topicVector = await this.embedder!.embed(request.statement);
    checkCurrent();
    const info = await conferences.create({ session: request.session, namespace: this.embedder!.profile().id,
      topicVector, statement: request.statement, capacity: request.capacity, admission: request.admission, peers: request.peers });
    checkCurrent();
    this.conferenceHosts.set(info.id, info.host);
    return conferenceOut(info);
  }
  async reviseConference(request: { session: string; conference: string; statement: string }): Promise<ConferenceInfoOut> {
    request = { ...request };
    this.requireDiscovery();
    const generation = this.generation;
    const conferences = this.conferences!;
    if (typeof request.session !== 'string' || request.session.length < 1 || request.session.length > 128)
      throw new Error('session must contain 1 to 128 characters');
    if (!/^(?:[0-9a-f]{32})$/.test(request.conference)) throw new Error('invalid conference id');
    if (typeof request.statement !== 'string' || !request.statement || new TextEncoder().encode(request.statement).length > 4096)
      throw new Error('statement must contain 1–4096 bytes');
    const owned = conferences.get(request.conference);
    if (owned === undefined || owned.role !== 'host' || owned.session !== request.session)
      throw new Error('not hosting this conference with this session');
    const checkCurrent = (): void => {
      if (generation !== this.generation) throw new Error('service stopped during conference revision');
    };
    await this.checkDisclosure('announcement', this.embedder!.profile().id, request.statement);
    checkCurrent();
    const topicVector = await this.embedder!.embed(request.statement);
    checkCurrent();
    const info = await conferences.reviseTopic({ conference: request.conference, session: request.session,
      topicVector, statement: request.statement });
    checkCurrent();
    return conferenceOut(info);
  }
  async joinConference(request: { session: string; ref: string }, timeoutMs = 20000): Promise<ConferenceInfoOut> {
    const discovery = this.requireDiscovery();
    const match = discovery.interests(request.session).flatMap(i => discovery.matches(i.id))
      .find(m => m.record.id === request.ref);
    if (!match) throw new Error('no match with that record: read your match events and use the record of one');
    const original = discovery.interests(request.session).find(i => i.id === match.interest);
    const subject: PeerMemorySubject | undefined = original === undefined ? undefined : {
      statement: original.statement,
      vector: bytesToHex(encodeVector(original.announcement.vector)),
      namespace: original.announcement.namespace,
      profileVersion: original.announcement.profileVersion };
    const conferences = this.conferences!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await Promise.race([
        conferences.join({ session: request.session, ref: request.ref, host: match.peer,
          addrs: match.addrs, ownInterest: match.interest, subject }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('join timed out: the holder did not answer'));
            conferences.abandon(request.ref);
          }, timeoutMs);
        })
      ]);
      this.conferenceHosts.set(info.id, info.host);
      try {
        await this.backfillConferenceHistory(info);
      } catch {
        this.onError('conference history backfill failed');
        try {
          await this.core().recordConference({ kind: 'conference_message', conference: info.id, session: info.session,
            peer: info.host, type: 'vortex.history-unavailable', body: 'earlier messages could not be fetched', backlog: true });
        } catch { this.onError('conference history unavailable notice failed'); }
      }
      return conferenceOut(info);
    } finally { clearTimeout(timer); }
  }
  private async backfillConferenceHistory(info: { id: string; session: string; host: string }): Promise<void> {
    const core = this.core();
    this.backfilling.add(info.id);
    this.pendingLive.set(info.id, []);
    try {
      let after = 0;
      for (;;) {
        const page = await this.conferences!.history({ conference: info.id, session: info.session, after, limit: 20, timeoutMs: 20000 });
        if (after === 0 && page.firstAvailable > 1) {
          await core.recordConference({ kind: 'conference_message', conference: info.id, session: info.session,
            peer: info.host, type: 'vortex.history-gap',
            body: `${page.firstAvailable - 1} earlier messages are not retained`, backlog: true });
        }
        for (const record of page.records) {
          const message = record.message;
          await core.recordConference({ kind: 'conference_message', conference: info.id, session: info.session,
            peer: record.service, participant: message.sender, service: record.service, message: message.id,
            type: message.type, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
            body: new TextDecoder('utf-8', { fatal: false }).decode(message.content), backlog: true });
        }
        after = page.cursor;
        if (!page.more) break;
      }
    } finally {
      this.backfilling.delete(info.id);
      const queue = this.pendingLive.get(info.id) ?? [];
      this.pendingLive.delete(info.id);
      for (const event of queue) this.recordConference(event);
    }
  }

  async postToConference(request: { session: string; conference: string; text: string; type?: string; replyTo?: string }):
    Promise<{ posted: true; message: string }> {
    request = { ...request };
    this.requireDiscovery();
    if (typeof request.text !== 'string' || !request.text || new TextEncoder().encode(request.text).length > 16384)
      throw new Error('message must contain 1–16384 bytes');
    await this.checkDisclosure('message', this.conferences!.get(request.conference)?.descriptor.namespace ?? this.embedder!.profile().id, request.text);
    const message = await this.conferences!.post(request.conference, request.session,
      { type: request.type ?? 'text', content: new TextEncoder().encode(request.text), replyTo: request.replyTo });
    return { posted: true, message: message.id };
  }
  async conferenceHistory(request: { session: string; conference: string; after?: number; limit?: number; timeout?: number }, signal?: AbortSignal) {
    request = { ...request };
    this.requireDiscovery();
    if (request.timeout !== undefined && (!Number.isSafeInteger(request.timeout) || request.timeout < 1 || request.timeout > 60))
      throw new Error('history timeout must be 1 to 60 seconds');
    const page = await this.conferences!.history({ ...request, signal, timeoutMs: request.timeout === undefined ? undefined : request.timeout * 1000 });
    return { conference: request.conference, historyCursor: page.cursor, firstAvailable: page.firstAvailable,
      latest: page.latest, more: page.more, messages: page.records.map(({ sequence, message, service }) => ({
        sequence, message: message.id, participant: message.sender, service, timestamp: message.timestamp,
        type: message.type, body: new TextDecoder().decode(message.content),
        ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) })) };
  }
  async leaveConference(session: string, conference: string, feedback?: ConferenceFeedback): Promise<boolean> {
    this.requireDiscovery();
    const ownSession = session;
    const room = conference;
    const generation = this.generation;
    const core = this.core();
    const engine = this.conferences!;
    const checkCurrent = (): void => {
      if (generation !== this.generation) throw new Error('service stopped during leave');
    };
    let removed: boolean;
    if (feedback === undefined) {
      removed = await core.removeSubscription(ownSession, room);
    } else {
      const owned = core.storedSubscriptions()[room];
      const mine = owned !== undefined && owned.session === ownSession ? owned : undefined;
      const atCall = engine.get(room);
      const records = await this.prepareFeedback(core, engine, ownSession, room, feedback, checkCurrent);
      const current = mine === undefined ? undefined : core.storedSubscriptions()[room];
      if (mine !== undefined && (current === undefined || current.session !== ownSession ||
        current.id !== mine.id || current.expires !== mine.expires)) {
        throw new Error('membership changed during feedback');
      }
      const before = engine.get(room);
      if (before === undefined || before.session !== ownSession ||
        atCall === undefined || atCall.session !== ownSession || before.key !== atCall.key) {
        throw new Error('membership changed during feedback');
      }
      const outcome = await core.recordPeerOutcomes(records, this.peerMemoryLimits,
        mine === undefined ? { session: ownSession, conference: room }
          : { session: ownSession, conference: room, expected: { id: mine.id, expires: mine.expires } });
      removed = outcome.unsubscribed;
      checkCurrent();
      const after = engine.get(room);
      if (after === undefined || after.session !== ownSession || after.key !== before.key) {
        if (this.running && generation === this.generation && this.conversations === core) this.scheduleExpiry();
        return removed;
      }
      if (mine !== undefined && !removed) {
        // A renewal raced the queued save and kept its incarnation: keep the
        // renewed subscription and membership untouched, but reschedule for
        // the committed feedback.
        if (this.running && generation === this.generation && this.conversations === core) this.scheduleExpiry();
        return false;
      }
    }
    if (!this.running || generation !== this.generation || this.conversations !== core || this.conferences !== engine) {
      throw new Error('service stopped during leave');
    }
    if (removed) this.cancelRecoveryRoom(room);
    this.scheduleExpiry();
    return engine.leave(room, ownSession);
  }

  /**
   * Validate feedback and build its records without side effects beyond one
   * override embedding. The caller owns the atomic save and the leave.
   */
  private async prepareFeedback(core: Conversations, engine: Conferences, ownSession: string, room: string,
    feedback: ConferenceFeedback, checkCurrent: () => void): Promise<PeerMemoryRecord[]> {
    if (feedback === undefined || feedback === null || typeof feedback !== 'object') {
      throw new Error('invalid feedback outcomes');
    }
    const raw = (feedback as { outcomes?: unknown }).outcomes;
    const statement = (feedback as { statement?: unknown }).statement;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 256) {
      throw new Error('invalid feedback outcomes');
    }
    if (raw.length > this.peerMemoryLimits.maxCount) {
      throw new Error('invalid feedback outcomes');
    }
    const seen = new Set<string>();
    const outcomes: { participant: string, outcome: ConferenceFeedbackOutcome }[] = [];
    for (const entry of raw) {
      const participant = (entry as { participant?: unknown } | null | undefined)?.participant;
      const outcome = (entry as { outcome?: unknown } | null | undefined)?.outcome;
      if (typeof participant !== 'string' || !/^(?:[0-9a-f]{64})$/.test(participant)) throw new Error('invalid feedback participant');
      if (outcome !== 'useful' && outcome !== 'neutral' && outcome !== 'misleading') throw new Error('invalid feedback outcome');
      if (seen.has(participant)) throw new Error('invalid feedback participant');
      seen.add(participant);
      outcomes.push({ participant, outcome: outcome as ConferenceFeedbackOutcome });
    }
    if (statement !== undefined && (typeof statement !== 'string' || statement.length < 1 ||
      new TextEncoder().encode(statement).length > 4096)) throw new Error('invalid feedback statement');
    const info = engine.get(room);
    if (info === undefined || info.session !== ownSession) throw new Error('invalid feedback member');
    const ownKey = info.key;
    for (const outcome of outcomes) {
      if (outcome.participant === ownKey) throw new Error('invalid feedback participant');
    }
    const services = new Map<string, PeerId>();
    for (const entry of engine.certifiedParticipants(room, ownSession)) services.set(entry.participant, entry.service);
    const events = core.snapshot().events;
    for (const outcome of outcomes) {
      if (services.has(outcome.participant)) continue;
      const proof = events.find(event => (event.kind === 'arrival' || event.kind === 'conference_message') &&
        event.conference === room && event.session === ownSession && event.participant === outcome.participant &&
        typeof event.service === 'string' && event.service.length > 0);
      if (proof === undefined || proof.service === undefined) throw new Error('invalid feedback participant');
      services.set(outcome.participant, proof.service);
    }
    const profile = this.embedder!.profile();
    let subject: PeerMemorySubject;
    if (statement !== undefined) {
      checkCurrent();
      const vector = await this.embedder!.embed(statement);
      checkCurrent();
      if (!isValidVector(vector, profile)) throw new Error('invalid feedback subject');
      subject = { statement, vector: bytesToHex(encodeVector(vector)),
        namespace: profile.id, profileVersion: profile.version };
      checkPeerMemorySubject(subject);
    } else if (info.role === 'host') {
      const source = engine.hostTopicSource(room, ownSession);
      if (source.statement === undefined) throw new Error('invalid feedback subject');
      subject = { statement: source.statement, vector: bytesToHex(encodeVector(source.topicVector)),
        namespace: source.namespace, profileVersion: source.profileVersion };
      checkPeerMemorySubject(subject);
    } else {
      const held = engine.membershipSubject(room, ownSession);
      if (held === undefined) throw new Error('invalid feedback subject');
      subject = held;
      checkPeerMemorySubject(subject);
    }
    if (subject.namespace !== profile.id || subject.profileVersion !== profile.version) {
      throw new Error('invalid feedback subject');
    }
    const now = Date.now();
    const ttlMs = this.peerMemoryTtl * 1000;
    return outcomes.map(outcome => ({ peer: services.get(outcome.participant)!,
      participant: outcome.participant, namespace: subject.namespace, profileVersion: subject.profileVersion,
      statement: subject.statement, vector: subject.vector, outcome: outcome.outcome,
      recordedAt: now, expires: now + ttlMs }));
  }
  conferenceList(session?: string): ConferenceInfoOut[] {
    this.requireDiscovery();
    return this.conferences!.list(session).map(conferenceOut);
  }
  /** Private memory counts only: no sources, participants, outcomes or vectors. */
  peerMemoryStats(): { count: number, bytes: number } {
    return this.core().peerMemoryStats();
  }
  discover(): Peer[] {
    for (const [id, peer] of this.peers) if (peer.expires <= Date.now()) this.peers.delete(id);
    return structuredClone([...this.peers.values()]);
  }
  async dial(addr: string): Promise<string> { return this.transport.dial(addr); }
  async announce(text: string): Promise<void> {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > 4096) throw new Error('interest exceeds 4096 bytes');
    await this.checkDisclosure('announcement', 'legacy', text);
    await this.publishInterest(text);
    this.interest = text;
  }
  private async checkDisclosure(kind: 'announcement' | 'message', namespace: string, text: string): Promise<void> {
    if (!this.disclosure) return;
    const generation = this.generation;
    await this.disclosure({ kind, namespace, network: 'loopback', text });
    if (generation !== this.generation) throw new DisclosureError('service stopped while checking disclosure');
  }
  private async publishInterest(text: string): Promise<void> {
    await this.checkDisclosure('message', 'legacy', text);
    const info = this.info();
    await this.transport.publish(TOPIC, encode({id:info.peerId,addrs:info.addrs,name:this.name,interest:text,expires:Date.now()+60000}));
  }
  async stop(): Promise<void> {
    this.generation++;
    this.running = false;
    this.maintenanceActive = false;
    this.retryNotBefore = 0;
    clearInterval(this.heartbeat);
    if (this.expiryTimer !== undefined) { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
    this.pendingClose.clear();
    for (const [room, rec] of this.recovery) {
      rec.abort?.abort();
      if (rec.resumePending) this.conferences?.abandon(room);
    }
    this.recovery.clear();
    const core = this.conversations;
    this.conferences?.stop(); this.conferenceHosts.clear();
    if (this.discovery) await this.discovery.stop();
    this.removeDirect?.();
    this.removePeer?.();
    this.removePeer = undefined;
    await this.transport.stop();
    if (core) {
      await core.flush();
      this.restored = core.snapshot();
    }
  }
  /** One timer for expiry and close/orphan retries: earliest safe deadline, never before backoff. */
  private scheduleExpiry(): void {
    if (!this.running) return;
    const core = this.conversations;
    if (!core || !this.conferences || !this.discovery) return;
    if (this.expiryTimer !== undefined) { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
    const generation = this.generation;
    const now = Date.now();
    let next: number | undefined;
    for (const sub of Object.values(core.storedSubscriptions())) {
      if (next === undefined || sub.expires < next) next = sub.expires;
    }
    for (const pending of this.pendingClose.values()) {
      if (next === undefined || pending.notBefore < next) next = pending.notBefore;
    }
    for (const rec of this.recovery.values()) {
      if (rec.failures > 0 && !rec.active && (next === undefined || rec.notBefore < next)) next = rec.notBefore;
    }
    const memory = core.nextPeerMemoryExpiry();
    if (memory !== undefined && (next === undefined || memory < next)) next = memory;
    const overfull = core.peerMemoryStats();
    if (overfull.count > this.peerMemoryLimits.maxCount || overfull.bytes > this.peerMemoryLimits.maxBytes) {
      next = now;
    }
    if (next === undefined) return;
    if (this.retryNotBefore > now) next = Math.max(next, this.retryNotBefore);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      void this.runMaintenance(generation, core);
    }, Math.min(Math.max(0, next - now), 2147483647));
  }
  private async runMaintenance(generation: number, core: Conversations): Promise<void> {
    if (!this.running || generation !== this.generation || this.conversations !== core) return;
    if (this.maintenanceActive) return;
    this.maintenanceActive = true;
    try {
      await this.expireDueSubscriptions(generation, core);
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      await this.retryDueCloses(generation, core);
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      await this.expirePeerMemoryRecords(generation, core);
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      await this.enforcePeerMemoryBounds(generation, core);
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      this.runDueRecoveries(generation, core);
    } finally {
      this.maintenanceActive = false;
      if (this.running && generation === this.generation && this.conversations === core) this.scheduleExpiry();
    }
  }
  /** Durably expire peer-memory records; a failed save backs off and retries. */
  private async expirePeerMemoryRecords(generation: number, core: Conversations): Promise<void> {
    try {
      await core.expirePeerMemory();
    } catch {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      this.onError('peer memory expiry could not be saved');
      this.retryNotBefore = Date.now() + 1000;
    }
  }
  /**
   * Shrink an over-bound restored cache through the bounded store transaction,
   * only when it actually exceeds the configured count or bytes. A failed save
   * keeps the persisted records and backs off through the shared timer.
   */
  private async enforcePeerMemoryBounds(generation: number, core: Conversations): Promise<void> {
    if (!this.running || generation !== this.generation || this.conversations !== core) return;
    const stats = core.peerMemoryStats();
    if (stats.count <= this.peerMemoryLimits.maxCount && stats.bytes <= this.peerMemoryLimits.maxBytes) return;
    try {
      await core.recordPeerOutcomes([], this.peerMemoryLimits);
    } catch {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      this.onError('peer memory bounds could not be saved');
      this.retryNotBefore = Date.now() + 1000;
      this.scheduleExpiry();
    }
  }
  private async expireDueSubscriptions(generation: number, core: Conversations): Promise<void> {
    const now = Date.now();
    const expired = Object.values(core.storedSubscriptions())
      .filter(sub => sub.expires <= now)
      .map(sub => ({ conference: sub.conference, session: sub.session, id: sub.id, expires: sub.expires }));
    for (const sub of expired) {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      let removed = false;
      try {
        removed = await core.removeSubscription(sub.session, sub.conference, { id: sub.id, expires: sub.expires });
      } catch {
        if (!this.running || generation !== this.generation || this.conversations !== core) return;
        this.onError('subscription expiry could not be saved');
        this.retryNotBefore = Date.now() + 1000;
        return;
      }
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      if (removed) this.cancelRecoveryRoom(sub.conference);
      if (removed && core.storedSubscriptions()[sub.conference] === undefined) {
        const info = this.conferences?.get(sub.conference);
        if (info && info.session === sub.session) {
          await this.conferences!.leave(sub.conference, sub.session);
        }
      }
    }
  }
  private async retryDueCloses(generation: number, core: Conversations): Promise<void> {
    const dueClose: Array<{ conference: string; id: string; expires: number; session: string }> = [];
    for (const [conference, pending] of this.pendingClose) {
      if (pending.notBefore <= Date.now()) dueClose.push({ conference, id: pending.id, expires: pending.expires, session: pending.session });
    }
    for (const sub of dueClose) {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      try {
        await core.removeSubscription(sub.session, sub.conference, { id: sub.id, expires: sub.expires });
      } catch {
        if (!this.running || generation !== this.generation || this.conversations !== core) return;
        this.onError('subscription close could not be saved');
        this.retryNotBefore = Date.now() + 1000;
        const pending = this.pendingClose.get(sub.conference);
        if (pending) pending.notBefore = Date.now() + 1000;
        return;
      }
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      const current = core.storedSubscriptions()[sub.conference];
      if (current === undefined || current.id !== sub.id || current.expires !== sub.expires) {
        this.pendingClose.delete(sub.conference);
      } else {
        this.retryNotBefore = Date.now() + 1000;
        const pending = this.pendingClose.get(sub.conference);
        if (pending) pending.notBefore = Date.now() + 1000;
      }
    }
  }
  /**
   * Durably drop a subscription whose room definitively no longer exists at
   * the expected host. The guarded removal keeps a renewed or replaced record;
   * a failed save retries through the shared close-retry timer.
   */
  private async dropUnknownSubscription (room: string, captured: { id: string, expires: number, session: string },
    core: Conversations, engine: Conferences, generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || this.conversations !== core || this.conferences !== engine) return;
    try {
      await core.removeSubscription(captured.session, room, { id: captured.id, expires: captured.expires });
    } catch {
      if (!this.running || generation !== this.generation || this.conversations !== core || this.conferences !== engine) return;
      this.onError('subscription close could not be saved');
      this.pendingClose.set(room, { id: captured.id, expires: captured.expires, session: captured.session, notBefore: Date.now() + 1000 });
      this.scheduleExpiry();
    }
  }

  private dropClosedSubscription(conference: string, generation: number, core: Conversations): void {
    if (!this.running || generation !== this.generation || this.conversations !== core) return;
    const stored = core.storedSubscriptions()[conference];
    if (!stored) return;
    const captured = { id: stored.id, expires: stored.expires, session: stored.session };
    void core.removeSubscription(captured.session, conference, { id: captured.id, expires: captured.expires }).then(removed => {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      if (removed) {
        this.cancelRecoveryRoom(conference);
        this.scheduleExpiry();
      } else if (core.storedSubscriptions()[conference]?.id !== captured.id) this.scheduleExpiry();
    }).catch(() => {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      this.onError('subscription close could not be saved');
      this.pendingClose.set(conference, { ...captured, notBefore: Date.now() + 1000 });
      this.scheduleExpiry();
    });
  }
  /** Start (or recheck after) the single active recovery attempt for a room. */
  private ensureRecovery (room: string): void {
    if (!this.running) return;
    const core = this.conversations;
    const engine = this.conferences;
    if (!core || !engine || !this.discovery) return;
    const sub = core.storedSubscriptions()[room];
    if (sub === undefined) {
      this.recovery.delete(room);
      return;
    }
    if (sub.expires <= Date.now()) return;
    const generation = this.generation;
    let rec = this.recovery.get(room);
    if (rec === undefined) {
      rec = { failures: 0, notBefore: 0, active: false, recheck: false, resumePending: false };
      this.recovery.set(room, rec);
    }
    if (rec.active) {
      rec.recheck = true;
      return;
    }
    if (rec.failures > 0 && rec.notBefore > Date.now()) {
      rec.recheck = true;
      return;
    }
    rec.active = true;
    rec.recheck = false;
    const captured = { id: sub.id, expires: sub.expires, session: sub.session, host: sub.host };
    void this.recoverRoom(room, captured, generation, core, engine, rec).catch(() => {
      rec.active = false;
    });
  }

  /** Abort an owned attempt and forget its retry state; never touches another run. */
  private cancelRecoveryRoom (room: string): void {
    const rec = this.recovery.get(room);
    if (rec === undefined) return;
    if (rec.resumePending) this.conferences?.abandon(room);
    rec.abort?.abort();
    this.recovery.delete(room);
  }

  /** Start attempts whose backoff has elapsed. Called inside the maintenance pass. */
  private runDueRecoveries (generation: number, core: Conversations): void {
    if (!this.running || generation !== this.generation || this.conversations !== core) return;
    const now = Date.now();
    for (const room of [...this.recovery.keys()]) {
      if (!this.running || generation !== this.generation || this.conversations !== core) return;
      const rec = this.recovery.get(room);
      if (rec === undefined || rec.active || rec.failures === 0 || rec.notBefore > now) continue;
      this.ensureRecovery(room);
    }
  }

  private async recoverRoom (room: string, captured: { id: string, expires: number, session: string, host: string },
    generation: number, core: Conversations, engine: Conferences,
    rec: { failures: number, notBefore: number, active: boolean,
      recheck: boolean, abort?: AbortController, resumePending: boolean }): Promise<void> {
    const startedAt = Date.now();
    const budgetMs = 20000;
    const abort = new AbortController();
    rec.abort = abort;
    const budget = setTimeout(() => {
      abort.abort();
      if (this.conferences === engine && rec.resumePending) engine.abandon(room);
    }, budgetMs);
    try {
      const current = (): RoomSubscription | undefined => {
        const sub = core.storedSubscriptions()[room];
        if (sub === undefined || sub.id !== captured.id || sub.session !== captured.session ||
          sub.host !== captured.host || sub.expires <= Date.now()) return undefined;
        return sub;
      };
      const live = (): boolean =>
        this.running && generation === this.generation && this.conversations === core &&
        this.conferences === engine && this.recovery.get(room) === rec && !abort.signal.aborted;
      let sub = current();
      if (sub === undefined || !live()) return;
      const present = engine.get(room);
      if (present?.role !== 'host') {
        if (sub.membership === undefined) return;
        const descriptorBytes = unhexBytes(sub.membership.descriptor);
        const privateKeyBytes = unhexBytes(sub.membership.privateKey);
        const descriptor = await openDescriptor(descriptorBytes, {
          profile: namespace => {
            const profile = this.embedder?.profile();
            return profile !== undefined && namespace === profile.id ? profile : undefined;
          },
          verify: (peer, data, signature) => this.transport.verify(peer, data, signature),
          now: Date.now()
        });
        if (!live()) return;
        if (descriptor.id !== room || descriptor.host !== sub.host) throw new Error('cached room mismatch');
        rec.resumePending = true;
        let info;
        try {
          info = await engine.resumeMembership(sub.session,
            { descriptor: descriptorBytes, privateKey: privateKeyBytes },
            present === undefined
              ? { signal: abort.signal, subject: sub.subject }
              : { signal: abort.signal, refresh: true });
        } catch (error) {
          if (error instanceof ConferenceRoomUnknownError && error.conference === room && live() &&
            this.recovery.get(room) === rec) {
            rec.failures = 0;
            rec.notBefore = 0;
            await this.dropUnknownSubscription(room, captured, core, engine, generation);
            return;
          }
          throw error;
        } finally {
          rec.resumePending = false;
        }
        if (!live()) {
          await this.leaveOrphanedRecoveryRoom(room, captured, core, engine);
          return;
        }
        if (info.id !== room || info.session !== sub.session || info.host !== sub.host) {
          await this.leaveOrphanedRecoveryRoom(room, captured, core, engine);
          throw new Error('recovered room mismatch');
        }
        const saved = engine.exportMembership(room, sub.session);
        const refreshed = await core.refreshSubscriptionMembership(room, captured.id, {
          descriptor: bytesToHex(saved.descriptor), privateKey: bytesToHex(saved.privateKey)
        }, info.descriptor.expiresAt);
        if (!refreshed) return;
      }
      try {
        for (;;) {
          if (!live()) return;
          sub = current();
          if (sub === undefined) return;
          const remaining = budgetMs - (Date.now() - startedAt);
          if (remaining <= 0) throw new Error('recovery timed out');
          const requestedAfter = sub.historyCursor;
          const page = await engine.history({ conference: room, session: sub.session,
            after: requestedAfter, limit: 20,
            timeoutMs: Math.min(Math.max(remaining, 1), 60000), signal: abort.signal });
          if (!live()) return;
          const fresh = current();
          if (fresh === undefined) return;
          if (requestedAfter === 0 && page.firstAvailable > 1) {
            try {
              await core.recordConference({ kind: 'conference_message', conference: room, session: fresh.session,
                peer: fresh.host ?? '', type: 'vortex.history-gap',
                body: `${page.firstAvailable - 1} earlier messages are not retained`, backlog: true });
            } catch { this.onError('conference history gap notice failed'); }
          }
          const events = page.records.map(record => ({ kind: 'conference_message' as const,
            conference: room, session: fresh.session, peer: record.service, service: record.service,
            participant: record.message.sender, message: record.message.id, type: record.message.type,
            ...(record.message.replyTo === undefined ? {} : { replyTo: record.message.replyTo }),
            body: new TextDecoder('utf-8', { fatal: false }).decode(record.message.content),
            backlog: true }));
          await core.applySubscriptionHistory(room, captured.id, requestedAfter, page.cursor, events);
          if (!live()) return;
          if (current() === undefined) return;
          if (!page.more) break;
        }
      } catch (histError) {
        if (!live()) throw histError;
        this.onError('subscription backfill failed');
        try {
          await core.recordConference({ kind: 'conference_message', conference: room, session: captured.session,
            peer: captured.host, type: 'vortex.history-unavailable', body: 'earlier messages could not be fetched', backlog: true });
        } catch { this.onError('conference history unavailable notice failed'); }
        // no backoff/timer: allow retry on next reconnect/recovery
      }
      rec.failures = 0;
      rec.notBefore = 0;
    } catch {
      if (!this.running || generation !== this.generation || this.conversations !== core ||
        this.conferences !== engine || this.recovery.get(room) !== rec) return;
      this.onError('subscription recovery failed');
      try {
        await core.recordConference({ kind: 'conference_message', conference: room, session: captured.session,
          peer: captured.host, type: 'vortex.history-unavailable', body: 'earlier messages could not be fetched', backlog: true });
      } catch { this.onError('conference history unavailable notice failed'); }
      rec.failures += 1;
      rec.notBefore = Date.now() + Math.min(1000 * 2 ** (rec.failures - 1), 30000);
    } finally {
      clearTimeout(budget);
      rec.abort = undefined;
      rec.resumePending = false;
      rec.active = false;
      const again = rec.recheck;
      rec.recheck = false;
      if (!this.running || generation !== this.generation || this.conversations !== core ||
        this.conferences !== engine || this.recovery.get(room) !== rec) return;
      if (again && rec.failures === 0) {
        const sub = core.storedSubscriptions()[room];
        if (sub !== undefined && sub.id === captured.id && sub.expires > Date.now()) {
          rec.notBefore = 0;
          this.ensureRecovery(room);
          return;
        }
      }
      const sub = core.storedSubscriptions()[room];
      if (sub === undefined || sub.id !== captured.id) this.recovery.delete(room);
      this.scheduleExpiry();
    }
  }

  /** Leave a recovery-owned membership only: still ours, wanted by nobody. */
  private async leaveOrphanedRecoveryRoom (room: string, captured: { id: string, session: string },
    core: Conversations, engine: Conferences): Promise<void> {
    if (this.conferences !== engine) return;
    const info = engine.get(room);
    if (info === undefined || info.session !== captured.session) return;
    if (core.storedSubscriptions()[room] !== undefined) return;
    await engine.leave(room, captured.session).catch(() => {});
  }

  private queueOrphanHostCleanup(): void {
    const core = this.conversations;
    if (!core || !this.conferences) return;
    for (const sub of Object.values(core.storedSubscriptions())) {
      if (sub.membership !== undefined || this.conferences.get(sub.conference) !== undefined) continue;
      if (!this.pendingClose.has(sub.conference)) {
        this.pendingClose.set(sub.conference, { id: sub.id, expires: sub.expires, session: sub.session, notBefore: Date.now() });
      }
    }
  }
}
