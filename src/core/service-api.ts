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
import type { VortexService } from './service.ts'
import { TOPIC, encode, type Peer, notEnabled, type ConferenceInfoOut, conferenceOut, type ServiceOptions, type ConferenceFeedbackOutcome, type ConferenceFeedback, type PublicSubscription, bytesToHex, unhexBytes, SaveError } from './service-types.ts'
import { recordConference, routeMessage, checkDisclosure, publishInterest, rememberContact, addressesFor, rejectInbound, requireDiscovery, orderMatchesByPeerOutcome, prepareFeedback, backfillConferenceHistory } from './service-conf.ts'
import { scheduleExpiry, enforcePeerMemoryBounds, ensureRecovery, queueOrphanHostCleanup, cancelRecoveryRoom } from './service-maint.ts'

export async function start (self: VortexService): Promise<TransportInfo> {
  self.generation++;
  const info = await self.transport.start();
  self.conversations = new Conversations(info.peerId, {
    send: async (peer, packet) => {
      if (packet.kind === 'message') await checkDisclosure(self, 'message', 'legacy', packet.body);
      await self.transport.send(peer, encode(packet), addressesFor(self, peer));
    },
    save: async s => { try { await self.save(s); } catch (e) { throw new SaveError(e instanceof Error ? e.message : String(e), { cause: e }); } },
    ...(self.embedder ? { route: (_peer: string, body: string) => routeMessage(self, body) } : {})
  }, self.restored, self.retention);
  self.removeDirect = self.transport.onDirect(event => {
    try { coreOf(self).receive(event.from, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data))).catch(e => rejectInbound(self, e)); }
    catch (e) { rejectInbound(self, e); /* Invalid peer packets have no authority to alter local state. */ }
  });
  await self.transport.subscribe(TOPIC, event => {
    try {
      if (event.data.byteLength > 8192) return 'reject';
      const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(event.data));
      if (p.id !== event.origin || typeof p.name !== 'string' || p.name.length > 64 ||
        typeof p.interest !== 'string' || new TextEncoder().encode(p.interest).length > 4096 ||
        !Array.isArray(p.addrs) || p.addrs.length > 8 || !p.addrs.every((a: unknown) => typeof a === 'string' && a.length < 512 && a.endsWith('/p2p/' + event.origin)) ||
        !Number.isFinite(p.expires) || p.expires <= Date.now() || p.expires > Date.now() + 120000) return 'reject';
      if (p.id !== info.peerId && (self.peers.has(p.id) || self.peers.size < 100))
        self.peers.set(p.id, {id:p.id,name:p.name,interest:p.interest,addrs:p.addrs,expires:p.expires,trust:'untrusted_peer_content'});
      return 'accept';
    } catch { return 'reject'; }
  });
  if (self.embedder) {
    const discovery = new Discovery({ transport: self.transport, embedder: self.embedder,
      ...(self.discoveryOptions ?? {}),
      checkOutbound: statement => checkDisclosure(self, 'announcement', self.embedder!.profile().id, statement),
      conferences: () => self.conferences?.hostedRecords() ?? [],
      onMatch: (match) => {
        rememberContact(self, match.peer, match.addrs);
        coreOf(self).recordMatch({ interest: match.interest, record: match.record.id, recordKind: match.kind, peer: match.peer, tier: match.tier.tier,
          score: match.tier.score, fullScore: match.fullScore, addrs: match.addrs,
          ...(match.kind === 'interest' && match.record.statement !== undefined ? { statement: match.record.statement } : {}) })
          .catch(() => { self.onError('match for interest ' + match.interest + ' could not be saved'); });
      } });
    self.discovery = discovery;
    await discovery.start();
    const embedder = self.embedder;
    self.conferences = new Conferences({ transport: self.transport,
      profile: ns => ns === embedder.profile().id ? embedder.profile() : undefined,
      formable: id => {
        const interest = discovery.interests().find(i => i.id === id);
        return interest && { id: interest.id, session: interest.session,
          namespace: interest.announcement.namespace, topicVector: interest.announcement.vector,
          statement: interest.statement };
      }, ...(self.conferenceOptions ?? {}), onEvent: event => recordConference(self, event) });
    self.conferences.start();
  }
  self.heartbeat = setInterval(() => { void publishInterest(self, self.interest).catch(() => {}); }, 5000);
  try { await publishInterest(self, ''); }
  catch (error) { if (!(error instanceof DisclosureError)) throw error; }
  if (self.conferences && self.discovery) {
    self.running = true;
    self.maintenanceActive = false;
    self.retryNotBefore = 0;
    queueOrphanHostCleanup(self);
    void enforcePeerMemoryBounds(self, self.generation, coreOf(self)).catch(() => {});
    self.removePeer = self.transport.onPeer(event => {
      if (event.kind !== 'connect') return;
      const core = self.conversations;
      if (!core) return;
      for (const sub of Object.values(core.storedSubscriptions())) {
        if (sub.host === event.peer && sub.expires > Date.now()) ensureRecovery(self, sub.conference);
      }
    });
    for (const sub of Object.values(coreOf(self).storedSubscriptions())) {
      if (sub.expires > Date.now()) ensureRecovery(self, sub.conference);
    }
    scheduleExpiry(self);
  }
  return info;
}

