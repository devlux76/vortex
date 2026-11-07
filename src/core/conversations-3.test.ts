// Docs: VORTEX_v5.1.md §§6.3, 7.3, 9.3, 10.5; ISSUES.md I1–I3 (consent, deduplication, durable delivery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversations } from './conversations.ts';
import type { Snapshot, Packet } from './conversations.ts';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { makeProfile } from '../embed/profile.ts';
import { encodeVector } from '../embed/vector.ts';
import type { PeerMemoryRecord } from './peer-memory.ts';
import { pair, tick, deferredSave, consentedB, conferenceEvents, subConf, subInput, subMsg, memoryProfile, memoryVector, memoryVectorHex, memoryPeer, memoryRecord, memoryCore, routedPair } from './conversations.testkit.ts'

test('refreshSubscriptionMembership CAS updates only membership with matching id', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(42);
  const created = await core.setSubscription(subInput(conf, 's1', 'h1', 500, { descriptor: 'aa', privateKey: 'bb' }));
  const ok = await core.refreshSubscriptionMembership(conf, created.id, { descriptor: 'cc', privateKey: 'dd' });
  assert.equal(ok, true);
  const stored = core.storedSubscriptions()[conf];
  assert.deepEqual(stored.membership, { descriptor: 'cc', privateKey: 'dd' });
  assert.equal(stored.expires, 500);
  assert.equal(stored.historyCursor, 0);
  assert.equal(stored.session, 's1');
  assert.equal(stored.host, 'h1');
  assert.equal(await core.refreshSubscriptionMembership(conf, 'wrong-id', { descriptor: 'ee', privateKey: 'ff' }), false);
  assert.deepEqual(core.storedSubscriptions()[conf].membership, { descriptor: 'cc', privateKey: 'dd' });
  assert.equal(await core.refreshSubscriptionMembership(subConf(43), created.id, { descriptor: 'ee', privateKey: 'ff' }), false);
  await assert.rejects(core.refreshSubscriptionMembership(conf, created.id, { descriptor: 'zz', privateKey: 'ff' }), /invalid/);
  await assert.rejects(core.refreshSubscriptionMembership(conf, created.id, { descriptor: '', privateKey: 'ff' }), /invalid/);
});

test('refreshSubscriptionMembership copies inputs and clips shorter signed expiry', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(44);
  const created = await core.setSubscription(subInput(conf, 's1', 'h1', 500, { descriptor: 'aa', privateKey: 'bb' }));
  const membership = { descriptor: 'cc', privateKey: 'dd' };
  const refreshed = core.refreshSubscriptionMembership(conf, created.id, membership, 400);
  membership.descriptor = 'mutated';
  assert.equal(await refreshed, true);
  const stored = core.storedSubscriptions()[conf];
  assert.deepEqual(stored.membership, { descriptor: 'cc', privateKey: 'dd' });
  assert.equal(stored.expires, 400);
  const longer = await core.refreshSubscriptionMembership(conf, created.id, { descriptor: 'ee', privateKey: 'ff' }, 900);
  assert.equal(longer, true);
  assert.equal(core.storedSubscriptions()[conf].expires, 400);
});

test('refreshSubscriptionMembership save failure changes nothing', async () => {
  let fail = false;
  const core = new Conversations('b', { send: async () => {}, save: () => { if (fail) throw new Error('disk full'); } });
  const conf = subConf(45);
  const created = await core.setSubscription(subInput(conf, 's1', 'h1', 500, { descriptor: 'aa', privateKey: 'bb' }));
  fail = true;
  await assert.rejects(core.refreshSubscriptionMembership(conf, created.id, { descriptor: 'cc', privateKey: 'dd' }), /disk full/);
  assert.deepEqual(core.storedSubscriptions()[conf].membership, { descriptor: 'aa', privateKey: 'bb' });
  fail = false;
  assert.equal(await core.refreshSubscriptionMembership(conf, created.id, { descriptor: 'cc', privateKey: 'dd' }), true);
});

