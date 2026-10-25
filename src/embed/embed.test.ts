import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EmbeddingProfile } from '../types.ts'
import { GEMMA_PROFILE } from './gemma.ts'
import { compareCandidates, compareTiers, matchTier, resolveThresholds } from './match.ts'
import { makeProfile } from './profile.ts'
import { decodeVector, encodeVector, isValidVector, similarity } from './vector.ts'

const base: Omit<EmbeddingProfile, 'id'> = {
  model: 'm',
  revision: 'r1',
  weights: 'q4',
  prompt: 'p: ',
  maxTokens: 64,
  truncation: 'tail',
  pooling: 'mean',
  normalization: 'l2',
  dims: [8, 4, 2],
  encoding: 'float32le',
  version: 1,
  tolerance: 0.001,
  thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
}
const profile = makeProfile(base)
const vec = (...values: number[]): Float32Array => Float32Array.from(values)

// Docs: VORTEX_v5.1.md section 5.1
test('similarity is the cosine over the prefix, with norms taken over the prefix', () => {
  const u = vec(1, 0, 5, 5, 0, 0, 0, 0)
  const v = vec(2, 0, -5, 5, 0, 0, 0, 0)
  assert.equal(similarity(u, v, 2), 1)
  assert.ok(Math.abs(similarity(u, v, 4) - 2 / Math.sqrt(51 * 54)) < 1e-12)
  assert.equal(similarity(vec(1, 0), vec(0, 1), 2), 0)
  assert.equal(similarity(vec(1, 0), vec(-3, 0), 2), -1)
})

// Docs: VORTEX_v5.1.md section 5.1
test('similarity rejects vectors that cannot be compared', () => {
  assert.throws(() => similarity(vec(1), vec(1, 2), 2), /shorter/)
  assert.throws(() => similarity(vec(0, 0, 9), vec(1, 1, 1), 2), /zero norm/)
  assert.throws(() => similarity(vec(1), vec(1), 0), /positive integer/)
})

// Docs: VORTEX_v5.1.md section 2.4
test('a published vector round-trips as float32 little-endian, unchanged', () => {
  const u = vec(0.5, -0.25, 1e-20, 3, 0, 0, 0, -1)
  const bytes = encodeVector(u)
  assert.equal(bytes.length, 32)
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0, 0, 0, 0x3f])
  assert.deepEqual(decodeVector(bytes, profile), u)
  // A view into a larger buffer at an odd offset decodes the same.
  const padded = new Uint8Array(33)
  padded.set(bytes, 1)
  assert.deepEqual(decodeVector(padded.subarray(1), profile), u)
})

// Docs: VORTEX_v5.1.md section 2.4
test('decodeVector refuses the wrong length, non-finite components and zero vectors', () => {
  assert.throws(() => decodeVector(new Uint8Array(16), profile), /32 bytes/)
  assert.throws(() => decodeVector(encodeVector(vec(1, NaN, 0, 0, 0, 0, 0, 0)), profile), /non-finite/)
  assert.throws(() => decodeVector(new Uint8Array(32), profile), /zero norm/)
  // Zero over the shortest prefix cannot be scored there, so it is not usable.
  assert.equal(isValidVector(vec(0, 0, 1, 1, 1, 1, 1, 1), profile), false)
  assert.equal(isValidVector(vec(1, 0, 0, 0), profile), false)
})

