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

function pair() {
  let savedA: Snapshot | undefined;
  let savedB: Snapshot | undefined;
  const pending: { from: string; to: string; packet: Packet }[] = [];
  const a = new Conversations('a', { send: async (to,packet) => { pending.push({from:'a',to,packet}); }, save: s => { savedA=s; } });
  const b = new Conversations('b', { send: async (to,packet) => { pending.push({from:'b',to,packet}); }, save: s => { savedB=s; } });
  const drain = async () => { while(pending.length) { const p=pending.shift()!; await (p.to==='a'?a:b).receive(p.from,p.packet); } };
  return {a,b,drain,pending, saved: () => ({a:savedA,b:savedB})};
}

test('consent gates delivery, preserves provenance, and survives snapshot restart', async () => {
  const {a,b,drain,saved} = pair();
  const room = await a.invite('b'); await drain();
  await assert.rejects(a.send(room,'premature'), /consent/);
  await assert.rejects(b.send(room,'premature'), /consent/);
  await b.accept(room); await drain();
  await a.send(room,'a peer suggestion is not local authority'); await drain();
  const page=b.read();
  assert.equal(page.events.at(-1)?.body,'a peer suggestion is not local authority');
  assert.equal(page.events.at(-1)?.trust,'untrusted_peer_content');
  const restarted = new Conversations('b',{send: async()=>{},save:()=>{}},saved().b);
  assert.deepEqual(restarted.read(),page);
  assert.deepEqual(restarted.read(page.cursor).events,[]);
});

test('crossing invitations converge before any message is exchanged', async () => {
  const {a,b,drain}=pair();
  const first=await a.invite('b');
  const second=await b.invite('a');
  assert.equal(first,second); await drain();
  await a.send(first,'hello'); await b.send(second,'reply'); await drain();
  assert.equal(a.read().events.at(-1)?.body,'reply');
  assert.equal(b.read().events.at(-1)?.body,'hello');
});

test('authenticated sender binds room, duplicate delivery is idempotent, invalid messages rejected', async () => {
  const {a,b,drain,pending}=pair();
  const room=await a.invite('b'); await drain(); await b.accept(room); await drain();
  await a.send(room,'once'); const p=pending.shift()!;
  await b.receive('a',p.packet); const cursor=b.read().cursor; await b.receive('a',p.packet);
  assert.equal(b.read().cursor,cursor);
  assert.throws(()=>b.receive('attacker',p.packet),/bind/);
  await assert.rejects(b.receive('a',{kind:'message',room,id:'x',body:4}),/invalid message/);
  await assert.rejects(a.send(room,'x'.repeat(16385)),/bytes/);
  assert.throws(()=>b.read(cursor+1),/cursor/);
});

test('ack persists the processed cursor and rejects backward or future acknowledgments', async () => {
  const {a,b,drain,saved}=pair();
  const room=await a.invite('b'); await drain(); await b.accept(room); await drain();
  await a.send(room,'processed'); await drain();
  const page=b.read();
  await b.ack(page.cursor);
  assert.deepEqual(b.read().events,[]);
  assert.equal(b.read(0).events.length,page.events.length);
  assert.throws(()=>b.ack(page.cursor-1),/cursor/);
  assert.throws(()=>b.ack(page.cursor+1),/cursor/);
  const restarted=new Conversations('b',{send:async()=>{},save:()=>{}},saved().b);
  assert.deepEqual(restarted.read().events,[]);
  await a.send(room,'unread'); await drain();
  assert.equal(b.read().events[0]?.body,'unread');
});

test('wait returns persisted events and cleans up on delivery, timeout, or cancellation', async () => {
  const {a,b,drain}=pair();
  const room=await a.invite('b'); await drain();   await b.accept(room); await drain();
  await b.ack(b.read().cursor);
  const waiting=b.wait(undefined,1000);
  assert.equal(b.waiters(),1);
  await a.send(room,'wake'); await drain();
  assert.equal((await waiting).events[0]?.body,'wake');
  assert.equal(b.waiters(),0);
  assert.equal((await b.wait(undefined,1000)).events[0]?.body,'wake');
  await b.ack(b.read().cursor);
  await assert.rejects(b.wait(undefined,5),/timed out/);
  assert.equal(b.waiters(),0);
  const controller=new AbortController();
  const canceled=b.wait(undefined,1000,controller.signal);
  controller.abort();
  await assert.rejects(canceled);
  assert.equal(b.waiters(),0);
});