export function coreOf (self: VortexService): Conversations {
  if (!self.conversations) throw new Error('service not started');
  return self.conversations;
}

export async function announceStatement (self: VortexService, request: { session: string; statement: string; ttl?: number;
  publishStatement?: boolean; replaces?: string }): Promise<{ id: string; expires: number }> {
  const discovery = requireDiscovery(self);
  const id = await discovery.announce(request);
  const stored = discovery.interests().find(interest => interest.id === id);
  if (!stored) throw new Error('announcement vanished after publish');
  return { id, expires: stored.expires };
}

export function openInterests (self: VortexService, session?: string): { id: string; session: string; statement: string; expires: number }[] {
  return requireDiscovery(self).interests(session)
    .map(interest => ({ id: interest.id, session: interest.session, statement: interest.statement, expires: interest.expires }));
}

export function matchesFor (self: VortexService, id: string): { peer: string; tier: 'exact' | number; score: number; fullScore: number;
  kind: 'interest' | 'conference'; addrs: string[]; statement?: string; record: string;
  host?: string; count?: number; capacity?: number; admission?: 'open' | 'invitation' | 'group'; expires?: number }[] {
  const discovery = requireDiscovery(self);
  const ordered = orderMatchesByPeerOutcome(self, id, discovery.matches(id));
  const ranked = ordered.map(match => ({ kind: match.kind, peer: match.peer, tier: match.tier.tier,
    score: match.tier.score, fullScore: match.fullScore, addrs: [...match.addrs],
    ...(match.kind === 'interest' && match.record.statement !== undefined ? { statement: match.record.statement } : {}), record: match.record.id,
    ...(match.kind === 'conference' ? { host: match.record.host, count: match.record.participantCount,
      capacity: match.record.capacity, admission: match.record.admission, expires: match.record.expiresAt } : {}) }));
  return ranked;
}

