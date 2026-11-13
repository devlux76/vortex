// #16: the matching rule from the H3 calibration (docs/v6-calibration-h3.md).
// Cosine similarity is for RANKING, not deciding: keep the candidates above a
// recall-oriented floor (0.82 at 768 dimensions with the clustering prompt —
// 0.80 is far too low, precision 0.107; 0.82 keeps 95% of related pairs at
// about 4 candidates per true match), rank them, and let a plain-text
// confirmation pick among them. A hard same-domain decoy scores close to the
// target, so the confirmation — not the margin — is what separates them.
// Pure and dependency-free, so it is unit-testable and bundles for the
// browser (Moon) unchanged.

export const MATCH_FLOOR = 0.82

export interface Candidate { name: string, score: number, topic: string }

export interface Selection {
  /** Surviving candidates above the floor, best score first. */
  ranked: Candidate[]
  /** The selected namespace. */
  channel: string
  floor: number
  /** The 1-based pick the plain-text confirmation made, when given. */
  confirmedPick?: number
}

export function selectChannel (candidates: Candidate[], discovered: string[], confirmedPick?: number): Selection {
  const ranked = candidates
    .filter(candidate => discovered.includes(candidate.name) && candidate.score >= MATCH_FLOOR)
    .sort((a, b) => b.score - a.score)
  if (ranked.length === 0) throw new Error('no rendezvous namespace above the 0.82 floor')
  // The confirmation is authoritative when it names a surviving candidate;
  // otherwise the best score stands and the miss is visible in the transcript.
  const chosen = confirmedPick !== undefined && ranked[confirmedPick - 1] !== undefined
    ? ranked[confirmedPick - 1]!
    : ranked[0]!
  return { ranked, channel: chosen.name, floor: MATCH_FLOOR, confirmedPick }
}