test('failed ack save restores the previous unread cursor', async () => {
  const {a,b,drain,saved}=pair();
  const room=await a.invite('b'); await drain();
  const restarted=new Conversations('b',{send:async()=>{},save:()=>{throw new Error('disk full');}},saved().b);
  await assert.rejects(restarted.ack(b.read().cursor),/disk full/);
  assert.equal(restarted.read().events.length,1);
});

test('failed message save neither exposes unread mail nor notifies a wake listener', async () => {
  const {a,b,drain,pending,saved}=pair();
  const room=await a.invite('b'); await drain(); await b.accept(room); await drain();
  await b.ack(b.read().cursor);
  const restarted=new Conversations('b',{send:async()=>{},save:()=>{throw new Error('disk full');}},saved().b);
  let notified=false;
  restarted.onEvents(()=>{notified=true;});
  await a.send(room,'not durable');
  await assert.rejects(restarted.receive('a',pending.shift()!.packet),/disk full/);
  assert.deepEqual(restarted.read().events,[]);
  assert.equal(notified,false);
});

test('failed invite and accept saves restore consent and send nothing, then allow retry', async () => {
  const sent: Packet[]=[];
  let fail=true;
  let saved: Snapshot | undefined;
  const core=new Conversations('a',{
    send:async(_peer,packet)=>{sent.push(packet);},
    save:state=>{if(fail) throw new Error('disk full'); saved=state;}
  });
  const before=core.snapshot();
  await assert.rejects(core.invite('b'),/disk full/);
  assert.deepEqual(core.snapshot(),before);
  assert.equal(sent.length,0);
  fail=false;
  const room=await core.invite('b');
  assert.equal(saved?.rooms[room].localConsent,true);
  assert.equal(sent.length,1);

  const received=new Conversations('a',{
    send:async(_peer,packet)=>{sent.push(packet);},
    save:state=>{if(fail) throw new Error('disk full'); saved=state;}
  });
  await received.receive('b',{kind:'invite',room});
  const invited=received.snapshot();
  fail=true;
  await assert.rejects(received.accept(room),/disk full/);
  assert.deepEqual(received.snapshot(),invited);
  assert.equal(sent.length,1);
  fail=false;
  await received.accept(room);
  assert.equal(saved?.rooms[room].localConsent,true);
  assert.equal(sent.length,2);
});

// Docs: VORTEX_v5.1.md section 9.1
test('a recorded match is returned with all fields and untrusted trust', async () => {
  const core=new Conversations('b',{send:async()=>{},save:()=>{}});
  await core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:8,score:0.93,fullScore:0.93,
    addrs:['/ip4/127.0.0.1/tcp/1/p2p/c'],statement:'peer words'});
  const events=core.read().events;
  assert.equal(events.length,1);
  assert.deepEqual(events[0],{cursor:1,kind:'match',room:'match:'+'a'.repeat(32),peer:'c',
    interest:'a'.repeat(32),record:'b'.repeat(32),tier:8,score:0.93,fullScore:0.93,
    addrs:['/ip4/127.0.0.1/tcp/1/p2p/c'],statement:'peer words',trust:'untrusted_peer_content'});
  assert.ok(!('body' in events[0]));
});

// Docs: VORTEX_v5.1.md section 9.1
test('a failed match save stores nothing and a later recordMatch works', async () => {
  let fail=true;
  const core=new Conversations('b',{send:async()=>{},save:()=>{if(fail) throw new Error('disk full');}});
  await assert.rejects(core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:'exact',score:1,
    fullScore:1,addrs:['/ip4/1/tcp/1/p2p/c']}),/disk full/);
  assert.deepEqual(core.read().events,[]);
  fail=false;
  await core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:'exact',score:1,
    fullScore:1,addrs:['/ip4/1/tcp/1/p2p/c']});
  assert.equal(core.read().events.length,1);
});

// Docs: VORTEX_v5.1.md section 9.3
test('a plain wait resolves on a match event', async () => {
  const core=new Conversations('b',{send:async()=>{},save:()=>{}});
  const waiting=core.wait(undefined,1000);
  await core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:4,score:0.95,fullScore:0.7,
    addrs:['/ip4/1/tcp/1/p2p/c']});
  assert.equal((await waiting).events[0]?.kind,'match');
});

