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
    {acked:0,waiters:0,rooms:[{room:'match:'+'a'.repeat(32),unread:1,oldest:1}]});
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
  assert.deepEqual(summary,{acked:1,waiters:0,rooms:[{room,unread:1,oldest:152}]});
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
