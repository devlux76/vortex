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