// Docs: VORTEX_v5.1.md section 9.3
test('notificationState counts an unread match without consent and drops it after ack', async () => {
  const core=new Conversations('b',{send:async()=>{},save:()=>{}});
  await core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:'exact',score:1,fullScore:1,
    addrs:['/ip4/1/tcp/1/p2p/c']});
  assert.deepEqual(core.notificationState(),
    {acked:0,waiters:0,rooms:[{room:'match:'+'a'.repeat(32),unread:1,oldest:1,hasData:false}]});
  await core.ack(core.read().cursor);
  assert.deepEqual(core.notificationState().rooms,[]);
});

// Docs: VORTEX_v5.1.md section 9.1
test('recordMatch refuses invalid input and stores nothing', async () => {
  const core=new Conversations('b',{send:async()=>{},save:()=>{}});
  const good={interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:8 as const,score:0.9,fullScore:0.9,addrs:['/ip4/1/tcp/1/p2p/c']};
  const bad=[
    {...good,record:undefined},{...good,record:'z'.repeat(32)},{...good,interest:''},{...good,peer:''},{...good,tier:NaN},{...good,score:Infinity},
    {...good,fullScore:NaN},{...good,addrs:[]},
    {...good,addrs:['/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c',
      '/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c','/ip4/1/tcp/1/p2p/c']},
    {...good,addrs:['x'.repeat(512)]},{...good,statement:'x'.repeat(4097)},
  ];
  for(const input of bad) await assert.rejects(core.recordMatch(input as never),/invalid match/);
  assert.deepEqual(core.read().events,[]);
  assert.deepEqual(core.notificationState().rooms,[]);
});

// Docs: VORTEX_v5.1.md section 9.3
test('a snapshot without match events still loads', async () => {
  const old:{rooms:{},events:{cursor:number,kind:'message',room:string,peer:string,body:string,
    trust:'untrusted_peer_content'}[],seen:string[],cursor:number} =
    {rooms:{},events:[{cursor:1,kind:'message',room:'r',peer:'a',body:'hi',trust:'untrusted_peer_content'}],
      seen:[],cursor:1};
  const core=new Conversations('b',{send:async()=>{},save:()=>{}},old);
  assert.equal(core.read().events[0]?.body,'hi');
  await core.recordMatch({interest:'a'.repeat(32),record:'b'.repeat(32),peer:'c',tier:2,score:0.9,fullScore:0.5,
    addrs:['/ip4/1/tcp/1/p2p/c']});
  assert.equal(core.read().events.length,2);
});

// Docs: VORTEX_v5.1.md section 10.5
test('a peer packet of kind match is rejected with and without consent', async () => {
  for(const consented of [false,true]) {
    const {a,b,drain}=pair();
    const room=await a.invite('b'); await drain();
    if(consented) { await b.accept(room); await drain(); }
    const eventsBefore=b.read().events;
    const stateBefore=b.notificationState();
    assert.throws(()=>b.receive('a',{kind:'match',room,interest:'a'.repeat(32),peer:'a',
      tier:8,score:0.9,fullScore:0.9,addrs:['/ip4/1/tcp/1/p2p/a']}),/unknown packet kind/);
    assert.deepEqual(b.read().events,eventsBefore);
    assert.deepEqual(b.notificationState(),stateBefore);
  }
});

test('notification metadata sees every unread room and excludes bodies and unconsented rooms', async () => {
  const {a,b,drain}=pair();
  const room=await a.invite('b'); await drain(); await b.accept(room); await drain();
  await b.ack(b.read().cursor);
  for(let i=0;i<150;i++) await b.receive('stranger'+i,{kind:'invite',room:b.roomFor('stranger'+i)});
  await a.send(room,'private peer text'); await drain();
  const summary=b.notificationState();
  assert.deepEqual(summary,{acked:1,waiters:0,rooms:[{room,unread:1,oldest:152,hasData:true}]});
  assert.ok(!JSON.stringify(summary).includes('private peer text'));
  summary.rooms[0].unread=9;
  assert.equal(b.notificationState().rooms[0].unread,1);
});

