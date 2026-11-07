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

export function scheduleExpiry (self: VortexService): void {
  if (!self.running) return;
  const core = self.conversations;
  if (!core || !self.conferences || !self.discovery) return;
  if (self.expiryTimer !== undefined) { clearTimeout(self.expiryTimer); self.expiryTimer = undefined; }
  const generation = self.generation;
  const now = Date.now();
  let next: number | undefined;
  for (const sub of Object.values(core.storedSubscriptions())) {
    if (next === undefined || sub.expires < next) next = sub.expires;
  }
  for (const pending of self.pendingClose.values()) {
    if (next === undefined || pending.notBefore < next) next = pending.notBefore;
  }
  for (const rec of self.recovery.values()) {
    if (rec.failures > 0 && !rec.active && (next === undefined || rec.notBefore < next)) next = rec.notBefore;
  }
  const memory = core.nextPeerMemoryExpiry();
  if (memory !== undefined && (next === undefined || memory < next)) next = memory;
  const overfull = core.peerMemoryStats();
  if (overfull.count > self.peerMemoryLimits.maxCount || overfull.bytes > self.peerMemoryLimits.maxBytes) {
    next = now;
  }
  if (next === undefined) return;
  if (self.retryNotBefore > now) next = Math.max(next, self.retryNotBefore);
  self.expiryTimer = setTimeout(() => {
    self.expiryTimer = undefined;
    void runMaintenance(self, generation, core);
  }, Math.min(Math.max(0, next - now), 2147483647));
}

export async function runMaintenance (self: VortexService, generation: number, core: Conversations): Promise<void> {
  if (!self.running || generation !== self.generation || self.conversations !== core) return;
  if (self.maintenanceActive) return;
  self.maintenanceActive = true;
  try {
    await expireDueSubscriptions(self, generation, core);
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    await retryDueCloses(self, generation, core);
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    await expirePeerMemoryRecords(self, generation, core);
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    await enforcePeerMemoryBounds(self, generation, core);
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    runDueRecoveries(self, generation, core);
  } finally {
    self.maintenanceActive = false;
    if (self.running && generation === self.generation && self.conversations === core) scheduleExpiry(self);
  }
}

export async function expirePeerMemoryRecords (self: VortexService, generation: number, core: Conversations): Promise<void> {
  try {
    await core.expirePeerMemory();
  } catch {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    self.onError('peer memory expiry could not be saved');
    self.retryNotBefore = Date.now() + 1000;
  }
}

export async function enforcePeerMemoryBounds (self: VortexService, generation: number, core: Conversations): Promise<void> {
  if (!self.running || generation !== self.generation || self.conversations !== core) return;
  const stats = core.peerMemoryStats();
  if (stats.count <= self.peerMemoryLimits.maxCount && stats.bytes <= self.peerMemoryLimits.maxBytes) return;
  try {
    await core.recordPeerOutcomes([], self.peerMemoryLimits);
  } catch {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    self.onError('peer memory bounds could not be saved');
    self.retryNotBefore = Date.now() + 1000;
    scheduleExpiry(self);
  }
}

export async function expireDueSubscriptions (self: VortexService, generation: number, core: Conversations): Promise<void> {
  const now = Date.now();
  const expired = Object.values(core.storedSubscriptions())
    .filter(sub => sub.expires <= now)
    .map(sub => ({ conference: sub.conference, session: sub.session, id: sub.id, expires: sub.expires }));
  for (const sub of expired) {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    let removed = false;
    try {
      removed = await core.removeSubscription(sub.session, sub.conference, { id: sub.id, expires: sub.expires });
    } catch {
      if (!self.running || generation !== self.generation || self.conversations !== core) return;
      self.onError('subscription expiry could not be saved');
      self.retryNotBefore = Date.now() + 1000;
      return;
    }
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    if (removed) cancelRecoveryRoom(self, sub.conference);
    if (removed && core.storedSubscriptions()[sub.conference] === undefined) {
      const info = self.conferences?.get(sub.conference);
      if (info && info.session === sub.session) {
        await self.conferences!.leave(sub.conference, sub.session);
      }
    }
  }
}