// Docs: VORTEX_v5.1.md section 2.4
test('namespace changes with every field that affects the vector, and with nothing else', () => {
  const id = profile.id
  assert.match(id, /^[0-9a-f]{64}$/)
  assert.equal(makeProfile(base).id, id)
  const changes: Array<Partial<Omit<EmbeddingProfile, 'id'>>> = [
    { model: 'n' }, { revision: 'r2' }, { weights: 'q8' }, { prompt: 'q: ' }, { maxTokens: 32 },
    { pooling: 'cls' }, { normalization: 'none' },
    { dims: [8, 4], thresholds: { 8: 0.9, 4: 0.9 } }
  ]
  for (const change of changes) assert.notEqual(makeProfile({ ...base, ...change }).id, id, JSON.stringify(change))
  assert.equal(makeProfile({ ...base, version: 2 }).id, id)
  assert.equal(makeProfile({ ...base, tolerance: 0.01 }).id, id)
  assert.equal(makeProfile({ ...base, thresholds: { 8: 0.5, 4: 0.5, 2: 0.5 } }).id, id)
})

// Docs: VORTEX_v5.1.md section 2.4
test('makeProfile refuses a profile that cannot be matched under', () => {
  assert.throws(() => makeProfile({ ...base, dims: [4, 8, 2] }), /decreasing/)
  assert.throws(() => makeProfile({ ...base, dims: [] }), /at least one/)
  assert.throws(() => makeProfile({ ...base, revision: '' }), /revision/)
  assert.throws(() => makeProfile({ ...base, version: 0 }), /version/)
  assert.throws(() => makeProfile({ ...base, tolerance: 1 }), /tolerance/)
  assert.throws(() => makeProfile({ ...base, thresholds: { 8: 0.9, 4: 0.9 } }), /length 2/)
  assert.throws(() => makeProfile({ ...base, thresholds: { 8: 0.9, 4: 0.9, 2: 0.9, 3: 0.9 } }), /unsupported length 3/)
})

// Docs: VORTEX_v5.1.md section 2.4
test('the reference profile is the one Section 2.4 names', () => {
  assert.equal(GEMMA_PROFILE.model, 'onnx-community/embeddinggemma-2-ONNX')
  assert.match(GEMMA_PROFILE.revision, /^[0-9a-f]{40}$/)
  assert.equal(GEMMA_PROFILE.weights, 'q4')
  assert.equal(GEMMA_PROFILE.prompt, 'task: clustering | query: ')
  assert.deepEqual(GEMMA_PROFILE.dims, [768, 512, 256, 128])
  assert.equal(GEMMA_PROFILE.maxTokens, 8192)
  assert.equal(GEMMA_PROFILE.encoding, 'float32le')
})

// Docs: VORTEX_v5.1.md section 5.2
test('cascade: exact within tolerance, then full length, then shorter prefixes longest first', () => {
  const u = vec(1, 1, 1, 1, 1, 1, 1, 1)
  assert.deepEqual(matchTier(u, vec(2, 2, 2, 2, 2, 2, 2, 2), profile), { tier: 'exact', score: 1 })
  // Runtime noise inside the tolerance is still the same statement.
  assert.equal(matchTier(u, vec(1, 1, 1, 1, 1, 1, 1, 1.05), profile)?.tier, 'exact')
  // Same specific problem: over the full-length threshold but not identical.
  const near = matchTier(u, vec(1, 1, 1, 1, 1, 1, 0.5, 0.5), profile)
  assert.equal(near?.tier, 8)
  assert.ok(near !== null && near.score >= 0.9 && near.score < 0.999)
  // Agrees on the first four components only.
  assert.deepEqual(matchTier(u, vec(1, 1, 1, 1, -1, -1, -1, -1), profile), { tier: 4, score: 1 })
  // Agrees on the first two only: the widest tier.
  assert.deepEqual(matchTier(u, vec(1, 1, -1, -1, -1, -1, 1, 1), profile), { tier: 2, score: 1 })
  assert.equal(matchTier(u, vec(1, -1, 1, -1, 1, -1, 1, -1), profile), null)
})

// Docs: VORTEX_v5.1.md section 5.2
test('cascade reports the first tier that matches, not the best-scoring one', () => {
  // Scores about 0.96 at 8 and 1 at 4: the tier is 8.
  const tier = matchTier(vec(1, 1, 1, 1, 1, 1, 1, 1), vec(1, 1, 1, 1, 1, 1, 0.4, 0.4), profile)
  assert.equal(tier?.tier, 8)
})