test('state observers follow durable changes and waiter attach/detach, including cancellation', async () => {
  const {a,b,drain,saved}=pair();
  const room=await a.invite('b'); await drain(); await b.accept(room); await drain();
  await b.ack(b.read().cursor);
  const states: ReturnType<Conversations['notificationState']>[]=[];
  const off=b.onChange(()=>states.push(b.notificationState()));
  const controller=new AbortController();
  const waiting=b.wait(undefined,1000,controller.signal);
  assert.equal(states.at(-1)?.waiters,1);
  controller.abort();
  await assert.rejects(waiting,/canceled/);
  assert.equal(states.at(-1)?.waiters,0);
  await a.send(room,'new'); await drain();
  assert.equal(states.at(-1)?.rooms[0].unread,1);
  await b.ack(b.read().cursor);
  assert.deepEqual(states.at(-1)?.rooms,[]);
  off();
  const count=states.length;
  await a.send(room,'after detach'); await drain();
  assert.equal(states.length,count);
  const failing=new Conversations('b',{send:async()=>{},save:()=>{throw Error('disk full');}},saved().b);
  let changed=false;
  failing.onChange(()=>{changed=true;});
  await assert.rejects(failing.ack(failing.read().cursor),/disk full/);
  assert.equal(changed,false);
});

const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** A save returning a promise the test resolves by hand; tracks concurrency. */
function deferredSave() {
  const calls: { resolve: () => void, reject: (e: unknown) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const save = (_snapshot: Snapshot) => new Promise<void>((resolve, reject) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ resolve: () => { inFlight--; resolve(); }, reject: (e: unknown) => { inFlight--; reject(e); } });
  });
  return { save, calls, stats: () => ({ maxInFlight }) };
}

function consentedB(save: (_snapshot: Snapshot) => void | Promise<void>) {
  const room = JSON.stringify(['a', 'b'].sort());
  const restored: Snapshot = { rooms: { [room]: { peer: 'a', localConsent: true, remoteConsent: true } }, events: [], seen: [], cursor: 0 };
  return { core: new Conversations('b', { send: async () => {}, save }, restored), room };
}

// Docs: VORTEX_v5.1.md §8.3; TODO.md C7a. Pruning must preserve unread mail and cursor identity.
test('retention keeps unread events, prunes acknowledged history, and survives restart', async () => {
  const restored=consentedB(()=>{}).core.snapshot();
  let saved: Snapshot | undefined;
  const core=new Conversations('b',{send:async()=>{},save:s=>{saved=s;}},restored,
    {historyLimit:2,dedupLimit:2});
  const room=core.roomFor('a');
  for(let i=1;i<=6;i++) await core.receive('a',{kind:'message',room,id:'m'+i,body:'body'+i});
  assert.equal(core.read().events.length,6);
  await core.ack(4);
  assert.deepEqual(core.read(0).events.map(e=>e.cursor),[3,4,5,6]);
  assert.deepEqual(core.read().events.map(e=>e.body),['body5','body6']);
  assert.equal(core.notificationState().rooms[0].unread,2);
  const restarted=new Conversations('b',{send:async()=>{},save:()=>{}},saved,
    {historyLimit:2,dedupLimit:2});
  assert.deepEqual(restarted.read(),core.read());
  await restarted.ack(6);
  assert.deepEqual(restarted.read(0).events.map(e=>e.cursor),[5,6]);
  await restarted.receive('a',{kind:'message',room,id:'m7',body:'next'});
  assert.equal(restarted.read().cursor,7);
});

// Removing unread-ID protection would redeliver m1 after newer messages fill the cache.
test('deduplication pins unread ids and bounds acknowledged ids across restart', async () => {
  const core=new Conversations('b',{send:async()=>{},save:()=>{}},consentedB(()=>{}).core.snapshot(),
    {historyLimit:0,dedupLimit:2});
  const room=core.roomFor('a');
  for(let i=1;i<=5;i++) await core.receive('a',{kind:'message',room,id:'m'+i,body:'once'});
  await core.receive('a',{kind:'message',room,id:'m1',body:'replay'});
  assert.equal(core.read().cursor,5);
  await core.ack(3);
  assert.equal(core.snapshot().seen.length,2);
  const restarted=new Conversations('b',{send:async()=>{},save:()=>{}},core.snapshot(),
    {historyLimit:0,dedupLimit:2});
  await restarted.receive('a',{kind:'message',room,id:'m4',body:'replay'});
  assert.equal(restarted.read().cursor,5);
  await restarted.ack(5);
  assert.equal(restarted.read(0).events.length,0);
  await restarted.receive('a',{kind:'message',room,id:'m5',body:'recent replay'});
  assert.equal(restarted.snapshot().cursor,5);
  await restarted.receive('a',{kind:'message',room,id:'m1',body:'outside window'});
  assert.equal(restarted.read().cursor,6);
});