export async function subscribeConference (self: VortexService, request: { session: string; conference: string; ttl: number }): Promise<PublicSubscription> {
  const session = request.session;
  const conference = request.conference;
  const ttl = request.ttl;
  requireDiscovery(self);
  if (typeof session !== 'string' || session.length < 1 || session.length > 128) throw new Error('invalid subscription session');
  if (!/^[0-9a-f]{32}$/.test(conference)) throw new Error('invalid subscription conference');
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > self.maxSubscriptionTtl) throw new Error('invalid subscription ttl');
  const conferences = self.conferences!;
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
  const generation = self.generation;
  const core = coreOf(self);
  const engine = self.conferences!;
  const stored = await core.setSubscription({ conference, session, host: info.host, expires,
    ...(membership === undefined ? {} : { membership }),
    ...(subject === undefined ? {} : { subject }) }, self.maxSubscriptionCount);
  if (!self.running || generation !== self.generation || self.conversations !== core || self.conferences !== engine) {
    throw new Error('service stopped during subscribe');
  }
  if (engine.get(conference) === undefined) {
    self.pendingClose.set(conference, { id: stored.id, expires: stored.expires, session, notBefore: Date.now() });
    scheduleExpiry(self);
    throw new Error('conference closed during subscribe');
  }
  scheduleExpiry(self);
  ensureRecovery(self, conference);
  return { conference: stored.conference, session: stored.session, host: stored.host,
    expires: stored.expires, historyCursor: stored.historyCursor };
}

export function subscriptions (self: VortexService, session?: string): PublicSubscription[] {
  requireDiscovery(self);
  return coreOf(self).subscriptions(session);
}

export async function unsubscribeConference (self: VortexService, session: string, conference: string, feedback?: ConferenceFeedback): Promise<boolean> {
  requireDiscovery(self);
  const ownSession = session;
  const room = conference;
  const generation = self.generation;
  const core = coreOf(self);
  const engine = self.conferences!;
  const checkCurrent = (): void => {
    if (generation !== self.generation) throw new Error('service stopped during unsubscribe');
  };
  let removed = false;
  try {
    if (feedback === undefined) {
      removed = await core.removeSubscription(ownSession, room);
    } else {
      const owned = core.storedSubscriptions()[room];
      if (owned === undefined || owned.session !== ownSession) return false;
      const atCall = engine.get(room);
      const records = await prepareFeedback(self, core, engine, ownSession, room, feedback, checkCurrent);
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
      const outcome = await core.recordPeerOutcomes(records, self.peerMemoryLimits,
        { session: ownSession, conference: room, expected: { id: owned.id, expires: owned.expires } });
      removed = outcome.unsubscribed;
      checkCurrent();
      const after = engine.get(room);
      if (after === undefined || after.session !== ownSession || after.key !== before.key) {
        if (self.running && generation === self.generation && self.conversations === core) scheduleExpiry(self);
        return removed;
      }
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error('subscription removal failed');
  }
  if (!self.running || generation !== self.generation || self.conversations !== core || self.conferences !== engine) {
    return removed;
  }
  if (removed) cancelRecoveryRoom(self, room);
  scheduleExpiry(self);
  if (!removed) return false;
  const info = engine.get(room);
  if (info && info.session === ownSession) {
    await engine.leave(room, ownSession);
  }
  return true;
}

export async function createConference (self: VortexService, request: { session: string; statement: string } & ConferenceCreationOptions): Promise<ConferenceInfoOut> {
  request = { ...request, peers: Array.isArray(request.peers) ? [...request.peers] : request.peers };
  requireDiscovery(self);
  const generation = self.generation;
  const conferences = self.conferences!;
  if (typeof request.session !== 'string' || request.session.length < 1 || request.session.length > 128)
    throw new Error('session must contain 1 to 128 characters');
  if (typeof request.statement !== 'string' || !request.statement || new TextEncoder().encode(request.statement).length > 4096)
    throw new Error('statement must contain 1–4096 bytes');
  validateConferenceCreationOptions(request);
  const checkCurrent = (): void => {
    if (generation !== self.generation) throw new Error('service stopped during conference creation');
  };
  await checkDisclosure(self, 'announcement', self.embedder!.profile().id, request.statement);
  checkCurrent();
  const topicVector = await self.embedder!.embed(request.statement);
  checkCurrent();
  const info = await conferences.create({ session: request.session, namespace: self.embedder!.profile().id,
    topicVector, statement: request.statement, capacity: request.capacity, admission: request.admission, peers: request.peers });
  checkCurrent();
  self.conferenceHosts.set(info.id, info.host);
  return conferenceOut(info);
}

export async function reviseConference (self: VortexService, request: { session: string; conference: string; statement: string }): Promise<ConferenceInfoOut> {
  request = { ...request };
  requireDiscovery(self);
  const generation = self.generation;
  const conferences = self.conferences!;
  if (typeof request.session !== 'string' || request.session.length < 1 || request.session.length > 128)
    throw new Error('session must contain 1 to 128 characters');
  if (!/^(?:[0-9a-f]{32})$/.test(request.conference)) throw new Error('invalid conference id');
  if (typeof request.statement !== 'string' || !request.statement || new TextEncoder().encode(request.statement).length > 4096)
    throw new Error('statement must contain 1–4096 bytes');
  const owned = conferences.get(request.conference);
  if (owned === undefined || owned.role !== 'host' || owned.session !== request.session)
    throw new Error('not hosting this conference with this session');
  const checkCurrent = (): void => {
    if (generation !== self.generation) throw new Error('service stopped during conference revision');
  };
  await checkDisclosure(self, 'announcement', self.embedder!.profile().id, request.statement);
  checkCurrent();
  const topicVector = await self.embedder!.embed(request.statement);
  checkCurrent();
  const info = await conferences.reviseTopic({ conference: request.conference, session: request.session,
    topicVector, statement: request.statement });
  checkCurrent();
  return conferenceOut(info);
}

export async function joinConference (self: VortexService, request: { session: string; ref: string }, timeoutMs = 20000): Promise<ConferenceInfoOut> {
  const discovery = requireDiscovery(self);
  const match = discovery.interests(request.session).flatMap(i => discovery.matches(i.id))
    .find(m => m.record.id === request.ref);
  if (!match) throw new Error('no match with that record: read your match events and use the record of one');
  const original = discovery.interests(request.session).find(i => i.id === match.interest);
  const subject: PeerMemorySubject | undefined = original === undefined ? undefined : {
    statement: original.statement,
    vector: bytesToHex(encodeVector(original.announcement.vector)),
    namespace: original.announcement.namespace,
    profileVersion: original.announcement.profileVersion };
  const conferences = self.conferences!;
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
    self.conferenceHosts.set(info.id, info.host);
    try {
      await backfillConferenceHistory(self, info);
    } catch {
      self.onError('conference history backfill failed');
      try {
        await coreOf(self).recordConference({ kind: 'conference_message', conference: info.id, session: info.session,
          peer: info.host, type: 'vortex.history-unavailable', body: 'earlier messages could not be fetched', backlog: true });
      } catch { self.onError('conference history unavailable notice failed'); }
    }
    return conferenceOut(info);
  } finally { clearTimeout(timer); }
}

