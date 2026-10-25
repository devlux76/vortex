import type { EmbeddingProfile, Tier } from '../types.ts'
import { checkThresholds } from './profile.ts'
import { isValidVector, similarity } from './vector.ts'

/**
 * A service's thresholds: the profile's recommended defaults, with any the
 * operator set in their place. Thresholds are local policy and services in a
 * namespace need not agree (Section 5.2).
 */
export function resolveThresholds (profile: EmbeddingProfile, local: Record<number, number> = {}): Record<number, number> {
  const thresholds = { ...profile.thresholds, ...local }
  checkThresholds(thresholds, profile.dims)
  return thresholds
}

/**
 * The cascade of Section 5.2: exact within the profile's tolerance, then the
 * full length, then each shorter supported prefix, longest first. Returns the
 * first step that matches with the score at that step, or null if none does.
 * Both vectors must be valid under the profile.
 */
export function matchTier (
  u: Float32Array,
  v: Float32Array,
  profile: EmbeddingProfile,
  thresholds: Record<number, number> = profile.thresholds
): Tier | null {
  if (!isValidVector(u, profile) || !isValidVector(v, profile)) throw new Error('vector is not valid under the profile')
  const full = similarity(u, v, profile.dims[0])
  if (full >= 1 - profile.tolerance) return { tier: 'exact', score: full }
  for (const length of profile.dims) {
    const threshold = thresholds[length]
    if (threshold === undefined) throw new Error(`no threshold for length ${length}`)
    const score = length === profile.dims[0] ? full : similarity(u, v, length)
    if (score >= threshold) return { tier: length, score }
  }
  return null
}

/**
 * Order of tiers alone: closest first, 'exact' before the full length before
 * each shorter prefix. Negative when `a` comes first, zero for the same tier.
 * It does not look at `score`, which is taken at different lengths in
 * different tiers and so does not rank candidates.
 */
export function compareTiers (a: Tier, b: Tier): number {
  const width = (tier: Tier): number => tier.tier === 'exact' ? Number.MAX_SAFE_INTEGER : tier.tier
  return width(b) - width(a)
}

/** What a candidate is ranked by. `fullScore` is the similarity at the profile's full length. */
export interface Ranked {
  tier: Tier
  fullScore: number
}

/**
 * Order for candidate lists (Sections 5.3 and 11.2): by tier, closest first,
 * then by similarity at full resolution. Negative when `a` comes first.
 */
export function compareCandidates (a: Ranked, b: Ranked): number {
  return compareTiers(a.tier, b.tier) || b.fullScore - a.fullScore
}