test('legacy seen ids stay protected until the legacy unread cursor is acknowledged', async () => {
  const {core:original,room}=consentedB(()=>{});
  for(let i=1;i<=3;i++) await original.receive('a',{kind:'message',room,id:'m'+i,body:'old'});
  const legacy=original.snapshot();
  delete legacy.seenAt;
  const core=new Conversations('b',{send:async()=>{},save:()=>{}},legacy,{historyLimit:0,dedupLimit:1});
  await core.receive('a',{kind:'message',room,id:'new',body:'new'});
  await core.receive('a',{kind:'message',room,id:'m1',body:'replay'});
  assert.equal(core.read().cursor,4);
  await core.ack(3);
  assert.equal(core.snapshot().seen.length,1);
  assert.deepEqual(core.read(0).events.map(e=>e.cursor),[4]);
});

test('a failed pruning save leaves history, deduplication and acknowledgment intact', async () => {
  let fail=false;
  const core=new Conversations('b',{send:async()=>{},save:()=>{if(fail) throw Error('disk full');}},
    consentedB(()=>{}).core.snapshot(),{historyLimit:0,dedupLimit:0});
  const room=core.roomFor('a');
  await core.receive('a',{kind:'message',room,id:'m',body:'unread'});
  const before=core.snapshot();
  fail=true;
  await assert.rejects(core.ack(1),/disk full/);
  assert.deepEqual(core.snapshot(),before);
  fail=false;
  await core.receive('a',{kind:'message',room,id:'m',body:'replay'});
  assert.deepEqual(core.snapshot(),before);
  await core.ack(1);
  assert.equal(core.snapshot().seen.length,0);
  assert.equal(core.read(0).events.length,0);
});

test('retention bounds every event kind and rejects invalid local limits', async () => {
  for(const limit of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    for(const field of ['historyLimit','dedupLimit']) {
      assert.throws(()=>new Conversations('b',{send:async()=>{},save:()=>{}},undefined,{[field]:limit}),/retention/);
    }
  }
  const core=new Conversations('b',{send:async()=>{},save:()=>{}},undefined,{historyLimit:1});
  await core.receive('a',{kind:'invite',room:core.roomFor('a')});
  await core.recordConference({kind:'arrival',conference:'a'.repeat(32),session:'s',peer:'a'});
  await core.recordMatch({interest:'local',record:'b'.repeat(32),peer:'a',tier:'exact',score:1,fullScore:1,addrs:['addr']});
  await core.ack(3);
  assert.deepEqual(core.read(0).events.map(e=>e.kind),['match']);
});

test('a pending save hides the event until it resolves', async () => {
  const deferred = deferredSave();
  const { core } = consentedB(deferred.save);
  const received = core.receive('a', { kind: 'message', room: core.roomFor('a'), id: 'm1', body: 'hi' });
  await tick();
  assert.equal(deferred.calls.length, 1);
  assert.deepEqual(core.read().events, []);
  let fired = false;
  core.onEvents(() => { fired = true; });
  assert.equal(fired, false);
  deferred.calls[0].resolve();
  await received;
  assert.equal(core.read().events.length, 1);
  assert.equal(core.read().cursor, 1);
  assert.equal(core.read().events[0]?.body, 'hi');
  assert.equal(fired, true);
});

