// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — private durable peer-outcome store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { makeProfile } from '../embed/profile.ts';
import { encodeVector } from '../embed/vector.ts';
import {
  DEFAULT_PEER_MEMORY_LIMITS, checkPeerMemoryRecord, findPeerOutcome, peerMemoryIdentityKey,
  peerMemoryRecordBytes, validatePeerMemoryLimits,
  type PeerMemoryRecord
} from './peer-memory.ts';

const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 3, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
});
const otherProfile = makeProfile({
  model: 'n', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64,
  truncation: 'tail', pooling: 'mean', normalization: 'l2',
  dims: [8, 4, 2], encoding: 'float32le', version: 4, tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
});

const hexOf = (vector: Float32Array): string =>
  Array.from(encodeVector(vector), byte => byte.toString(16).padStart(2, '0')).join('');

async function peerId (): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

const goodVector = Float32Array.from([0.5, -0.25, 0.125, 1, 0, 0, 0, 2]);
const otherVector = Float32Array.from([0, 0.5, -0.25, 0.125, 1, 0, 0, 0]);

async function goodRecord (overrides: Partial<PeerMemoryRecord> = {}): Promise<PeerMemoryRecord> {
  return {
    peer: await peerId(),
    participant: 'ab'.repeat(32),
    namespace: profile.id,
    profileVersion: 3,
    statement: 'handled the flood alert well',
    vector: hexOf(goodVector),
    outcome: 'useful',
    recordedAt: 1000,
    expires: 2000,
    ...overrides
  };
}

test('valid records pass and every field rejects its own faults', async () => {
  checkPeerMemoryRecord(await goodRecord());
  const peer = await peerId();
  const cases: Array<[string, Partial<PeerMemoryRecord>]> = [
    ['peer', { peer: 'not-a-peer' }],
    ['peer', { peer: '' }],
    ['participant', { participant: 'ab'.repeat(31) }],
    ['participant', { participant: 'AB'.repeat(32) }],
    ['namespace', { namespace: 'zz' }],
    ['profileVersion', { profileVersion: 0 }],
    ['profileVersion', { profileVersion: 1.5 }],
    ['statement', { statement: '' }],
    ['statement', { statement: 'x'.repeat(4097) }],
    ['vector', { vector: 'zz' }],
    ['vector', { vector: 'ab' }],
    ['vector', { vector: 'ab'.repeat(16385) }],
    ['vector', { vector: '00'.repeat(32) }],
    ['outcome', { outcome: 'great' as never }],
    ['recordedAt', { recordedAt: -1 }],
    ['expires', { expires: 1000 }],
    ['expires', { expires: 1000.5 }]
  ];
  for (const [field, override] of cases) {
    const record = await goodRecord({ peer, ...override });
    assert.throws(() => checkPeerMemoryRecord(record), /invalid peer memory/, field);
  }
});

test('limits default and validate their bounds', () => {
  assert.deepEqual(validatePeerMemoryLimits(undefined), DEFAULT_PEER_MEMORY_LIMITS);
  assert.deepEqual(validatePeerMemoryLimits({}), DEFAULT_PEER_MEMORY_LIMITS);
  assert.deepEqual(validatePeerMemoryLimits({ maxCount: 10 }), { ...DEFAULT_PEER_MEMORY_LIMITS, maxCount: 10 });
  for (const limits of [{ maxCount: 0 }, { maxCount: 4097 }, { maxCount: 1.5 },
    { maxBytes: 0 }, { maxBytes: 67108865 }, { maxBytes: NaN }]) {
    assert.throws(() => validatePeerMemoryLimits(limits), /invalid peer memory limits/);
  }
  assert.deepEqual(validatePeerMemoryLimits({ maxCount: 4096, maxBytes: 67108864 }),
    { maxCount: 4096, maxBytes: 67108864 });
});