export async function retryDueCloses (self: VortexService, generation: number, core: Conversations): Promise<void> {
  const dueClose: Array<{ conference: string; id: string; expires: number; session: string }> = [];
  for (const [conference, pending] of self.pendingClose) {
    if (pending.notBefore <= Date.now()) dueClose.push({ conference, id: pending.id, expires: pending.expires, session: pending.session });
  }
  for (const sub of dueClose) {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    try {
      await core.removeSubscription(sub.session, sub.conference, { id: sub.id, expires: sub.expires });
    } catch {
      if (!self.running || generation !== self.generation || self.conversations !== core) return;
      self.onError('subscription close could not be saved');
      self.retryNotBefore = Date.now() + 1000;
      const pending = self.pendingClose.get(sub.conference);
      if (pending) pending.notBefore = Date.now() + 1000;
      return;
    }
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    const current = core.storedSubscriptions()[sub.conference];
    if (current === undefined || current.id !== sub.id || current.expires !== sub.expires) {
      self.pendingClose.delete(sub.conference);
    } else {
      self.retryNotBefore = Date.now() + 1000;
      const pending = self.pendingClose.get(sub.conference);
      if (pending) pending.notBefore = Date.now() + 1000;
    }
  }
}

export async function dropUnknownSubscription (self: VortexService, room: string, captured: { id: string, expires: number, session: string },
  core: Conversations, engine: Conferences, generation: number): Promise<void> {
  if (!self.running || generation !== self.generation || self.conversations !== core || self.conferences !== engine) return;
  try {
    await core.removeSubscription(captured.session, room, { id: captured.id, expires: captured.expires });
  } catch {
    if (!self.running || generation !== self.generation || self.conversations !== core || self.conferences !== engine) return;
    self.onError('subscription close could not be saved');
    self.pendingClose.set(room, { id: captured.id, expires: captured.expires, session: captured.session, notBefore: Date.now() + 1000 });
    scheduleExpiry(self);
  }
}

export function dropClosedSubscription (self: VortexService, conference: string, generation: number, core: Conversations): void {
  if (!self.running || generation !== self.generation || self.conversations !== core) return;
  const stored = core.storedSubscriptions()[conference];
  if (!stored) return;
  const captured = { id: stored.id, expires: stored.expires, session: stored.session };
  void core.removeSubscription(captured.session, conference, { id: captured.id, expires: captured.expires }).then(removed => {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    if (removed) {
      cancelRecoveryRoom(self, conference);
      scheduleExpiry(self);
    } else if (core.storedSubscriptions()[conference]?.id !== captured.id) scheduleExpiry(self);
  }).catch(() => {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    self.onError('subscription close could not be saved');
    self.pendingClose.set(conference, { ...captured, notBefore: Date.now() + 1000 });
    scheduleExpiry(self);
  });
}