test('back-to-back receives save serially with consecutive cursors', async () => {
  const deferred = deferredSave();
  const core = new Conversations('b', { send: async () => {}, save: deferred.save });
  const room = core.roomFor('a');
  const first = core.receive('a', { kind: 'invite', room });
  const second = core.receive('c', { kind: 'invite', room: core.roomFor('c') });
  await tick();
  assert.equal(deferred.calls.length, 1);
  deferred.calls[0].resolve();
  await first;
  await tick();
  assert.equal(deferred.calls.length, 2);
  deferred.calls[1].resolve();
  await second;
  const events = core.read().events;
  assert.deepEqual(events.map(e => e.cursor), [1, 2]);
  assert.deepEqual(events.map(e => e.peer), ['a', 'c']);
  assert.equal(deferred.stats().maxInFlight, 1);
});

test('a rejecting save leaves no event and the same id can be received again', async () => {
  const deferred = deferredSave();
  const { core, room } = consentedB(deferred.save);
  const first = core.receive('a', { kind: 'message', room, id: 'm1', body: 'first' });
  await tick();
  const second = core.receive('a', { kind: 'message', room, id: 'm2', body: 'second' });
  deferred.calls[0].reject(new Error('disk full'));
  await assert.rejects(first, /disk full/);
  assert.deepEqual(core.read().events, []);
  await tick();
  assert.equal(deferred.calls.length, 2);
  deferred.calls[1].resolve();
  await second;
  assert.equal(core.read().events.length, 1);
  assert.equal(core.read().events[0]?.body, 'second');
  const retry = core.receive('a', { kind: 'message', room, id: 'm1', body: 'first again' });
  await tick();
  deferred.calls[2].resolve();
  await retry;
  assert.equal(core.read().events.length, 2);
  assert.equal(core.read().events[1]?.body, 'first again');
});

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

const conferenceEvents = [
  {kind:'formed' as const},
  {kind:'arrival' as const,participant:'b'.repeat(64),service:'c',count:2},
  {kind:'departure' as const,participant:'b'.repeat(64),count:1},
  {kind:'conference_message' as const,participant:'b'.repeat(64),service:'c',message:'c'.repeat(32),type:'text',replyTo:'d'.repeat(32),body:'peer words'},
  {kind:'closed' as const,reason:'host_closed'}
];
// Docs: VORTEX_v5.1.md sections 6.2, 6.4, 9.3 and 10.5
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
  assert.deepEqual(core.notificationState().rooms,[{room:'conference:'+'a'.repeat(32),unread:5,oldest:1,hasData:true}]);
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

// TODO.md C8 durable subscription store.
const subConf = (i: number): string => i.toString(16).padStart(32, '0');
const subInput = (conference: string, session = 's1', host = 'h1', expires = 9999999999999, membership?: { descriptor: string, privateKey: string }): { conference: string, session: string, host: string, expires: number, membership?: { descriptor: string, privateKey: string } } =>
  membership === undefined ? { conference, session, host, expires } : { conference, session, host, expires, membership };
const subMsg = (conference: string, message: string, session = 's1', peer = 'h1'): { kind: 'conference_message', conference: string, session: string, peer: string, message: string, type: string, body: string } =>
  ({ kind: 'conference_message', conference, session, peer, message, type: 'text', body: 'body-' + message.slice(0, 8) });

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

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — private durable peer-outcome memory.
const memoryProfile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 3, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
});
const memoryVector = Float32Array.from([0.5, -0.25, 0.125, 1, 0, 0, 0, 2]);
const memoryVectorHex = Array.from(encodeVector(memoryVector), byte => byte.toString(16).padStart(2, '0')).join('');

async function memoryPeer (): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

async function memoryRecord (overrides: Partial<PeerMemoryRecord> = {}): Promise<PeerMemoryRecord> {
  const at = Date.now();
  return {
    peer: await memoryPeer(),
    participant: 'ab'.repeat(32),
    namespace: memoryProfile.id,
    profileVersion: 3,
    statement: 'handled it well',
    vector: memoryVectorHex,
    outcome: 'useful',
    recordedAt: at - 1000,
    expires: at + 8000000,
    ...overrides
  };
}

function memoryCore (save?: (s: Snapshot) => void | Promise<void>): Conversations {
  return new Conversations('b', { send: async () => {}, save: save ?? (() => {}) });
}

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

