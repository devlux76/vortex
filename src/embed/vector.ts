import type { EmbeddingProfile } from '../types.ts'

/**
 * Cosine similarity over the first `length` components (Section 5.1). A
 * prefix of a unit vector is not a unit vector, so the norms are taken over
 * the prefix.
 */
export function similarity (u: Float32Array, v: Float32Array, length: number): number {
  if (!Number.isInteger(length) || length <= 0) throw new Error('length must be a positive integer')
  if (u.length < length || v.length < length) throw new Error(`vector is shorter than ${length}`)
  let dot = 0
  let normU = 0
  let normV = 0
  for (let i = 0; i < length; i++) {
    dot += u[i] * v[i]
    normU += u[i] * u[i]
    normV += v[i] * v[i]
  }
  if (normU === 0 || normV === 0) throw new Error('vector has zero norm over the compared prefix')
  // Rounding can carry the quotient a hair past 1.
  return Math.max(-1, Math.min(1, dot / Math.sqrt(normU * normV)))
}

/**
 * True if a vector is a usable embedding under a profile: the full length,
 * every component finite, and a non-zero norm over every supported prefix.
 * Check before scoring anything received.
 */
export function isValidVector (vector: Float32Array, profile: EmbeddingProfile): boolean {
  if (vector.length !== profile.dims[0]) return false
  const shortest = profile.dims[profile.dims.length - 1]
  let nonZero = false
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return false
    if (i < shortest && vector[i] !== 0) nonZero = true
  }
  return nonZero
}

/** The bytes of a vector as published: float32, little-endian, as the model emitted it. */
export function encodeVector (vector: Float32Array): Uint8Array {
  const out = new Uint8Array(vector.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < vector.length; i++) view.setFloat32(i * 4, vector[i], true)
  return out
}

/** Read a published vector. Throws unless it is a valid vector under the profile. */
export function decodeVector (bytes: Uint8Array, profile: EmbeddingProfile): Float32Array {
  const full = profile.dims[0]
  if (bytes.length !== full * 4) throw new Error(`vector must be ${full * 4} bytes, got ${bytes.length}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(full)
  for (let i = 0; i < full; i++) out[i] = view.getFloat32(i * 4, true)
  if (!isValidVector(out, profile)) throw new Error('vector has a non-finite component or zero norm')
  return out
}
