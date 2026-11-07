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

test('ack waits for its save: pending hides nothing new, rejection keeps the cursor', async () => {
  const deferred = deferredSave();
  const { core, room } = consentedB(deferred.save);
  const delivered = core.receive('a', { kind: 'message', room, id: 'm', body: 'hi' });
  await tick();
  deferred.calls[0].resolve();
  await delivered;
  const cursor = core.read().cursor;
  const acked = core.ack(cursor);
  await tick();
  assert.equal(deferred.calls.length, 2);
  assert.equal(core.read().events.length, 1);
  deferred.calls[1].reject(new Error('disk full'));
  await assert.rejects(acked, /disk full/);
  assert.equal(core.read().events.length, 1);
  const retry = core.ack(cursor);
  await tick();
  deferred.calls[2].resolve();
  await retry;
  assert.deepEqual(core.read().events, []);
});

test('invite and accept leave consent unchanged when the save rejects', async () => {
  let fail = true;
  const sent: string[] = [];
  const core = new Conversations('b', { send: async (_peer, packet) => { sent.push(packet.kind); },
    save: async () => { if (fail) throw new Error('disk full'); } });
  await assert.rejects(core.invite('a'), /disk full/);
  assert.deepEqual(core.rooms(), {});
  fail = false;
  const room = core.roomFor('a');
  await core.receive('a', { kind: 'invite', room });
  fail = true;
  await assert.rejects(core.accept(room), /disk full/);
  assert.equal(core.rooms()[room]?.localConsent, false);
  assert.deepEqual(sent, []);
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('a nudge releases one pending wait with the current page marked nudged', async () => {
  let saves = 0;
  const core = new Conversations('b', { send: async () => {}, save: () => { saves++; } });
  const waiting = core.wait(undefined, 1000);
  assert.equal(core.waiters(), 1);
  assert.equal(core.nudge(), 1);
  const page = await waiting;
  assert.deepEqual(page, { events: [], cursor: 0, nudged: true });
  assert.equal(core.waiters(), 0);
  assert.equal(saves, 0);
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('one nudge releases every pending wait', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const first = core.wait(undefined, 1000);
  const second = core.wait(undefined, 1000);
  assert.equal(core.nudge(), 2);
  assert.equal((await first).nudged, true);
  assert.equal((await second).nudged, true);
  assert.equal(core.waiters(), 0);
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('a nudge with nothing pending reports zero and saves nothing', async () => {
  let saves = 0;
  const core = new Conversations('b', { send: async () => {}, save: () => { saves++; } });
  assert.equal(core.nudge(), 0);
  assert.equal(saves, 0);
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('an event ending has no nudged field and a later nudge counts nothing', async () => {
  const { a, b, drain } = pair();
  const room = await a.invite('b'); await drain(); await b.accept(room); await drain();
  await b.ack(b.read().cursor);
  const waiting = b.wait(undefined, 1000);
  await a.send(room, 'hi'); await drain();
  const page = await waiting;
  assert.equal(page.events[0]?.body, 'hi');
  assert.ok(!('nudged' in page));
  assert.equal(b.nudge(), 0);
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('after a nudge a new wait resolves on the next event without nudged', async () => {
  const { a, b, drain } = pair();
  const room = await a.invite('b'); await drain(); await b.accept(room); await drain();
  await b.ack(b.read().cursor);
  const waiting = b.wait(undefined, 1000);
  assert.equal(b.nudge(), 1);
  assert.equal((await waiting).nudged, true);
  const next = b.wait(undefined, 1000);
  await a.send(room, 'after'); await drain();
  const page = await next;
  assert.equal(page.events[0]?.body, 'after');
  assert.ok(!('nudged' in page));
});

// Docs: ISSUES.md I12; VORTEX_v5.1.md section 9.3
test('a nudge changes neither the snapshot nor the unread cursor', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const waiting = core.wait(undefined, 1000);
  const before = core.snapshot();
  assert.equal(core.nudge(), 1);
  await waiting;
  assert.deepEqual(core.snapshot(), before);
  assert.deepEqual(core.read().events, []);
});

test('conference events are durable, wake without direct consent, and resolve waits', async () => {
  let saved: Snapshot | undefined;
  const core=new Conversations('a',{send:async()=>{},save:s=>{saved=s;}});
  for(const fields of conferenceEvents) {
    const input={...fields,conference:'a'.repeat(32),session:'s',peer:'c'};
    const after=core.read(0).cursor;
    const waiting=core.wait(after,1000);
    await core.recordConference(input);
    assert.deepEqual((await waiting).events,[{...input,cursor:after+1,room:'conference:'+'a'.repeat(32),trust:'untrusted_peer_content'}]);
  }
  assert.deepEqual(core.notificationState().rooms,[{room:'conference:'+'a'.repeat(32),unread:5,oldest:1}]);
  const restored=new Conversations('a',{send:async()=>{},save:()=>{}},saved);
  assert.deepEqual(restored.read(0),core.read(0));
  await core.ack(core.read().cursor);
  assert.deepEqual(core.notificationState().rooms,[]);
});
// Docs: VORTEX_v5.1.md sections 9.3 and 10.5

test('conference saves fail atomically and malformed local records are refused', async () => {
  let fail=true;
  const core=new Conversations('a',{send:async()=>{},save:()=>{if(fail) throw new Error('disk full');}});
  const good={kind:'formed' as const,conference:'a'.repeat(32),session:'s',peer:'b'};
  await assert.rejects(core.recordConference(good),/disk full/);
  assert.deepEqual(core.read().events,[]);
  assert.deepEqual(core.notificationState().rooms,[]);
  fail=false;
  for(const bad of [ {...good,kind:'message'}, {...good,conference:'bad'}, {...good,session:''},
    {...good,peer:''}, {...good,participant:'a'.repeat(63)}, {...good,message:'z'.repeat(32)},
    {...good,replyTo:'a'.repeat(31)}, {...good,count:-1}, {...good,count:1.5},
    {...good,count:NaN}, {...good,body:'é'.repeat(8193)} ]) {
    await assert.rejects(core.recordConference(bad as never),/invalid conference event/);
  }
  assert.deepEqual(core.read().events,[]);
  await core.recordConference(good);
  assert.equal(core.read().events.length,1);
});
// Docs: VORTEX_v5.1.md sections 9.3 and 10.5

test('a peer cannot inject any conference event or wake metadata', async () => {
  const core=new Conversations('a',{send:async()=>{},save:()=>{}});
  for(const {kind} of conferenceEvents) {
    assert.throws(()=>core.receive('b',{kind,room:core.roomFor('b')}),/unknown packet kind/);
  }
  assert.deepEqual(core.read().events,[]);
  assert.deepEqual(core.notificationState().rooms,[]);
});

// Docs: VORTEX_v5.1.md sections 6.1 and 9.1
test('match record kinds are validated and survive snapshots alongside legacy matches', async () => {
  const core=new Conversations('b',{send:async()=>{},save:()=>{}});
  const match={interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:'exact' as const,score:1,fullScore:1,addrs:['addr']};
  await core.recordMatch(match);
  await core.recordMatch({...match,recordKind:'conference'});
  await assert.rejects(core.recordMatch({...match,recordKind:'roster'} as never),/invalid match/);
  const restarted=new Conversations('b',{send:async()=>{},save:()=>{}},core.snapshot());
  assert.deepEqual(restarted.read().events.map(e=>e.recordKind),[undefined,'conference']);
});

test('subscription save rejection changes nothing and hides pending state', async () => {
  let fail = true;
  let calls = 0;
  let releaseSave: () => void = () => {};
  let enteredSave = false;
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  const core = new Conversations('b', { send: async () => {}, save: () => {
    calls++;
    if (fail) throw new Error('disk full');
    if (!enteredSave) { enteredSave = true; return gate as unknown as void; }
  } });
  const before = core.snapshot();
  assert.ok(!('subscriptions' in before));
  await assert.rejects(core.setSubscription(subInput(subConf(1))), /disk full/);
  assert.deepEqual(core.snapshot(), before);
  assert.ok(!('subscriptions' in core.snapshot()));
  assert.deepEqual(core.subscriptions(), []);
  // Blocked save stays invisible until it resolves.
  fail = false;
  const pending = core.setSubscription(subInput(subConf(1)));
  await tick();
  assert.equal(calls, 2);
  assert.ok(!('subscriptions' in core.snapshot()));
  assert.deepEqual(core.subscriptions(), []);
  assert.deepEqual(core.read().events, []);
  releaseSave();
  const created = await pending;
  assert.equal(created.historyCursor, 0);
  assert.ok(created.id.length > 0);
  assert.equal(core.subscriptions().length, 1);
});

test('concurrent subscription cap is enforced atomically', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const first = core.setSubscription(subInput(subConf(1)), 2);
  const second = core.setSubscription(subInput(subConf(2)), 2);
  const third = core.setSubscription(subInput(subConf(3)), 2);
  const results = await Promise.allSettled([first, second, third]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(core.subscriptions().length, 2);
});

test('subscription renewal preserves id and cursor, and validation rejects bad input', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const first = await core.setSubscription(subInput(subConf(9), 's1', 'h1', 100));
  await core.applySubscriptionHistory(subConf(9), first.id, 0, 1, []);
  const renewed = await core.setSubscription(subInput(subConf(9), 's1', 'h2', 200));
  assert.equal(renewed.id, first.id);
  assert.equal(renewed.historyCursor, 1);
  assert.equal(renewed.host, 'h2');
  await assert.rejects(core.setSubscription(subInput(subConf(9), 'other', 'h2', 200)), /session|invalid/);
  for (const bad of [{ ...subInput(subConf(10)), conference: 'bad' }, { ...subInput(subConf(10)), session: '' },
    { ...subInput(subConf(10)), host: '' }, { ...subInput(subConf(10)), expires: 0 },
    { ...subInput(subConf(10)), membership: { descriptor: '', privateKey: 'aa' } },
    { ...subInput(subConf(10)), membership: { descriptor: 'zz', privateKey: 'aa' } }]) {
    await assert.rejects(core.setSubscription(bad as never), /invalid/);
  }
  await assert.rejects(core.setSubscription(subInput(subConf(11)), 0), /invalid|max/);
  await assert.rejects(core.setSubscription(subInput(subConf(11)), 129), /invalid|max/);
});

test('public subscriptions hide private membership and copies are detached', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const hex = 'ab'.repeat(8);
  await core.setSubscription(subInput(subConf(5), 's5', 'h5', 500, { descriptor: hex, privateKey: 'cd'.repeat(8) }));
  const pub = core.subscriptions('s5');
  assert.equal(pub.length, 1);
  assert.deepEqual(Object.keys(pub[0]).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session']);
  (pub[0] as { host: string }).host = 'mut';
  const stored = core.storedSubscriptions();
  const key = subConf(5);
  assert.equal(stored[key].membership?.descriptor, hex);
  stored[key].membership!.descriptor = '00';
  stored[key].host = 'mut2';
  const again = core.storedSubscriptions();
  assert.equal(again[key].membership?.descriptor, hex);
  assert.equal(again[key].host, 'h5');
  assert.ok(!JSON.stringify(core.read().events).includes(hex));
  assert.ok(!JSON.stringify(core.notificationState()).includes(hex));
  const snap = core.snapshot();
  assert.equal(snap.subscriptions?.[key].membership?.privateKey, 'cd'.repeat(8));
});

test('live record and history page overlap yields one durable event', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(21);
  const sub = await core.setSubscription(subInput(conf));
  const msg = 'aa'.repeat(16);
  await core.recordConference({ ...subMsg(conf, msg), peer: 'h1' });
  const before = core.read().events.length;
  const added = await core.applySubscriptionHistory(conf, sub.id, 0, 1, [{ ...subMsg(conf, msg), peer: 'h1' }]);
  assert.equal(added, 0);
  assert.equal(core.read().events.length, before);
  const stored = core.storedSubscriptions();
  assert.equal(stored[conf].historyCursor, 1);
});

test('restored snapshot dedups history replay and ack allows bounded redelivery', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(22);
  const sub = await core.setSubscription(subInput(conf));
  const m1 = 'b1'.repeat(16);
  const added = await core.applySubscriptionHistory(conf, sub.id, 0, 1, [{ ...subMsg(conf, m1), peer: 'h1' }]);
  assert.equal(added, 1);
  const restarted = new Conversations('b', { send: async () => {}, save: () => {} }, core.snapshot());
  const again = await restarted.applySubscriptionHistory(conf, sub.id, 1, 2, [{ ...subMsg(conf, m1), peer: 'h1' }]);
  assert.equal(again, 0);
  assert.equal(restarted.read().events.length, core.read().events.length);
  await restarted.ack(restarted.read().cursor);
});

test('invalid sibling rejects the whole page and stale after or id is a no-op', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(23);
  const sub = await core.setSubscription(subInput(conf));
  const good = { ...subMsg(conf, 'c1'.repeat(16)), peer: 'h1' };
  const bad = { ...subMsg(conf, 'c2'.repeat(16)), peer: 'h1', message: 'bad' };
  const eventsBefore = core.read().events.length;
  await assert.rejects(core.applySubscriptionHistory(conf, sub.id, 0, 2, [good, bad as never]), /invalid/);
  assert.equal(core.read().events.length, eventsBefore);
  assert.equal(core.storedSubscriptions()[conf].historyCursor, 0);
  assert.equal(await core.applySubscriptionHistory(conf, 'wrong-id', 0, 1, [good]), 0);
  assert.equal(await core.applySubscriptionHistory(conf, sub.id, 5, 6, [good]), 0);
  assert.equal(core.read().events.length, eventsBefore);
  assert.equal(core.storedSubscriptions()[conf].historyCursor, 0);
});

test('unsubscribe keeps inbox events and resubscribe mints a distinct id', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(24);
  const sub = await core.setSubscription(subInput(conf));
  await core.applySubscriptionHistory(conf, sub.id, 0, 1, [{ ...subMsg(conf, 'd1'.repeat(16)), peer: 'h1' }]);
  const eventsBefore = core.read().events.length;
  assert.equal(await core.removeSubscription('s1', conf), true);
  assert.equal(core.subscriptions().length, 0);
  assert.equal(core.read().events.length, eventsBefore);
  assert.equal(await core.removeSubscription('s1', conf), false);
  const resub = await core.setSubscription(subInput(conf));
  assert.notEqual(resub.id, sub.id);
  assert.equal(resub.historyCursor, 0);
  assert.equal(await core.removeSubscription('wrong', conf), false);
});

test('history page and cursor advance atomically on save failure', async () => {
  let fail = false;
  const core = new Conversations('b', { send: async () => {}, save: () => { if (fail) throw new Error('disk full'); } });
  const conf = subConf(25);
  const sub = await core.setSubscription(subInput(conf));
  fail = true;
  await assert.rejects(core.applySubscriptionHistory(conf, sub.id, 0, 2,
    [{ ...subMsg(conf, 'e1'.repeat(16)), peer: 'h1' }, { ...subMsg(conf, 'e2'.repeat(16)), peer: 'h1' }]), /disk full/);
  assert.equal(core.read().events.length, 0);
  assert.equal(core.storedSubscriptions()[conf].historyCursor, 0);
  fail = false;
  const added = await core.applySubscriptionHistory(conf, sub.id, 0, 2,
    [{ ...subMsg(conf, 'e1'.repeat(16)), peer: 'h1' }, { ...subMsg(conf, 'e2'.repeat(16)), peer: 'h1' }]);
  assert.equal(added, 2);
  assert.equal(core.read().events.length, 2);
  assert.equal(core.storedSubscriptions()[conf].historyCursor, 2);
  const gap = await core.applySubscriptionHistory(conf, sub.id, 2, 5, []);
  assert.equal(gap, 0);
  assert.equal(core.storedSubscriptions()[conf].historyCursor, 5);
});

test('recordConference uses the event as called, ignoring later caller mutation', async () => {
  let releaseSave: () => void = () => {};
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  let first = true;
  const core = new Conversations('b', { send: async () => {}, save: () => { if (first) return gate as unknown as void; } });
  const conf = subConf(31);
  const event = { kind: 'formed' as const, conference: conf, session: 's1', peer: 'h1', body: 'original' };
  const pending = core.recordConference(event);
  event.body = 'mutated';
  (event as { conference: string }).conference = subConf(32);
  await tick();
  assert.deepEqual(core.read().events, []);
  releaseSave();
  await pending;
  first = false;
  const stored = core.read().events;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].conference, conf);
  assert.equal(stored[0].body, 'original');
});

test('applySubscriptionHistory copies the page and rows before queueing', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(33);
  const sub = await core.setSubscription(subInput(conf));
  const row = { ...subMsg(conf, 'f1'.repeat(16)), peer: 'h1' };
  const page = [row];
  const pending = core.applySubscriptionHistory(conf, sub.id, 0, 1, page);
  page.push({ ...subMsg(conf, 'f2'.repeat(16)), peer: 'h1', message: 'bad' } as never);
  row.body = 'mutated';
  row.message = 'f2'.repeat(16);
  const added = await pending;
  assert.equal(added, 1);
  const stored = core.read().events;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].body, 'body-' + 'f1'.repeat(16).slice(0, 8));
  assert.equal(stored[0].message, 'f1'.repeat(16));
  assert.equal(core.storedSubscriptions()[conf].historyCursor, 1);
});