test('refreshSubscriptionMembership queued behind removal cannot resurrect', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(46);
  const created = await core.setSubscription(subInput(conf, 's1', 'h1', 500, { descriptor: 'aa', privateKey: 'bb' }));
  const removal = core.removeSubscription('s1', conf);
  const refresh = core.refreshSubscriptionMembership(conf, created.id, { descriptor: 'cc', privateKey: 'dd' });
  assert.equal(await removal, true);
  assert.equal(await refresh, false);
  assert.equal(core.storedSubscriptions()[conf], undefined);
});

test('peer memory stays private in snapshots and out of reads and public lists', async () => {
  const core = memoryCore();
  assert.ok(!('peerMemory' in core.snapshot()));
  await core.setSubscription({ conference: '11'.repeat(16), session: 's', host: 'h', expires: 50 });
  assert.ok(!('peerMemory' in core.snapshot()));
  const stored = await core.recordPeerOutcomes([await memoryRecord()]);
  assert.deepEqual(stored, { stored: 1, unsubscribed: false });
  const snapshot = core.snapshot();
  assert.equal(snapshot.peerMemory?.length, 1);
  for (const view of [core.read(), core.notificationState(), core.subscriptions()]) {
    assert.ok(!JSON.stringify(view).includes('handled it well'));
  }
  assert.deepEqual(Object.keys(core.peerMemoryStats(5000)).sort(), ['bytes', 'count']);
  assert.equal(core.peerMemoryStats(5000).count, 1);
  const restarted = new Conversations('b', { send: async () => {}, save: () => {} }, snapshot);
  assert.equal(restarted.storedPeerMemory().length, 1);
  assert.equal(restarted.peerOutcome(restarted.storedPeerMemory()[0].peer, memoryVector, memoryProfile, undefined, 5000), 'useful');
});

test('old snapshots without peer memory stay compatible', async () => {
  const legacy = { rooms: {}, events: [], seen: [], cursor: 0 };
  const core = new Conversations('b', { send: async () => {}, save: () => {} }, legacy);
  assert.ok(!('peerMemory' in core.snapshot()));
  assert.deepEqual(core.storedPeerMemory(), []);
  assert.deepEqual(core.peerMemoryStats(), { count: 0, bytes: 0 });
  assert.equal(core.nextPeerMemoryExpiry(), undefined);
  assert.equal(await core.expirePeerMemory(), 0);
  assert.ok(!('peerMemory' in core.snapshot()));
  assert.equal(core.peerOutcome(await memoryPeer(), memoryVector, memoryProfile), 'neutral');
});

test('recordPeerOutcomes renews by identity and removes an owned subscription atomically', async () => {
  const core = memoryCore();
  const conf = '22'.repeat(16);
  await core.setSubscription({ conference: conf, session: 's', host: 'h', expires: 60 });
  const peer = await memoryPeer();
  const first = await core.recordPeerOutcomes([await memoryRecord({ peer, outcome: 'useful' })]);
  assert.deepEqual(first, { stored: 1, unsubscribed: false });
  const renewed = await core.recordPeerOutcomes(
    [await memoryRecord({ peer, outcome: 'misleading', statement: 'changed mind' })],
    undefined, { session: 's', conference: conf });
  assert.deepEqual(renewed, { stored: 1, unsubscribed: true });
  const stored = core.storedPeerMemory();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].outcome, 'misleading');
  assert.equal(core.subscriptions().length, 0);
  // Missing subscription still permits ratings; wrong session or guard removes nothing.
  await core.setSubscription({ conference: conf, session: 's', host: 'h', expires: 60 });
  const missing = await core.recordPeerOutcomes([await memoryRecord()],
    undefined, { session: 's', conference: '33'.repeat(16) });
  assert.deepEqual(missing, { stored: 1, unsubscribed: false });
  const kept = await core.recordPeerOutcomes([await memoryRecord()],
    undefined, { session: 'wrong', conference: conf });
  assert.deepEqual(kept, { stored: 1, unsubscribed: false });
  assert.equal(core.subscriptions().length, 1);
  const sub = core.subscriptions()[0];
  void sub;
  const storedSub = Object.values(core.storedSubscriptions())[0];
  const stale = await core.recordPeerOutcomes([await memoryRecord()],
    undefined, { session: 's', conference: conf, expected: { id: 'nope', expires: storedSub.expires } });
  assert.deepEqual(stale, { stored: 1, unsubscribed: false });
  assert.equal(core.subscriptions().length, 1);
  const exact = await core.recordPeerOutcomes([await memoryRecord()],
    undefined, { session: 's', conference: conf, expected: { id: storedSub.id, expires: storedSub.expires } });
  assert.deepEqual(exact, { stored: 1, unsubscribed: true });
  assert.equal(core.subscriptions().length, 0);
});

