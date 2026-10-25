// Docs: VORTEX_v5.1.md §§4–5 (topics match by the cascade); skills/vortex/SKILL.md (one topic = one thread).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProfile } from '../embed/profile.ts';
import { routeToConference, routingThresholds, ROUTING_MARGIN } from './routing.ts';

const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 1, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
});
const v = (...xs: number[]) => new Float32Array(xs);
const room = (id: string, topicVector: Float32Array, namespace = profile.id) => ({ id, descriptor: { namespace, topicVector } });

test('routing picks the closest tier first, then the full-length score', () => {
  const message = v(1, 0, 0, 0, 0, 0, 0, 0);
  const prefixOnly = room('a'.repeat(32), v(1, 0, 0, 0, 1, 1, 1, 1));   // matches only at 4 and 2
  const full = room('b'.repeat(32), v(1, 0.3, 0, 0, 0, 0, 0, 0));         // matches at 8, not exact
  const exact = room('c'.repeat(32), v(2, 0, 0, 0, 0, 0, 0, 0));          // same direction: exact
  const best = routeToConference(message, [prefixOnly, full, exact], profile);
  assert.deepEqual(best && { conference: best.conference, tier: best.tier }, { conference: 'c'.repeat(32), tier: 'exact' });
  const second = routeToConference(message, [prefixOnly, full], profile);
  assert.equal(second?.conference, 'b'.repeat(32));
  assert.equal(second?.tier, 8);
  const closer = room('d'.repeat(32), v(1, 0.2, 0, 0, 0, 0, 0, 0));
  assert.equal(routeToConference(message, [full, closer], profile)?.conference, 'd'.repeat(32));
});

test('routing ignores conferences in another namespace and invalid vectors', () => {
  const message = v(1, 0, 0, 0, 0, 0, 0, 0);
  assert.equal(routeToConference(message, [room('a'.repeat(32), v(1, 0, 0, 0, 0, 0, 0, 0), 'f'.repeat(64))], profile), null);
  assert.equal(routeToConference(message, [room('a'.repeat(32), v(1, 0, 0))], profile), null);
  assert.equal(routeToConference(v(0, 0, 0, 0, 0, 0, 0, 0), [room('a'.repeat(32), message)], profile), null);
});

test('routing returns nothing below every threshold', () => {
  const message = v(1, 0, 0, 0, 0, 0, 0, 0);
  assert.equal(routeToConference(message, [room('a'.repeat(32), v(0, 1, 0, 0, 0, 0, 0, 0))], profile), null);
  assert.equal(routeToConference(message, [], profile), null);
  // Local thresholds replace the profile's defaults.
  const near = room('b'.repeat(32), v(1, 0.3, 0, 0, 0, 0, 0, 0));
  assert.equal(routeToConference(message, [near], profile, { 8: 0.99, 4: 0.99, 2: 0.99 }), null);
});

test('routing thresholds are the discovery thresholds raised by the margin', () => {
  assert.deepEqual(routingThresholds(profile), { 8: 0.9 + ROUTING_MARGIN, 4: 0.9 + ROUTING_MARGIN, 2: 0.9 + ROUTING_MARGIN });
  assert.equal(routingThresholds(profile, { 8: 0.99, 4: 0.9, 2: 0.9 })[8], 1);
  // cos 0.919 at full length: a discovery match, not a route.
  const message = v(1, 0, 0, 0, 0, 0, 0, 0), near = room('a'.repeat(32), v(1, 0.43, 0, 0, 0, 0, 0, 0));
  assert.equal(routeToConference(message, [near], profile)?.tier, 8);
  assert.equal(routeToConference(message, [near], profile, routingThresholds(profile)), null);
});