export async function postToConference (self: VortexService, request: { session: string; conference: string; text: string; type?: string; replyTo?: string }):
  Promise<{ posted: true; message: string }> {
  request = { ...request };
  requireDiscovery(self);
  if (typeof request.text !== 'string' || !request.text || new TextEncoder().encode(request.text).length > 16384)
    throw new Error('message must contain 1–16384 bytes');
  await checkDisclosure(self, 'message', self.conferences!.get(request.conference)?.descriptor.namespace ?? self.embedder!.profile().id, request.text);
  const message = await self.conferences!.post(request.conference, request.session,
    { type: request.type ?? 'text', content: new TextEncoder().encode(request.text), replyTo: request.replyTo });
  return { posted: true, message: message.id };
}

export async function conferenceHistory (self: VortexService, request: { session: string; conference: string; after?: number; limit?: number; timeout?: number }, signal?: AbortSignal) {
  request = { ...request };
  requireDiscovery(self);
  if (request.timeout !== undefined && (!Number.isSafeInteger(request.timeout) || request.timeout < 1 || request.timeout > 60))
    throw new Error('history timeout must be 1 to 60 seconds');
  const page = await self.conferences!.history({ ...request, signal, timeoutMs: request.timeout === undefined ? undefined : request.timeout * 1000 });
  return { conference: request.conference, historyCursor: page.cursor, firstAvailable: page.firstAvailable,
    latest: page.latest, more: page.more, messages: page.records.map(({ sequence, message, service }) => ({
      sequence, message: message.id, participant: message.sender, service, timestamp: message.timestamp,
      type: message.type, body: new TextDecoder().decode(message.content),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }) })) };
}

