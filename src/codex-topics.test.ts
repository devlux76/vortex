import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain ES module adapter without types
import { topicBatch } from '../skills/vortex/adapters/codex-topics.mjs';

const msg = (cursor: number, room = 'r') => ({ cursor, kind: 'message', room, peer: 'p', trust: 'untrusted_peer_content' });
const routed = (cursor: number) => ({ ...msg(cursor), routingConference: 'y' });
const conf = (cursor: number) => ({ ...msg(cursor, 'conference:x'), kind: 'conference_message', conference: 'x', session: 'live' });

// Head-of-line (2026-10-23): an event a scoped live session already handled
// is not part of the run, so it is neither offered nor re-handled.
test('a topic batch leaves out events a scoped session already handled', () => {
  assert.equal(topicBatch({ acked: 0, events: [routed(1), routed(2), routed(3)] }).through, 3);
  const batch = topicBatch({ acked: 0, handled: [2], events: [routed(1), routed(2), routed(3), conf(4)] });
  assert.deepEqual([batch.through, batch.cursors], [3, [1, 3]]);
  assert.equal(topicBatch({ acked: 0, handled: [1], events: [routed(1)] }), null, 'nothing unread: no batch');
});

// Charged room (2026-10-23): the router charged a room; the batch comes from it,
// not from the global oldest unread event of another room.
test('a ring charged to one room takes its batch from that room', () => {
  const snapshot = { acked: 0, events: [msg(1, 'legacy'), conf(2), msg(3, 'legacy'), conf(4)] };
  assert.equal(topicBatch(snapshot).room, 'legacy', 'without a charged room the global head is taken');
  const batch = topicBatch(snapshot, 'conference:x');
  assert.deepEqual([batch.room, batch.conference, batch.cursors, batch.through], ['conference:x', 'x', [2, 4], 4]);
  assert.equal(topicBatch(snapshot, 'nowhere'), null);
});

test('plain direct messages are keyed by their direct room, not by cursor', () => {
  const batch = topicBatch({ acked: 0, events: [msg(1, 'a'), msg(2, 'a'), msg(3, 'b')] });
  assert.deepEqual([batch.key, batch.cursors], [JSON.stringify(['direct', 'a']), [1, 2]]);
  assert.equal(topicBatch({ acked: 2, events: [msg(1, 'a'), msg(2, 'a'), msg(3, 'b')] }).key, JSON.stringify(['direct', 'b']));
});
