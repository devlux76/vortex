# Semantic-match threshold calibration (v5 TODO H3)

Status: measurement and recommendation, Claude of the Clouds, 2026-11-12. This is input for the semantic-discovery layer that `v6/p2p` brings back. It isn't a spec amendment.

## Setup

- **Embedder.** The pinned reference profile: EmbeddingGemma 2 ONNX q4 at revision `daa72c51`, run on CPU through transformers.js. This is the model from `v6/tools/embed-probe.ts`; its vectors agree across machines to 1e-10 (#5).
- **Data.** `v6/tools/calibration/statements.json` holds 160 problem statements in 40 topics × 4 paraphrases. The topics sit in 10 families of 4 related-but-different problems. For example, the `webrtc` family contains NAT traversal, echo, data-channel ordering and simulcast bandwidth. That gives:
  - **240 related pairs** (same topic);
  - **960 hard negatives** (same family, different topic);
  - **11,520 easy negatives**.
- **Tool.** `bun v6/tools/embed-calibrate.ts [--prompt P] [--center] [--vectors file] [--out report.json]`. It reports the similarity distributions, the provisional thresholds, the F1-best threshold, the lowest threshold that reaches 99% precision, and a two-fold held-out F1 in which thresholds are chosen on half the families and scored on the other half.
- **Raw report.** `v6/tools/calibration/report-clustering-768.json` holds the default prompt, uncentered.

## Results (prompt `task: clustering | query: `, no centering)

| Dims | Related median / p05 | Hard-neg median / p99 | Easy-neg median | Provisional (precision / recall) | F1-best threshold → P / R / F1 | 99%-precision threshold → recall | Held-out F1 |
|---|---|---|---|---|---|---|---|
| 768 | 0.872 / 0.819 | 0.805 / 0.877 | 0.764 | 0.80 → **0.107** / 0.988 | 0.863 → 0.76 / 0.64 / 0.69 | 0.900 → 0.19 | 0.71, 0.67 |
| 512 | 0.875 / 0.822 | 0.809 / 0.879 | 0.766 | 0.80 → 0.098 / 0.992 | 0.860 → 0.70 / 0.69 / 0.69 | 0.901 → 0.20 | 0.74, 0.68 |
| 256 | 0.884 / 0.828 | 0.819 / 0.888 | 0.779 | 0.82 → 0.128 / 0.975 | 0.872 → 0.72 / 0.63 / 0.67 | 0.906 → 0.25 | 0.69, 0.65 |
| 128 | 0.923 / 0.885 | 0.879 / 0.931 | 0.854 | 0.85 → 0.031 / 0.996 | 0.921 → 0.71 / 0.54 / 0.62 | 0.944 → 0.15 | 0.66, 0.63 |

Variants I tried:
- **Mean-centering** (with the mean taken from the training fold for the held-out score): best F1 0.72 at 768 dimensions, but held-out 0.58–0.69.
- **`task: sentence similarity` prompt:** best F1 0.68–0.70, held-out 0.66–0.77.
- **`task: classification` prompt:** best F1 0.67, held-out 0.63–0.70.

None of these changes the picture.

## Findings

1. **The provisional thresholds are far too low.** At 0.80 and 768 dimensions, about 9 in 10 matches are false, with precision 0.107. The vectors sit in a narrow cone: even unrelated pairs from different families have a median similarity of 0.76.
2. **No single cosine threshold separates "same problem" from "same domain, different problem".** Hard negatives overlap the related pairs: their p99 of 0.877 lies above the related median of 0.872. The best achievable F1 is about 0.7, and 99% precision costs 75–85% of recall. That holds across prompts, centering and Matryoshka lengths.
3. **Shorter prefixes are worse.** At 128 dimensions the classes overlap the most. Don't cut announcements to 128 dimensions to save bandwidth.

## Recommendation for semantic discovery

- **Use similarity for ranking, not for deciding.** Discovery returns the top-k candidates above a recall-oriented floor (at 768 dimensions with the clustering prompt, **0.82** keeps 95% of related pairs at about 4 candidates per true match, and 0.83 keeps 90% at about 3). It doesn't return a yes/no match.
- **Confirm before forming a conference.** The plain-text statements of the top candidates, which the receiver can read anyway (A7 notes that embeddings disclose their source text), are checked by a cheap model or by the agent itself before it joins. Embeddings give recall; that check gives precision.
- **Don't pin a threshold in the protocol.** Matching thresholds stay local policy, as v5.1 already said ("Thresholds… are local and not part of the agreement"), and are tuned per deployment with this tool.

## Limitations

- **One author.** All 160 statements were written by one model in a fairly uniform style. Real announcements from different agents will vary more, which probably lowers related-pair similarity and makes the overlap worse, not better.
- **English only, software topics only.**
- **Small set.** With 40 topics the held-out numbers swing by ±0.05. A larger, multi-author set (for example, statements collected from real agent sessions) should replace this one before thresholds go anywhere near a default.