export function ensureRecovery (self: VortexService, room: string): void {
  if (!self.running) return;
  const core = self.conversations;
  const engine = self.conferences;
  if (!core || !engine || !self.discovery) return;
  const sub = core.storedSubscriptions()[room];
  if (sub === undefined) {
    self.recovery.delete(room);
    return;
  }
  if (sub.expires <= Date.now()) return;
  const generation = self.generation;
  let rec = self.recovery.get(room);
  if (rec === undefined) {
    rec = { failures: 0, notBefore: 0, active: false, recheck: false, resumePending: false };
    self.recovery.set(room, rec);
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
  void recoverRoom(self, room, captured, generation, core, engine, rec).catch(() => {
    rec.active = false;
  });
}

export function cancelRecoveryRoom (self: VortexService, room: string): void {
  const rec = self.recovery.get(room);
  if (rec === undefined) return;
  if (rec.resumePending) self.conferences?.abandon(room);
  rec.abort?.abort();
  self.recovery.delete(room);
}

export function runDueRecoveries (self: VortexService, generation: number, core: Conversations): void {
  if (!self.running || generation !== self.generation || self.conversations !== core) return;
  const now = Date.now();
  for (const room of [...self.recovery.keys()]) {
    if (!self.running || generation !== self.generation || self.conversations !== core) return;
    const rec = self.recovery.get(room);
    if (rec === undefined || rec.active || rec.failures === 0 || rec.notBefore > now) continue;
    ensureRecovery(self, room);
  }
}

export async function recoverRoom (self: VortexService, room: string, captured: { id: string, expires: number, session: string, host: string },
  generation: number, core: Conversations, engine: Conferences,
  rec: { failures: number, notBefore: number, active: boolean,
    recheck: boolean, abort?: AbortController, resumePending: boolean }): Promise<void> {
  const startedAt = Date.now();
  const budgetMs = 20000;
  const abort = new AbortController();
  rec.abort = abort;
  const budget = setTimeout(() => {
    abort.abort();
    if (self.conferences === engine && rec.resumePending) engine.abandon(room);
  }, budgetMs);
  try {
    const current = (): RoomSubscription | undefined => {
      const sub = core.storedSubscriptions()[room];
      if (sub === undefined || sub.id !== captured.id || sub.session !== captured.session ||
        sub.host !== captured.host || sub.expires <= Date.now()) return undefined;
      return sub;
    };
    const live = (): boolean =>
      self.running && generation === self.generation && self.conversations === core &&
      self.conferences === engine && self.recovery.get(room) === rec && !abort.signal.aborted;
    let sub = current();
    if (sub === undefined || !live()) return;
    const present = engine.get(room);
    if (present?.role !== 'host') {
      if (sub.membership === undefined) return;
      const descriptorBytes = unhexBytes(sub.membership.descriptor);
      const privateKeyBytes = unhexBytes(sub.membership.privateKey);
      const descriptor = await openDescriptor(descriptorBytes, {
        profile: namespace => {
          const profile = self.embedder?.profile();
          return profile !== undefined && namespace === profile.id ? profile : undefined;
        },
        verify: (peer, data, signature) => self.transport.verify(peer, data, signature),
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
          self.recovery.get(room) === rec) {
          rec.failures = 0;
          rec.notBefore = 0;
          await dropUnknownSubscription(self, room, captured, core, engine, generation);
          return;
        }
        throw error;
      } finally {
        rec.resumePending = false;
      }
      if (!live()) {
        await leaveOrphanedRecoveryRoom(self, room, captured, core, engine);
        return;
      }
      if (info.id !== room || info.session !== sub.session || info.host !== sub.host) {
        await leaveOrphanedRecoveryRoom(self, room, captured, core, engine);
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
          } catch { self.onError('conference history gap notice failed'); }
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
      self.onError('subscription backfill failed');
      try {
        await core.recordConference({ kind: 'conference_message', conference: room, session: captured.session,
          peer: captured.host, type: 'vortex.history-unavailable', body: 'earlier messages could not be fetched', backlog: true });
      } catch { self.onError('conference history unavailable notice failed'); }
      // no backoff/timer: allow retry on next reconnect/recovery
    }
    rec.failures = 0;
    rec.notBefore = 0;
  } catch {
    if (!self.running || generation !== self.generation || self.conversations !== core ||
      self.conferences !== engine || self.recovery.get(room) !== rec) return;
    self.onError('subscription recovery failed');
    try {
      await core.recordConference({ kind: 'conference_message', conference: room, session: captured.session,
        peer: captured.host, type: 'vortex.history-unavailable', body: 'earlier messages could not be fetched', backlog: true });
    } catch { self.onError('conference history unavailable notice failed'); }
    rec.failures += 1;
    rec.notBefore = Date.now() + Math.min(1000 * 2 ** (rec.failures - 1), 30000);
  } finally {
    clearTimeout(budget);
    rec.abort = undefined;
    rec.resumePending = false;
    rec.active = false;
    const again = rec.recheck;
    rec.recheck = false;
    if (!self.running || generation !== self.generation || self.conversations !== core ||
      self.conferences !== engine || self.recovery.get(room) !== rec) return;
    if (again && rec.failures === 0) {
      const sub = core.storedSubscriptions()[room];
      if (sub !== undefined && sub.id === captured.id && sub.expires > Date.now()) {
        rec.notBefore = 0;
        ensureRecovery(self, room);
        return;
      }
    }
    const sub = core.storedSubscriptions()[room];
    if (sub === undefined || sub.id !== captured.id) self.recovery.delete(room);
    scheduleExpiry(self);
  }
}

export async function leaveOrphanedRecoveryRoom (self: VortexService, room: string, captured: { id: string, session: string },
  core: Conversations, engine: Conferences): Promise<void> {
  if (self.conferences !== engine) return;
  const info = engine.get(room);
  if (info === undefined || info.session !== captured.session) return;
  if (core.storedSubscriptions()[room] !== undefined) return;
  await engine.leave(room, captured.session).catch(() => {});
}

export function queueOrphanHostCleanup (self: VortexService): void {
  const core = self.conversations;
  if (!core || !self.conferences) return;
  for (const sub of Object.values(core.storedSubscriptions())) {
    if (sub.membership !== undefined || self.conferences.get(sub.conference) !== undefined) continue;
    if (!self.pendingClose.has(sub.conference)) {
      self.pendingClose.set(sub.conference, { id: sub.id, expires: sub.expires, session: sub.session, notBefore: Date.now() });
    }
  }
}