test('batch bounds reject without storing anything', async () => {
  const core = memoryCore();
  const big = await memoryRecord({ statement: 'x'.repeat(100) });
  const twin = await memoryRecord({ peer: big.peer, participant: big.participant, namespace: big.namespace, vector: big.vector });
  await assert.rejects(core.recordPeerOutcomes([big, twin]), /duplicate/);
  await assert.rejects(core.recordPeerOutcomes(Array.from({ length: 257 }, () => big)), /too large/);
  await assert.rejects(core.recordPeerOutcomes([await memoryRecord()], { maxCount: 0 } as never), /limits/);
  await assert.rejects(core.recordPeerOutcomes([big, big]), /duplicate/);
  const many = await Promise.all(Array.from({ length: 5 }, async (_, i) => memoryRecord({ participant: i.toString(16).padStart(64, '0') })));
  await assert.rejects(core.recordPeerOutcomes(many, { maxCount: 4 }), /count bound/);
  const heavy = await memoryRecord({ statement: 'y'.repeat(4000) });
  await assert.rejects(core.recordPeerOutcomes([heavy], { maxBytes: 10 }), /byte bound/);
  await assert.rejects(core.recordPeerOutcomes([{ ...(await memoryRecord()), outcome: 'bogus' as never }]), /invalid peer memory/);
  assert.deepEqual(core.storedPeerMemory(), []);
  assert.ok(!('peerMemory' in core.snapshot()));
});

test('count and byte edges prune oldest committed first', async () => {
  const core = memoryCore();
  const at = Date.now();
  const mk = async (i: number, outcome: PeerMemoryRecord['outcome'] = 'useful'): Promise<PeerMemoryRecord> =>
    memoryRecord({ participant: i.toString(16).padStart(64, '0'), recordedAt: at + i, expires: at + 100 + i, outcome });
  const [r1, r2, r3] = [await mk(1), await mk(2), await mk(3)];
  await core.recordPeerOutcomes([r1, r2, r3]);
  assert.equal(core.storedPeerMemory().length, 3);
  // A later call with a tighter bound prunes the oldest committed entries.
  const renewed = { ...r1, recordedAt: at + 50, expires: at + 5000 };
  await core.recordPeerOutcomes([renewed], { maxCount: 2 });
  assert.deepEqual(core.storedPeerMemory().map(entry => entry.recordedAt), [at + 3, at + 50]);
  const bytes = core.peerMemoryStats(at + 50);
  assert.equal(bytes.count, 2);
  assert.ok(bytes.bytes > 0);
  assert.equal(core.nextPeerMemoryExpiry(), at + 103);
  assert.equal(await core.expirePeerMemory(at + 103), 1);
  assert.deepEqual(core.storedPeerMemory().map(entry => entry.recordedAt), [at + 50]);
  assert.equal(await core.expirePeerMemory(at + 10000), 1);
  assert.deepEqual(core.storedPeerMemory(), []);
  assert.ok(!('peerMemory' in core.snapshot()));
  assert.equal(core.nextPeerMemoryExpiry(), undefined);
});

test('caller mutation while queued cannot change the stored batch', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const core = new Conversations('b', { send: async () => {}, save: async () => { entered = true; await gate; } });
  const record = await memoryRecord();
  const pending = core.recordPeerOutcomes([record]);
  while (!entered) await new Promise(resolve => setTimeout(resolve, 0));
  record.statement = 'mutated';
  record.outcome = 'misleading';
  assert.deepEqual(core.storedPeerMemory(), []);
  assert.ok(!('peerMemory' in core.snapshot()));
  release();
  assert.deepEqual(await pending, { stored: 1, unsubscribed: false });
  assert.equal(core.storedPeerMemory()[0].statement, 'handled it well');
  assert.equal(core.storedPeerMemory()[0].outcome, 'useful');
});