export async function leaveConference (self: VortexService, session: string, conference: string, feedback?: ConferenceFeedback): Promise<boolean> {
  requireDiscovery(self);
  const ownSession = session;
  const room = conference;
  const generation = self.generation;
  const core = coreOf(self);
  const engine = self.conferences!;
  const checkCurrent = (): void => {
    if (generation !== self.generation) throw new Error('service stopped during leave');
  };
  let removed: boolean;
  if (feedback === undefined) {
    removed = await core.removeSubscription(ownSession, room);
  } else {
    const owned = core.storedSubscriptions()[room];
    const mine = owned !== undefined && owned.session === ownSession ? owned : undefined;
    const atCall = engine.get(room);
    const records = await prepareFeedback(self, core, engine, ownSession, room, feedback, checkCurrent);
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
    const outcome = await core.recordPeerOutcomes(records, self.peerMemoryLimits,
      mine === undefined ? { session: ownSession, conference: room }
        : { session: ownSession, conference: room, expected: { id: mine.id, expires: mine.expires } });
    removed = outcome.unsubscribed;
    checkCurrent();
    const after = engine.get(room);
    if (after === undefined || after.session !== ownSession || after.key !== before.key) {
      if (self.running && generation === self.generation && self.conversations === core) scheduleExpiry(self);
      return removed;
    }
    if (mine !== undefined && !removed) {
      // A renewal raced the queued save and kept its incarnation: keep the
      // renewed subscription and membership untouched, but reschedule for
      // the committed feedback.
      if (self.running && generation === self.generation && self.conversations === core) scheduleExpiry(self);
      return false;
    }
  }
  if (!self.running || generation !== self.generation || self.conversations !== core || self.conferences !== engine) {
    throw new Error('service stopped during leave');
  }
  if (removed) cancelRecoveryRoom(self, room);
  scheduleExpiry(self);
  return engine.leave(room, ownSession);
}

export function conferenceList (self: VortexService, session?: string): ConferenceInfoOut[] {
  requireDiscovery(self);
  return self.conferences!.list(session).map(conferenceOut);
}

export function peerMemoryStats (self: VortexService): { count: number, bytes: number } {
  return coreOf(self).peerMemoryStats();
}

export function discover (self: VortexService): Peer[] {
  for (const [id, peer] of self.peers) if (peer.expires <= Date.now()) self.peers.delete(id);
  return structuredClone([...self.peers.values()]);
}

export async function announce (self: VortexService, text: string): Promise<void> {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 4096) throw new Error('interest exceeds 4096 bytes');
  await checkDisclosure(self, 'announcement', 'legacy', text);
  await publishInterest(self, text);
  self.interest = text;
}

export async function stop (self: VortexService): Promise<void> {
  self.generation++;
  self.running = false;
  self.maintenanceActive = false;
  self.retryNotBefore = 0;
  clearInterval(self.heartbeat);
  if (self.expiryTimer !== undefined) { clearTimeout(self.expiryTimer); self.expiryTimer = undefined; }
  self.pendingClose.clear();
  for (const [room, rec] of self.recovery) {
    rec.abort?.abort();
    if (rec.resumePending) self.conferences?.abandon(room);
  }
  self.recovery.clear();
  const core = self.conversations;
  self.conferences?.stop(); self.conferenceHosts.clear();
  if (self.discovery) await self.discovery.stop();
  self.removeDirect?.();
  self.removePeer?.();
  self.removePeer = undefined;
  await self.transport.stop();
  if (core) {
    await core.flush();
    self.restored = core.snapshot();
  }
}