// Docs: VORTEX_v5.1.md section 5.2
test('thresholds are local policy over the profile defaults, one per length', () => {
  const u = vec(1, 1, 1, 1, 1, 1, 1, 1)
  const v = vec(1, 1, 1, 1, -1, -1, -1, -1)
  const strict = resolveThresholds(profile, { 4: 1, 2: 1 })
  assert.deepEqual(strict, { 8: 0.9, 4: 1, 2: 1 })
  assert.deepEqual(matchTier(u, v, profile, strict), { tier: 4, score: 1 })
  const loose = resolveThresholds(profile, { 8: -0.5 })
  assert.deepEqual(matchTier(u, v, profile, loose), { tier: 8, score: 0 })
  assert.throws(() => resolveThresholds(profile, { 16: 0.5 }), /unsupported length 16/)
  assert.throws(() => resolveThresholds(profile, { 4: 2 }), /length 4/)
  assert.throws(() => matchTier(u, vec(1, 1), profile), /not valid/)
})

// Docs: VORTEX_v5.1.md section 5.3
test('tiers order closest first and ignore the score at the tier', () => {
  const tiers = [
    { tier: 2, score: 0.99 }, { tier: 8, score: 0.91 }, { tier: 'exact' as const, score: 1 }, { tier: 4, score: 0.97 }
  ]
  assert.deepEqual(tiers.sort(compareTiers).map(t => t.tier), ['exact', 8, 4, 2])
  assert.equal(compareTiers({ tier: 4, score: 0.91 }, { tier: 4, score: 0.99 }), 0)
})

// Docs: VORTEX_v5.1.md sections 5.3 and 11.2
test('candidates order by tier, then by similarity at full resolution, not by the score at the tier', () => {
  // Two candidates in tier 4: `a` scores higher over the prefix, `b` is nearer at full resolution.
  const a = { name: 'a', tier: { tier: 4, score: 0.99 }, fullScore: 0.2 }
  const b = { name: 'b', tier: { tier: 4, score: 0.91 }, fullScore: 0.7 }
  const c = { name: 'c', tier: { tier: 8, score: 0.9 }, fullScore: 0.9 }
  const d = { name: 'd', tier: { tier: 'exact' as const, score: 1 }, fullScore: 1 }
  const e = { name: 'e', tier: { tier: 2, score: 1 }, fullScore: 0.75 }
  assert.deepEqual([a, b, c, d, e].sort(compareCandidates).map(x => x.name), ['d', 'c', 'b', 'a', 'e'])
})

// Docs: VORTEX_v5.1.md section 2.4
test('a profile cannot be changed after its namespace is computed', () => {
  const dims = [8, 4, 2]
  const thresholds = { 8: 0.9, 4: 0.9, 2: 0.9 }
  const made = makeProfile({ ...base, dims, thresholds })
  // The caller's own arrays are copied, so changing them afterwards changes nothing.
  dims.push(1)
  thresholds[8] = 0
  assert.deepEqual(made.dims, [8, 4, 2])
  assert.equal(made.thresholds[8], 0.9)
  const loose = made as { revision: string, prompt: string, dims: number[], thresholds: Record<number, number> }
  assert.throws(() => { loose.revision = 'r2' }, TypeError)
  assert.throws(() => { loose.prompt = 'other: ' }, TypeError)
  assert.throws(() => { loose.dims.push(1) }, TypeError)
  assert.throws(() => { loose.dims[0] = 16 }, TypeError)
  assert.throws(() => { loose.thresholds[8] = 0 }, TypeError)
  assert.equal(Object.isFrozen(GEMMA_PROFILE) && Object.isFrozen(GEMMA_PROFILE.dims) && Object.isFrozen(GEMMA_PROFILE.thresholds), true)
})