test('failed saves roll back memory and subscription together and stay invisible', async () => {
  const deferred: Array<{ resolve: () => void, reject: (error: unknown) => void }> = [];
  const tick = async (turns = 4): Promise<void> => {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  let notified = false;
  const core = new Conversations('b', { send: async () => {}, save: () => new Promise<void>((resolve, reject) => { deferred.push({ resolve, reject }); }) });
  core.onEvents(() => { notified = true; });
  const conf = '44'.repeat(16);
  const setup = core.setSubscription({ conference: conf, session: 's', host: 'h', expires: 60 });
  await tick();
  assert.equal(deferred.length, 1);
  deferred[0].resolve();
  await setup;
  notified = false;
  const before = core.snapshot();
  const pending = core.recordPeerOutcomes([await memoryRecord()], undefined, { session: 's', conference: conf });
  await tick();
  assert.equal(deferred.length, 2);
  assert.deepEqual(core.snapshot(), before);
  assert.deepEqual(core.storedPeerMemory(), []);
  assert.equal(notified, false);
  deferred[1].reject(new Error('disk full'));
  await assert.rejects(pending, /disk full/);
  assert.deepEqual(core.snapshot(), before);
  assert.deepEqual(core.storedPeerMemory(), []);
  assert.equal(core.subscriptions().length, 1);
  assert.equal(notified, false);
});

test('a renewal racing a stale expiry survives inside the queue', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const core = new Conversations('b', { send: async () => {}, save: async () => { calls++; if (calls === 1) await gate; } });
  const at = Date.now();
  const seed = await memoryRecord({ recordedAt: at, expires: at + 200 });
  const seeding = core.recordPeerOutcomes([seed]);
  const renewed = await memoryRecord({
    peer: seed.peer, participant: seed.participant, namespace: seed.namespace, vector: seed.vector,
    recordedAt: at + 150, expires: at + 9000
  });
  const renewal = core.recordPeerOutcomes([renewed]);
  const expiry = core.expirePeerMemory(at + 500);
  release();
  assert.deepEqual(await seeding, { stored: 1, unsubscribed: false });
  assert.deepEqual(await renewal, { stored: 1, unsubscribed: false });
  assert.equal(await expiry, 0);
  assert.equal(core.storedPeerMemory()[0].expires, at + 9000);
});

test('copies detach and malformed caches never score', async () => {
  const core = memoryCore();
  await core.recordPeerOutcomes([await memoryRecord()]);
  const copy = core.storedPeerMemory();
  copy[0].statement = 'mutated';
  copy.length = 0;
  assert.equal(core.storedPeerMemory()[0].statement, 'handled it well');
  const broken = { rooms: {}, events: [], seen: [], cursor: 0,
    peerMemory: [{ peer: 'nope', participant: 'x', namespace: 'y', vector: 'zz',
      outcome: 'useful', recordedAt: 1, expires: 9999999999999 }] };
  const revived = new Conversations('b', { send: async () => {}, save: () => {} }, broken as never);
  assert.equal(revived.peerOutcome(await memoryPeer(), memoryVector, memoryProfile, undefined, 5), 'neutral');
  assert.equal(revived.peerMemoryStats(5).count, 0);
});

test('ratings change no cursor, ack, seen or notification state', async () => {
  const { a, b, drain } = pair();
  const room = await a.invite('b'); await drain(); await b.accept(room); await drain();
  await a.send(room, 'hello'); await drain();
  const before = b.snapshot();
  const noteBefore = b.notificationState();
  await b.recordPeerOutcomes([await memoryRecord()]);
  assert.deepEqual(b.snapshot().events, before.events);
  assert.equal(b.snapshot().cursor, before.cursor);
  assert.equal(b.snapshot().acked, before.acked);
  assert.deepEqual(b.snapshot().seen, before.seen);
  assert.deepEqual(b.notificationState(), noteBefore);
  assert.deepEqual(b.read().events, b.read(before.acked ?? 0).events);
});

