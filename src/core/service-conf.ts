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
import { coreOf } from './service-api.ts'
import { dropClosedSubscription } from './service-maint.ts'

export function requireDiscovery (self: VortexService): Discovery {
  const discovery = self.discovery;
  if (!discovery) throw new Error(notEnabled);
  return discovery;
}

export function rememberContact (self: VortexService, peer: string, addrs: string[]): void {
  self.contacts.delete(peer);
  self.contacts.set(peer, [...addrs]);
  while (self.contacts.size > 256) {
    const oldest = self.contacts.keys().next().value;
    if (oldest === undefined) break;
    self.contacts.delete(oldest);
  }
}

export function addressesFor (self: VortexService, peer: string): string[] | undefined {
  const known = self.contacts.get(peer);
  if (known) return [...known];
  const legacy = self.peers.get(peer);
  if (legacy && legacy.expires > Date.now()) return legacy.addrs;
  return undefined;
}

export function rejectInbound (self: VortexService, e: unknown): void {
  const kind = e instanceof SaveError ? 'save' : 'policy';
  self.rejected[kind]++;
  console.error(`vortex: inbound direct packet rejected (${kind})`);
}

export function orderMatchesByPeerOutcome (self: VortexService, id: string, matches: MatchFound[]): MatchFound[] {
  try {
    const interest = requireDiscovery(self).interests().find(entry => entry.id === id);
    if (interest === undefined || self.embedder === undefined) return matches;
    const profile = self.embedder.profile();
    if (interest.announcement.namespace !== profile.id ||
      interest.announcement.profileVersion !== profile.version) return matches;
    const core = self.conversations;
    if (core === undefined) return matches;
    const thresholds = self.discoveryOptions?.thresholds;
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

export function recordConference (self: VortexService, event: ConferenceEvent): void {
  const host = self.conferences?.get(event.conference)?.host ?? self.conferenceHosts.get(event.conference);
  if (host) self.conferenceHosts.set(event.conference, host);
  const peer = 'service' in event ? event.service : host ?? self.info().peerId;
  if (event.kind === 'closed') self.conferenceHosts.delete(event.conference);
  if (event.kind === 'message' && self.backfilling.has(event.conference)) {
    const queue = self.pendingLive.get(event.conference);
    if (queue !== undefined) { queue.push(event); return; }
  }
  const record = event.kind === 'message' ? {
    kind: 'conference_message' as const, conference: event.conference, session: event.session, peer,
    participant: event.message.sender, service: event.service, message: event.message.id,
    type: event.message.type, ...(event.message.replyTo === undefined ? {} : { replyTo: event.message.replyTo }),
    body: new TextDecoder('utf-8', { fatal: false }).decode(event.message.content),
    ...(event.backlog === undefined ? {} : { backlog: event.backlog })
  } : { ...event, peer };
  const generation = self.generation;
  const core = self.conversations;
  const done = coreOf(self).recordConference(record)
    .catch(() => { self.onError('conference event for ' + event.conference + ' could not be saved'); });
  if (event.kind === 'closed' && core) {
    void done.then(() => { dropClosedSubscription(self, event.conference, generation, core); });
  }
}

export async function routeMessage (self: VortexService, body: string): Promise<MessageRouting | undefined> {
  const embedder = self.embedder, conferences = self.conferences?.list() ?? [];
  if (!embedder || conferences.length === 0) return undefined;
  const vector = await embedder.embed(body);
  const profile = embedder.profile();
  return routeToConference(vector, conferences, profile, routingThresholds(profile, self.discoveryOptions?.thresholds)) ?? undefined;
}

export async function backfillConferenceHistory (self: VortexService, info: { id: string; session: string; host: string }): Promise<void> {
  const core = coreOf(self);
  self.backfilling.add(info.id);
  self.pendingLive.set(info.id, []);
  try {
    let after = 0;
    for (;;) {
      const page = await self.conferences!.history({ conference: info.id, session: info.session, after, limit: 20, timeoutMs: 20000 });
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
    self.backfilling.delete(info.id);
    const queue = self.pendingLive.get(info.id) ?? [];
    self.pendingLive.delete(info.id);
    for (const event of queue) recordConference(self, event);
  }
}

export async function prepareFeedback (self: VortexService, core: Conversations, engine: Conferences, ownSession: string, room: string,
  feedback: ConferenceFeedback, checkCurrent: () => void): Promise<PeerMemoryRecord[]> {
  if (feedback === undefined || feedback === null || typeof feedback !== 'object') {
    throw new Error('invalid feedback outcomes');
  }
  const raw = (feedback as { outcomes?: unknown }).outcomes;
  const statement = (feedback as { statement?: unknown }).statement;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 256) {
    throw new Error('invalid feedback outcomes');
  }
  if (raw.length > self.peerMemoryLimits.maxCount) {
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
  const profile = self.embedder!.profile();
  let subject: PeerMemorySubject;
  if (statement !== undefined) {
    checkCurrent();
    const vector = await self.embedder!.embed(statement);
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
  const ttlMs = self.peerMemoryTtl * 1000;
  return outcomes.map(outcome => ({ peer: services.get(outcome.participant)!,
    participant: outcome.participant, namespace: subject.namespace, profileVersion: subject.profileVersion,
    statement: subject.statement, vector: subject.vector, outcome: outcome.outcome,
    recordedAt: now, expires: now + ttlMs }));
}

export async function checkDisclosure (self: VortexService, kind: 'announcement' | 'message', namespace: string, text: string): Promise<void> {
  if (!self.disclosure) return;
  const generation = self.generation;
  await self.disclosure({ kind, namespace, network: 'loopback', text });
  if (generation !== self.generation) throw new DisclosureError('service stopped while checking disclosure');
}

export async function publishInterest (self: VortexService, text: string): Promise<void> {
  await checkDisclosure(self, 'message', 'legacy', text);
  const info = self.info();
  await self.transport.publish(TOPIC, encode({id:info.peerId,addrs:info.addrs,name:self.name,interest:text,expires:Date.now()+60000}));
}