test('removeSubscription queued after setSubscription removes the new record', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(34);
  const setting = core.setSubscription(subInput(conf));
  const removing = core.removeSubscription('s1', conf);
  assert.equal(await setting !== undefined, true);
  assert.equal(await removing, true);
  assert.deepEqual(core.subscriptions(), []);
  assert.equal(core.storedSubscriptions()[conf], undefined);
});

test('conditional remove only removes the captured incarnation', async () => {
  const core = new Conversations('b', { send: async () => {}, save: () => {} });
  const conf = subConf(40);
  const first = await core.setSubscription(subInput(conf, 's1', 'h1', 100));
  assert.equal(await core.removeSubscription('s1', conf, { id: 'wrong', expires: 100 }), false);
  const renewed = await core.setSubscription(subInput(conf, 's1', 'h1', 200));
  assert.equal(renewed.id, first.id);
  assert.equal(await core.removeSubscription('s1', conf, { id: first.id, expires: 100 }), false);
  assert.equal(core.subscriptions().length, 1);
  assert.equal(await core.removeSubscription('s1', conf, { id: first.id, expires: 200 }), true);
  assert.deepEqual(core.subscriptions(), []);
  const c2 = subConf(41);
  const created = await core.setSubscription(subInput(c2, 's1', 'h1', 100));
  const renewal = core.setSubscription(subInput(c2, 's1', 'h1', 300));
  const stale = core.removeSubscription('s1', c2, { id: created.id, expires: 100 });
  await renewal;
  assert.equal(await stale, false);
  assert.equal(core.subscriptions().find(s => s.conference === c2)?.expires, 300);
});