test('malformed restored memory shapes cannot break lookup or maintenance', async () => {
  const record = await memoryRecord();
  for (const peerMemory of [[null, 3, 'bad', record], { broken: true }]) {
    const core = new Conversations('b', { send: async () => {}, save: () => {} },
      { rooms: {}, events: [], seen: [], cursor: 0, peerMemory } as never);
    const valid = Array.isArray(peerMemory);
    assert.equal(core.peerOutcome(record.peer, memoryVector, memoryProfile), valid ? 'useful' : 'neutral');
    assert.equal(core.peerMemoryStats().count, valid ? 1 : 0);
    assert.equal(core.nextPeerMemoryExpiry(), valid ? record.expires : undefined);
    assert.equal(await core.expirePeerMemory(), 0);
    await core.recordPeerOutcomes([]);
    assert.equal(core.storedPeerMemory().length, valid ? 1 : 0);
  }
});

test('peer memory accepts an exact byte boundary and evicts older records to fit', async () => {
  const first = await memoryRecord();
  const second = { ...first, participant: 'cd'.repeat(32) };
  const bytes = new TextEncoder().encode(JSON.stringify(first)).length;
  const core = memoryCore();
  await core.recordPeerOutcomes([first], { maxBytes: bytes });
  assert.equal(core.peerMemoryStats().bytes, bytes);
  await assert.rejects(core.recordPeerOutcomes([second], { maxBytes: bytes - 1 }), /byte bound/);
  assert.deepEqual(core.storedPeerMemory(), [first]);
  await core.recordPeerOutcomes([second], { maxBytes: bytes });
  assert.deepEqual(core.storedPeerMemory(), [second]);
});

test('subscription subjects store, renew, agree and stay private', async () => {
  const core = memoryCore();
  const conf = '55'.repeat(16);
  const subject = { statement: 'flood query', vector: memoryVectorHex,
    namespace: memoryProfile.id, profileVersion: 3 };
  const created = await core.setSubscription({ conference: conf, session: 's', host: 'h',
    expires: 500, subject: { ...subject } });
  assert.deepEqual(core.storedSubscriptions()[conf].subject, subject);
  subject.statement = 'mutated';
  assert.deepEqual(core.storedSubscriptions()[conf].subject?.statement, 'flood query');
  assert.deepEqual(Object.keys(core.subscriptions()[0]).sort(),
    ['conference', 'expires', 'historyCursor', 'host', 'session']);
  // Renewal without a subject retains; a differing subject rejects.
  const renewed = await core.setSubscription({ conference: conf, session: 's', host: 'h', expires: 600 });
  assert.equal(renewed.id, created.id);
  assert.deepEqual(core.storedSubscriptions()[conf].subject?.statement, 'flood query');
  await assert.rejects(core.setSubscription({ conference: conf, session: 's', host: 'h',
    expires: 600, subject: { ...subject, statement: 'rebound' } }), /original query/);
  assert.deepEqual(core.storedSubscriptions()[conf].subject?.statement, 'flood query');
  assert.equal(core.storedSubscriptions()[conf].expires, 600);
  // Refresh preserves the sibling subject.
  const refreshed = await core.refreshSubscriptionMembership(conf, created.id,
    { descriptor: 'aa', privateKey: 'bb' });
  assert.equal(refreshed, true);
  assert.deepEqual(core.storedSubscriptions()[conf].subject?.statement, 'flood query');
  // Invalid subjects reject without storing anything.
  await assert.rejects(core.setSubscription({ conference: '66'.repeat(16), session: 's',
    host: 'h', expires: 60, subject: { statement: '', vector: 'zz', namespace: 'zz', profileVersion: 0 } }), /invalid peer subject/);
  assert.equal(core.storedSubscriptions()['66'.repeat(16)], undefined);
});