test('identity keys renew on peer, participant, namespace and vector', async () => {
  const base = await goodRecord();
  const same = { ...base };
  assert.equal(peerMemoryIdentityKey(same), peerMemoryIdentityKey(base));
  assert.notEqual(peerMemoryIdentityKey({ ...base, participant: 'cd'.repeat(32) }), peerMemoryIdentityKey(base));
  assert.notEqual(peerMemoryIdentityKey({ ...base, namespace: otherProfile.id }), peerMemoryIdentityKey(base));
  assert.notEqual(peerMemoryIdentityKey({ ...base, vector: hexOf(otherVector) }), peerMemoryIdentityKey(base));
  assert.notEqual(peerMemoryIdentityKey({ ...base, peer: await peerId() }), peerMemoryIdentityKey(base));
  // Outcome, statement and times do not affect identity: renewal overwrites.
  assert.equal(peerMemoryIdentityKey({ ...base, outcome: 'misleading', statement: 'changed', recordedAt: 9, expires: 9 }), peerMemoryIdentityKey(base));
  assert.ok(peerMemoryRecordBytes(base) > 0);
  assert.ok(peerMemoryRecordBytes({ ...base, statement: base.statement + '!' }) > peerMemoryRecordBytes(base));
});

test('lookup matches subjects, ignores the rest, and latest wins', async () => {
  const peer = await peerId();
  const stored: PeerMemoryRecord[] = [
    await goodRecord({ peer, outcome: 'misleading' }),
    await goodRecord({ peer, outcome: 'useful' })
  ];
  assert.equal(findPeerOutcome(stored, peer, goodVector, profile, undefined, 1500), 'useful');
  assert.equal(findPeerOutcome(stored, peer, otherVector, profile, undefined, 1500), 'neutral');
  assert.equal(findPeerOutcome([], peer, goodVector, profile, undefined, 1500), 'neutral');
  assert.equal(findPeerOutcome(stored, await peerId(), goodVector, profile, undefined, 1500), 'neutral');
  assert.equal(findPeerOutcome(stored, peer, goodVector, profile, undefined, 2500), 'neutral');
  const foreign = await goodRecord({ peer, namespace: otherProfile.id, vector: hexOf(goodVector) });
  assert.equal(findPeerOutcome([foreign], peer, goodVector, profile, undefined, 1500), 'neutral');
  // Malformed restored entries never score and never leak through lookup.
  const broken = { ...(await goodRecord({ peer })), vector: 'zz' };
  assert.equal(findPeerOutcome([broken], peer, goodVector, profile, undefined, 1500), 'neutral');
  assert.equal(findPeerOutcome([null, 3, "bad"] as never, peer, goodVector, profile, undefined, 1500), 'neutral');
  assert.throws(() => findPeerOutcome(stored, peer, new Float32Array(8), profile), /vector/);
});

test('subject validation accepts its shape and rejects faults without echo', async () => {
  const { checkPeerMemorySubject } = await import('./peer-memory.ts');
  const good = await goodRecord();
  checkPeerMemorySubject({ statement: good.statement, vector: good.vector,
    namespace: good.namespace, profileVersion: good.profileVersion });
  for (const bad of [
    undefined, null, 'text',
    { statement: '', vector: good.vector, namespace: good.namespace, profileVersion: 3 },
    { statement: 'x'.repeat(4097), vector: good.vector, namespace: good.namespace, profileVersion: 3 },
    { statement: good.statement, vector: 'zz', namespace: good.namespace, profileVersion: 3 },
    { statement: good.statement, vector: good.vector, namespace: 'zz', profileVersion: 3 },
    { statement: good.statement, vector: good.vector, namespace: good.namespace, profileVersion: 0 }
  ]) {
    assert.throws(() => checkPeerMemorySubject(bad as never), /invalid peer subject/);
  }
  // No source text in the error.
  try {
    checkPeerMemorySubject({ statement: '', vector: good.vector, namespace: good.namespace, profileVersion: 3 });
    assert.fail('must throw');
  } catch (error) {
    assert.ok(!(error as Error).message.includes('handled the flood'));
  }
});
