/**
 * Browser-safe topic routing (VORTEX_v5.1.md §§4–5). An unlabelled direct
 * message is matched against the receiver's own conferences by the same
 * cascade as discovery. The best match names the conference whose agent
 * thread should handle it; routing is not membership, so the message stays a
 * room message for transport and replies.
 */
import type { EmbeddingProfile } from '../types.ts';
import { compareCandidates, matchTier, resolveThresholds } from '../embed/match.ts';
import { isValidVector, similarity } from '../embed/vector.ts';

export type RoutableConference = { id: string; descriptor: { namespace: string; topicVector: Float32Array } };
export type Routing = { conference: string; tier: 'exact' | number; score: number; fullScore: number };

/** The best-matching conference in the profile's namespace, or null below every threshold. */
export function routeToConference (vector: Float32Array, conferences: readonly RoutableConference[],
  profile: EmbeddingProfile, thresholds?: Record<number, number>): Routing | null {
  if (!isValidVector(vector, profile)) return null;
  const local = resolveThresholds(profile, thresholds);
  let best: (Routing & { rank: { tier: { tier: 'exact' | number; score: number }; fullScore: number } }) | null = null;
  for (const conference of conferences) {
    const topic = conference.descriptor.topicVector;
    if (conference.descriptor.namespace !== profile.id || !(topic instanceof Float32Array) || !isValidVector(topic, profile)) continue;
    const tier = matchTier(vector, topic, profile, local);
    if (tier === null) continue;
    const rank = { tier, fullScore: similarity(vector, topic, profile.dims[0]) };
    if (best === null || compareCandidates(rank, best.rank) < 0)
      best = { conference: conference.id, tier: tier.tier, score: tier.score, fullScore: rank.fullScore, rank };
  }
  if (best === null) return null;
  const { rank: _rank, ...routing } = best;
  return routing;
}

/**
 * Routing is stricter than discovery. A direct message shares more with any
 * topic than two problem statements do (sender lines, sign-offs), and a wrong
 * route puts mail in another topic's thread, so each threshold is raised by
 * this margin. Provisional, like the profile thresholds (TODO H3): measured on
 * the shared GGUF embedder, unrelated mail with a common sender line scored
 * 0.80-0.86 against a topic and a related follow-up 0.87 or more.
 */
export const ROUTING_MARGIN = 0.05;

/** The thresholds routing uses: the discovery thresholds raised by ROUTING_MARGIN, capped at 1. */
export function routingThresholds (profile: EmbeddingProfile, discovery?: Record<number, number>): Record<number, number> {
  const base = resolveThresholds(profile, discovery);
  return Object.fromEntries(profile.dims.map(length => [length, Math.min(1, base[length] + ROUTING_MARGIN)]));
}