test('failed subscription saves roll back subject and sub together', async () => {
  const deferred: Array<{ resolve: () => void, reject: (error: unknown) => void }> = [];
  const tick = async (turns = 4): Promise<void> => {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  const core = new Conversations('b', { send: async () => {}, save: () => new Promise<void>((resolve, reject) => { deferred.push({ resolve, reject }); }) });
  const subject = { statement: 'flood query', vector: memoryVectorHex,
    namespace: memoryProfile.id, profileVersion: 3 };
  const pending = core.setSubscription({ conference: '77'.repeat(16), session: 's',
    host: 'h', expires: 60, subject });
  await tick();
  assert.equal(deferred.length, 1);
  assert.deepEqual(core.storedSubscriptions(), {});
  deferred[0].reject(new Error('disk full'));
  await assert.rejects(pending, /disk full/);
  assert.deepEqual(core.storedSubscriptions(), {});
  assert.ok(!('subscriptions' in core.snapshot()) || core.snapshot().subscriptions === undefined);
});

test('subscription subject input is captured before the queued save finishes', async () => {
  const deferred: Array<{ resolve: () => void, reject: (error: unknown) => void }> = [];
  const tick = async (turns = 4): Promise<void> => {
    for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  const core = new Conversations('b', { send: async () => {}, save: () => new Promise<void>((resolve, reject) => { deferred.push({ resolve, reject }); }) });
  const subject = { statement: 'flood query', vector: memoryVectorHex,
    namespace: memoryProfile.id, profileVersion: 3 };
  const pending = core.setSubscription({ conference: '77'.repeat(16), session: 's',
    host: 'h', expires: 60, subject });
  await tick();
  assert.equal(deferred.length, 1);
  subject.statement = 'mutated while queued';
  subject.vector = '00'.repeat(32);
  deferred[0].resolve();
  const created = await pending;
  assert.deepEqual(created.subject, { statement: 'flood query', vector: memoryVectorHex,
    namespace: memoryProfile.id, profileVersion: 3 });
  assert.deepEqual(core.storedSubscriptions()['77'.repeat(16)].subject?.statement, 'flood query');
});

test('a routed direct message is tagged with its conference and stays a room message', async () => {
  const {a,b,deliver,connect}=routedPair(async (_peer,body) => body.includes('build')
    ? { conference: 'c'.repeat(32), tier: 768, score: 0.91 } : undefined);
  await connect();
  const room=a.roomFor('b');
  await a.send(room,'the build is red again'); await a.send(room,'lunch?'); await deliver();
  const [routed,plain]=b.read().events.filter(e=>e.kind==='message');
  assert.equal(routed.room,room);
  assert.equal(routed.routingConference,'c'.repeat(32));
  assert.equal(routed.tier,768);
  assert.equal(routed.score,0.91);
  assert.equal(routed.conference,undefined);
  assert.equal(plain.routingConference,undefined);
  assert.equal(plain.tier,undefined);
  assert.equal(plain.body,'lunch?');
});

test('a failing route still delivers the plain message', async () => {
  const {a,b,deliver,connect}=routedPair(async () => { throw new Error('embedder down'); });
  await connect();
  await a.send(a.roomFor('b'),'hello'); await deliver();
  const event=b.read().events.at(-1)!;
  assert.equal(event.body,'hello');
  assert.equal(event.routingConference,undefined);
});

test('route latency never reorders arrivals, and duplicates are neither routed nor doubled', async () => {
  const releases: Array<() => void> = [];
  let calls=0;
  const {a,b,pending,connect}=routedPair((_peer,body) => { calls++; return new Promise(resolve => {
    releases.push(() => resolve({ conference: (body==='first'?'a':'b').repeat(32), tier: 'exact', score: 1 }));
  }); });
  await connect();
  const room=a.roomFor('b');
  await a.send(room,'first'); await a.send(room,'second');
  const [first,second]=pending.splice(0).map(p=>p.packet);
  const arrivals=[b.receive('a',first),b.receive('a',second),b.receive('a',first)];
  await new Promise(resolve=>setTimeout(resolve,5));
  releases[1]!(); await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(b.read().events.filter(e=>e.kind==='message').length,0);
  releases[0]!(); await Promise.all(arrivals);
  const messages=b.read().events.filter(e=>e.kind==='message');
  assert.deepEqual(messages.map(e=>[e.body,e.routingConference]),[['first','a'.repeat(32)],['second','b'.repeat(32)]]);
  assert.equal(calls,2);
  await b.receive('a',second);
  assert.equal(b.read().events.filter(e=>e.kind==='message').length,2);
  assert.equal(calls,2);
});