// Topic routing (VORTEX_v5.1.md §§4–5; skills/vortex/SKILL.md one topic = one thread).
function routedPair(route: (peer: string, body: string) => Promise<{ conference: string; tier: 'exact' | number; score: number } | undefined>) {
  const pending: { to: string; packet: Packet }[] = [];
  const a = new Conversations('a', { send: async (to,packet) => { pending.push({to,packet}); }, save: () => {} });
  const b = new Conversations('b', { send: async (to,packet) => { pending.push({to,packet}); }, save: () => {}, route });
  const deliver = async () => { while(pending.length) { const p=pending.shift()!; if(p.to==='b') await b.receive('a',p.packet); else await a.receive('b',p.packet); } };
  const connect = async () => { await a.invite('b'); await deliver(); await b.accept(a.roomFor('b')); await deliver(); };
  return {a,b,pending,deliver,connect};
}

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

test('head names the topic of the oldest unread event without its body', async () => {
  const {a,b,deliver,connect}=routedPair(async () => ({ conference: 'c'.repeat(32), tier: 'exact', score: 1 }));
  assert.equal(b.head(),undefined);
  await connect();
  await b.ack(b.read().cursor);
  await b.recordConference({ kind: 'conference_message', conference: 'd'.repeat(32), session: 'live', peer: 'a', message: 'e'.repeat(32), body: 'secret' });
  await a.send(a.roomFor('b'),'routed'); await deliver();
  const first=b.head()!;
  assert.deepEqual(first,{ cursor: first.cursor, conference: 'd'.repeat(32), session: 'live' });
  await b.ack(first.cursor);
  assert.deepEqual(b.head(),{ cursor: first.cursor+1, routingConference: 'c'.repeat(32) });
});

// Head-of-line (2026-10-23): a session-scoped reader handles its own topics
// wherever they sit in the queue, and its ack never discards another topic.
test('a scoped ack marks only owned events handled; foreign unread events survive and the watermark advances contiguously', async () => {
  type E = Snapshot['events'][number];
  const ev = (cursor: number, extra: Partial<E> = {}): E =>
    ({ cursor, kind: 'message', room: 'r', peer: 'p', body: `m${cursor}`, trust: 'untrusted_peer_content', ...extra });
  const live = (cursor: number) => ev(cursor, { kind: 'conference_message', room: 'conference:c1', conference: 'c1', session: 'live' });
  let saved: Snapshot | undefined;
  const snap: Snapshot = { rooms: {}, seen: [], cursor: 5, acked: 0, events: [ev(1), live(2), ev(3), live(4), live(5)] };
  const core = new Conversations('me', { send: async () => {}, save: s => { saved = s; } }, snap);
  const owned = (e: E) => e.session === 'live';
  assert.deepEqual(core.unreadTopics().map(t => t.cursor), [1, 2, 3, 4, 5]);
  await core.ack(4, owned);
  assert.deepEqual(core.read().events.map(e => e.cursor), [1, 3, 5], 'handled events leave the unread view; 5 was past the ack');
  assert.equal(core.notice().unread, 3);
  assert.equal(core.head()?.cursor, 1, 'the foreign head is still unread');
  assert.deepEqual(core.read(0).events.map(e => e.cursor), [1, 2, 3, 4, 5], 'history keeps every event');
  assert.deepEqual(core.notificationState().rooms.map(r => r.oldest), [5], 'handled conference events no longer count for rings');
  assert.equal(saved?.acked, 0);
  assert.deepEqual(saved?.handled, [2, 4]);
  const restarted = new Conversations('me', { send: async () => {}, save: () => {} }, saved);
  assert.deepEqual(restarted.read().events.map(e => e.cursor), [1, 3, 5], 'the handled set survives restart');
  await core.ack(1);
  assert.equal(core.snapshot().acked, 2, 'the watermark crosses the handled event behind it');
  assert.deepEqual(core.read().events.map(e => e.cursor), [3, 5]);
  await core.ack(5, owned);
  assert.deepEqual(core.read().events.map(e => e.cursor), [3]);
  await core.ack(3);
  assert.equal(core.snapshot().acked, 5);
  assert.equal(core.snapshot().handled, undefined, 'nothing above the watermark: the handled set is dropped');
  assert.throws(() => core.ack(6, owned), /cursor/);
  const prefixed = new Conversations('me', { send: async () => {}, save: () => {} }, { ...snap, handled: [1, 2] });
  assert.equal((await prefixed.wait(undefined, 50)).events[0]?.cursor, 3, 'wait skips handled events');
});
