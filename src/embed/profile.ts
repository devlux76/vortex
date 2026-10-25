import { sha256 } from '@noble/hashes/sha2.js'
import type { EmbeddingProfile } from '../types.ts'

type Hashed = Pick<EmbeddingProfile,
'model' | 'revision' | 'weights' | 'prompt' | 'maxTokens' | 'truncation' | 'pooling' | 'normalization' | 'dims' | 'encoding'>

/**
 * Build a profile. Its `id` is the hash of everything that affects the vector
 * (Section 2.4), so changing any of those fields gives another namespace.
 * `version`, `tolerance` and `thresholds` do not affect the vector and are
 * left out of the hash: services in one namespace may differ in them.
 */
export function makeProfile (fields: Omit<EmbeddingProfile, 'id'>): EmbeddingProfile {
  const { dims, thresholds, tolerance, version } = fields
  if (dims.length === 0 || dims.some(length => !Number.isInteger(length) || length <= 0)) {
    throw new Error('profile needs at least one positive integer length')
  }
  if (dims.some((length, i) => i > 0 && length >= dims[i - 1])) throw new Error('profile lengths must be strictly decreasing')
  if (!Number.isInteger(version) || version < 1) throw new Error('profile version must be a positive integer')
  if (!(tolerance >= 0 && tolerance < 1)) throw new Error('profile tolerance must be in [0, 1)')
  if (fields.revision === '') throw new Error('profile needs an exact revision')
  checkThresholds(thresholds, dims)
  const hashed: Hashed = {
    model: fields.model,
    revision: fields.revision,
    weights: fields.weights,
    prompt: fields.prompt,
    maxTokens: fields.maxTokens,
    truncation: fields.truncation,
    pooling: fields.pooling,
    normalization: fields.normalization,
    dims,
    encoding: fields.encoding
  }
  const canonical = JSON.stringify(Object.keys(hashed).sort().map(key => [key, hashed[key as keyof Hashed]]))
  const digest = sha256(new TextEncoder().encode(canonical))
  const id = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  // Frozen, copies included: a profile that could change after hashing would
  // keep its namespace while describing other vectors.
  return Object.freeze({ id, ...fields, dims: Object.freeze([...dims]) as number[], thresholds: Object.freeze({ ...thresholds }) })
}

/** Throws unless there is exactly one threshold in [-1, 1] for each length. */
export function checkThresholds (thresholds: Record<number, number>, dims: number[]): void {
  for (const length of dims) {
    const value = thresholds[length]
    if (typeof value !== 'number' || !(value >= -1 && value <= 1)) throw new Error(`threshold for length ${length} must be in [-1, 1]`)
  }
  for (const key of Object.keys(thresholds)) {
    if (!dims.includes(Number(key))) throw new Error(`threshold given for unsupported length ${key}`)
  }
}
