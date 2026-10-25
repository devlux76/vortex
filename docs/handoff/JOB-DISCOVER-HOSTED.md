# Hosted conferences in discovery

Written by Codex. This is queue item 2 after conference wiring (`0b80365`). Implement one bounded job in an isolated branch from current main; verify and commit, then stop for review. Do not contact unavailable agents, run the embedding model, deploy, restart units or push.

Goal: a third agent finds and joins an existing conference even after the interest that formed it has expired or been withdrawn. The topic remains the original statement vector. Authority: VORTEX_v5.1.md sections 5.2, 6.1, 6.3, 10.6 and 11.2. Explicit creation, admission policies, topic revision and subscriptions are separate jobs.

## Files and interfaces

Allowed: `proto/discovery.proto`, its generated `src/core/proto/discovery.ts`, `src/core/conferences.ts`, `src/core/discovery.ts`, `src/core/service.ts`, `src/core/conversations.ts`, their existing test files, `skills/vortex/SKILL.md`, `TODO.md`. Regenerate only the discovery protobuf with the existing toolchain; no new dependency. Keep browser-safe core and existing style; give new tests spec comments.

1. Add `bytes conference = 5` to `DiscoveryResult`; existing `record = 2` remains an encoded SignedAnnouncement. Each result must have exactly one nonempty field. The new field is an encoded SignedDescriptor; never pretend that it is an announcement. Old interest packets remain readable.
2. Add `Conferences.hostedRecords(): { descriptor: ConferenceDescriptor; bytes: Uint8Array }[]`. Sweep expired entries, return only locally hosted conferences, clone vectors and bytes, and disclose no roster, session keys, certificates or messages. Use the already signed descriptor bytes; no signing or inference in this getter.
3. Add `DiscoveryOptions.conferences?: () => { descriptor: ConferenceDescriptor; bytes: Uint8Array }[]`, supplied by service as `() => this.conferences?.hostedRecords() ?? []`. No runtime import of Conferences into Discovery.
4. Make `MatchFound` a discriminated union: its existing common interest/session/peer/addrs/tier/fullScore fields plus either `{ kind:'interest', record:Announcement }` or `{ kind:'conference', record:ConferenceDescriptor }`. Common private helpers choose vector (`vector` / `topicVector`) and expiry (`expiresAt(record)` / `record.expiresAt`). Consumers must narrow the union rather than invent announcement fields.

## Respond, verify, retain and join

Rank live local interests and hosted descriptors together by the existing tier/fullScore comparator. A hosted descriptor replaces the same-id interest candidate, so a formed room appears once. Share the existing maximum result count; do not add a second allowance. Match descriptors on their topic vector and namespace, exclude expired conferences, and emit no room membership before admission.

At the origin require exactly one record encoding, verify with openAnnouncement or openDescriptor, require authenticated sender to equal origin or host, require the local namespace, validate dial addresses, recompute tier and fullScore, and ignore responder scores. A bad result must not block valid siblings. Reuse existing per-interest/per-peer caps and lifetime/generation checks. Deduplicate by record kind + id, permitting a descriptor to replace a same-id interest match; do not emit duplicate callbacks for unchanged descriptors. Newer signed descriptor metadata may refresh the retained match without notifying for a new semantic match.

Service join uses the selected record's host/address and the caller's live local interest, exactly as now. Conference engine already joins an existing hosted id before looking for a formable interest. Preserve session scoping, cancellation and explicit-handle fixes from 0b80365. `matchesFor` adds `kind`; conference results expose only id/host/count/capacity/admission/expires, not topic vectors or roster. Durable match events keep `record` as the handle; optionally add a validated `recordKind` field to distinguish the record. Old snapshots without it must still load.

## Required RED→GREEN tests

- Proto interest packet remains readable; conference packet round-trips; neither/both payloads are ignored.
- Signed descriptors are accepted only from their host and for a known namespace; wrong signature, expiry, spoofed host, wrong address, incompatible vector and false claimed tier are refused. A valid sibling result survives an invalid one.
- Matching and unrelated hosted topics; descriptor and same-id interest count as one candidate; shared caps and ranking still hold.
- Descriptor verification spanning withdraw, expiry, stop or stop/start retains nothing. Membership is absent before join, and no participant list escapes discovery.
- With three real loopback services and the fake table embedder from service.test.ts, A announces, B matches and joins; A withdraws its original interest; C announces later, matches the signed descriptor and joins the SAME room. A and B each read C's arrival and post exactly once. Closing the host removes its discovery candidate.
- Unknown-session join remains refused; retained interest matches and legacy direct exchanges remain supported.

Concrete service acceptance flow, inside a test using the existing `pair()` helper plus a third fake-embedder service:

```ts
const first = await sa.announceStatement({ session: 'a', statement: 'base' })
await sleep(500)
await sb.announceStatement({ session: 'b', statement: 'exact' })
await sb.core().wait(undefined, 10000)
await sb.joinConference({ session: 'b', ref: first.id })
assert.equal(sa.withdrawInterest('a', first.id), true)
const third = await sc.announceStatement({ session: 'c', statement: 'tier8' })
await until(() => sc.matchesFor(third.id).some(m => m.record === first.id && m.kind === 'conference'))
const joined = await sc.joinConference({ session: 'c', ref: first.id })
assert.equal(joined.id, first.id)
assert.equal(joined.count, 3)
```

Create/start/dial sc as in the existing three-service test and stop all services in finally. Do not copy a test-only helper into production.

## Verification and report

Run focused tests for discovery, conferences, conversations and service; then `bun run typecheck`, `bun test ./src`, and `git diff --check`. Report exact counts, wire compatibility, decisions, and any unavoidable brief defect. Update B8 to distinguish completed hosted discovery from remaining topic revision or admission work; update the semantic skill to say a retained descriptor match can join the existing conference after the originating interest ends.
