# VORTEX delivery progress

Plan: docs/handoff/DELIVERY-PLAN.md. Goal: deliver the remainder, serially, with
bounded subagent review and honest acceptance evidence. Resume from this ledger;
do not redo completed milestones after compaction.

## Verified before this plan

- B6 discovery expiry/lifecycle and C6 explicit leave/rediscover/rejoin completed.
- C3 explicit creation, open/invitation/group admission and MCP create completed.
- Independent reviewer findings fixed: interrupted announcement/session rollback,
  preserved match rollback, phantom admission membership, peer-ID normalization.
- Latest verification: 320 Bun tests, 75 ExUnit tests, typecheck and diff check pass.
- These changes are in the working tree on plan creation; checkpoint before more
  product changes so later reviews can target their exact commit range.

## Current work

C7b authenticated bounded history implemented and verified: 336 Bun tests,
75 ExUnit tests, typecheck and whitespace checks passed. Core history tests pass, CLI/API/MCP checks pass, and reviewer P2 (empty
page contradicting retained-message metadata) reproduced RED then fixed GREEN.
Checkpoint af93a5f contains C7b. Review finding fixed by a regression; no
re-review needed. C8 is now in progress.

C8 first bounded implementation delegated serially to the free OpenCode provider
through the local delegate-to-opencode skill helper.
RUN 89aa725efda5460d801485927a1dd3c6; brief /tmp/vortex-c8-membership-brief.md;
exact baseline copies /tmp/vortex-c8-member-backup-qx6h5mj4. Only four core
membership/record source/test files may change. Keep supervising the run until
completion or confirmed stop; independently verify all changes. Root owns a
loopback OpenCode server started in exec session 28034, port 4096. Do not stop
unrelated servers or sessions. The delegated run completed within budget, with no pending requests or scope
expansion. It reported 67 focused passing tests and typecheck/diff checks. Root
inspected the whole scoped diff and independently found an inconsistent private
key/public-half case; regression failed RED and a signing probe now rejects it.
Root verification: 69 focused tests and 343 full Bun tests passed; typecheck and
whitespace checks passed. Reviewer found local-session ownership overwrite;
regression failed RED, resume now rejects an already-joined room before sending.
The normal join path remains unchanged. Private membership prerequisite is checkpointed as fa04894 and does not complete C8. Subsequent store,
replay and service slices remain in DELIVERY-PLAN.md.

Checkpoint 06c4d8f: prior B6/C6/C3 work and delivery plan saved. Fresh checkpoint
checks: 107 focused Bun tests, typecheck and whitespace checks passed; previous
full baseline 320 Bun / 75 ExUnit. No installed service changed.

## Rulings

- Continue in the existing sole-agent checkout, on a new local delivery branch,
  preserving all prior changes. A second checkout would duplicate the user's
  ongoing uncommitted work and is unnecessary for serial implementation.
- History cursor is a host sequence, exposed as historyCursor. It is not a local
  inbox acknowledgment cursor. Direct history reads return verified pages; later
  subscriptions replay pages through the durable queue with message deduplication.
- Host history is ephemeral but bounded by count and bytes. The spec makes host
  persistence optional; subscriptions and the owner inbox require durability.

## External acceptance still outstanding

No deployed owner services changed. H1 requires independent coding agents;
mocked services and code-review subagents are not that evidence. Operator-defined
release/network/accounting policies and browser runtime measurements remain
explicit prerequisites where the plan names them.

## Resumed serial delegation

Subscription store RUN e0270e267ebf4a49bf3a7e8b32dd687d completed. Root inspected
the scoped diff and verified 46 store tests, typecheck and whitespace checks.
Independent review found caller mutation bypassing queued event validation and
unsubscribe skipping queued subscription creation. Root reproduced both; fixes
remain required before checkpoint.

Service lifecycle RUN 3bc7ac73e183476c833bd555aa60e593 is active in the same free
OpenCode session. Scope is service source/tests only: member-gated subscription,
operator count/lifetime bounds, expiry/leave and durable stop. Exact pre-run copies
are recorded outside the repository in the temporary service backup path file.
History recovery and CLI/MCP remain separate subsequent slices.

Store review corrections RUN 9d634c8078d3461681a79db44bcb039c completed. Root
verified 49 store tests: input events/pages are captured before queueing, removal
observes queued creation, and blocked saves keep subscription state invisible.
Service lifecycle RUN 3bc7ac73e183476c833bd555aa60e593 completed and root verified
28 service tests. Review found stale expiry deleting renewal, post-stop scheduling,
lost close retry and abandoned orphan-host retry. Corrections are delegated in
RUN 1f3c1bf1219940e5995531fdc47132ff, with exact four-file baseline backup outside
the repository. These slices remain uncheckpointed pending those corrections.

## Verified C8 store and lifecycle milestone

Final correction RUN c118053f2fb247f9a4265dc8e1348c0e completed after the prior
run reached its wall-clock deadline and stopped. Root read the scoped diffs.
Store captures events before queueing, observes queued creation on removal, and
conditionally removes captured incarnations. Service bounds count/lifetime, keeps
private member keys in owner snapshots, preserves subscriptions on stop, clips
expiry to the room, and removes closed/expired/orphan-host subscriptions durably.
Cleanup retries survive save failure and unrelated scheduling with one timer.
Queued renewals survive stale expiry; stale leave continuations cannot affect
a restarted service. Subscribe spanning close rejects and cleans up.

Reviewer confirmed the final stop/restart and backoff corrections, independently
running both regressions. Root final verification: 371 Bun tests / 0 failures,
75 ExUnit tests / 0 failures, typecheck and whitespace checks passed. No installed
service changed. C8 remains unchecked: automatic membership/history recovery and
CLI/API/MCP bindings are the next required slices.

Checkpoint 851e17d contains the verified C8 store/lifecycle milestone. Recovery
RUN 79a61e863beb409d8af2b102a0da5827 is now active in the same free OpenCode
session, bounded to service/store source and tests. Brief is in temporary recovery
brief file; exact four-file backup path is recorded outside the repository.
Scope: restart/reconnect membership recovery, bounded retries/cancellation and
verified history replay into the atomic durable queue. Tools remain subsequent.

Recovery initial run reached its 10-minute wall-clock deadline and stopped during
final checks. Root inspected source/tests and ran typecheck/whitespace successfully;
93 focused tests yielded 92 pass / 1 fail (old orphan-cleanup error-order assertion
now sees concurrent recovery errors). Review found cancellation preceding ownership/
persistence, reconnect bypassing backoff, and replay using a refreshed rather than
requested cursor. Corrections plus real pending-resume/reconnect tests are active
in RUN a58002792e5048cc83fa7fcb7597353b, limited to service source/tests. No C8
recovery completion claim or checkpoint until independent checks pass.

## Power/network interruption audit, 2026-10-13

HEAD remains 851e17d on codex/complete-vortex. Recovery corrections a580... and
8cd42f9186244fd18608cc57a8d958e6 stopped at their wall-clock budgets; no live
delegate remained. Existing loopback OpenCode 1.18.35 on port4096 is healthy
and reused, no restart or installed-service changes. Root read uncommitted
service/store diffs and ran focused suite: 98 pass / 1 fail (held resume reply
aborted by stop times out). Typecheck and whitespace passed. Review identified
further verification/cancellation, reconnect roster and renewal races; review
reproductions are underway, no recovery completion claim.

Owner-tool bindings RUN1de721a2a58a4176ae40ca62d39eacf6 active serially in
ses_ecd36d43cffezdEpb7pSFuKAY0. Scope CLI/MCP source/tests and README only.
Brief /tmp/vortex-c8-tools-brief.md; exact backup path is recorded in
/tmp/vortex-c8-tools-backup-path. Core is unchanged during this delegation.

Tools RUN1de721... completed within budget. Root read the full five-file diff
and independently ran binding tests (13 pass/0fail), typecheck and whitespace.
No core changes in that run. Recovery review confirmed cancellation during
engine validation before pending reservation, stale cached expiry undoing renewal,
and reconnect failing to refresh roster. Follow-up correction scope extends
to Conferences source/tests plus service source/tests. Exact four-file backup
recorded in /tmp/vortex-c8-final-recovery-backup-path.

Correction RUN558013... intentionally aborted with confirmation after source
inspection found duplicated join-reply validation for roster refresh. Root
requested reuse of the existing pending/join validation path. Final acceptance
also requires authenticated unknown-room cleanup and fresh-instance restart
from exported identity plus serialized owner snapshot. Same four-file scope
and exact backup apply; no completion claim.

RUNd7cb... reached its 15-minute deadline and stopped with code and three
engine tests, but service acceptance incomplete. Root corrected test assertion
for invalid session key, reproduced seat-release and unknown-refresh ghost
findings RED, fixed both GREEN, and consolidated duplicated service recovery
branches. Four engine regressions passed; separate old-source overlay produced
2 failures for abort/refresh, confirming regression sensitivity. Typecheck and
whitespace passed. Late-reply stop test still hangs during host teardown; root
is isolating shutdown in a temporary overlay, no production claim. Remaining
service acceptance delegated test-only into initially absent
src/core/subscription-recovery.test.ts; source/existingtests remain root-owned.

## Verified C8 completion, 2026-10-13

Checkpoint d986165 contains complete C8 recovery and owner tools. Final source
review has no remaining findings. Root reproduced and fixed sent-resume seat
release and unknown-refresh ghost membership; tested a fresh third instance
forcing acknowledged history replay and awaited its durable cursor. Original
unknown-join refusal text is preserved while a typed internal error drives
definitive cleanup. Root full final checks: 396 Bun tests / 0 failures, 75 ExUnit
/ 0 failures, typecheck and whitespace clean. Clean frozen-lockfile installation
reapplies the versioned @libp2p/tcp11.0.28 patch. It destroys undestroyed sockets
even when Bun marks them non-readable, fixing the demonstrated shutdown hang.
No installed units, owner services or model wakes changed. External gates remain.

OpenCode is healthy and reused without restart. All C8 runs stopped/completed
with confirmation; test-only RUN3dd62... intentionally stopped after five tests
passed and freshrestart hit the known TCP hang. Root finished test cleanup,
stronger restart evidence and dependency patch. No delegate remains active.
Next C1 design approved by owner: include CLI/API and MCP revision operation.
Core/wire brief /tmp/vortex-c1-core-brief.md; checkpoint before dispatch.

C1 core RUN024becce32fa46d8a7491379b59a8465 active in the existing free session.
Six-file scope: conference proto/generated output plus conference/service core
and tests. Exact baseline /tmp/vortex-c1-core-backup-o0y3rq6_ (path also in
/tmp/vortex-c1-core-backup-path). Owner-approved bindings remain a separate next
slice. Root baseline is 396 Bun / 75 ExUnit, typecheck/diff and fresh patch install
verified. No installed service or model wake changes permitted.

Power-loss recovery copies and briefs also saved durably at
~/.local/state/codex-opencode/backups/vortex-c1-024becce/;
use these if temporary files disappear across reboot. C8 baseline commits are
d986165/be101ad. OpenCode run JSON preserves its task and session too.

C1 core RUN024becce... completed within budget. Root read scopedsource/proto
and tests. Review reproduced fanout continuing after stop/leave and optional
revision source preserving stale text beside a new vector. Both regressions
failed RED then passed GREEN after root fixes; source now required on revision
and generation/host identity checked through fanout/return. Formable source
remains optional only for existing vector-only creation callers. Root briefly
reverted preexisting discovery snapshot copies by mistake; fullcoretest caught
it and exact baseline copying restored, no final diff there. Root checks:
64 conference tests / 0 failures, 48 service tests / 0 failures, typecheck and
whitespace clean. Re-review found no remaining correction defects. Core uncommitted
pending full C1 bindings/suite. Bindings scope only CLI/MCP source/tests andREADME;
durable backup ~/.local/state/codex-opencode/backups/vortex-c1-bindings/.

## Verified C1 completion

Bindings RUN6b6918b82b704ac7beb86c0f0ac88fa2 completed within budget; root
inspected all five files and review found no binding defects. Includes CLI/API
revise and MCP vortex_revise, with host ownership/policy/byte validation through
service, unchanged lifetime/membership and kept source privacy. Root added an
actual valid newer foreign-room descriptor regression to the existing negative
test, then ran full suite: 410 Bun / 0 failures; typecheck and whitespace clean.
Latest ExUnit baseline remains 75/0 (no Elixir changes in C1).
Checkpoint 3c307b0 contains C1. All delegated runs are complete or confirmed
stopped; no OpenCode task remains active. No installed unit/service/model wake
changed. Server was healthy and reused without restart.

User asked about a progress gap during bindings: root had failed to send updates
promptly. Live inspection showed the worker running its CLI/MCP checks, not
stalled. Resume from these checkpoints; do not repeat C8/C1 implementation.
Next ready work is C9 private peer memory design, then remaining delivery queue.

Owner approved C9 original-query default (host current topic) with explicit
subject override, private expiring certified-participant feedback and leave
bindings. Storage first; service/subject/provenance/bindings remain subsequent.
Durable store backup and brief at
~/.local/state/codex-opencode/backups/vortex-c9-store/; new peer-memory helper
source/tests initially absent. Baseline clean86b6ff6, 410Bun/75ExUnit.

C9 storage RUNf54300594c5e4dd49c271c8647c50c82 active in the existing free
session. Recovery inspection confirms baseline commits and only expected
ledger edits plus new storage tests; implementation and verification pending.

C9 storage RUNf5430059... completed. Root reproduced malformed restored-null
lookup/maintenance crashes, added RED regressions and filtered invalid cache
records on restoration plus guarded standalone lookup. Added exact byte-bound
accept/reject/eviction coverage. Focused70/0, full426Bun/0, typecheck/diff clean;
read-only re-review found no remaining issue. ExUnit75/0 remains unchanged.
Private store is verified; C9 feedback, retention and bindings remain pending.

Storage checkpoint8214743. C9 subject/provenance RUN3ca9e3ed504d4020a9ebf5443a5d9db3
active, same free session; eight-core-file scope, no wire/binding/feedback changes.
Durable exact backup/brief ~/.local/state/codex-opencode/backups/vortex-c9-subject/.
Next after verification: feedback service + expiry/preferences, then bindings.

## Delivery resumed after usage interruption, 2026-10-13

RUN3ca9... stopped with confirmed wall-clock budget, leaving the subject/provenance
slice uncheckpointed. Existing loopback server healthy and reused. Root inspected
the full eight-file source/test diff and independently ran 191 focused Bun tests
with 0 failures, typecheck and whitespace clean. Remaining gaps: certified host
roster access and actual fresh-instance membership/source recovery acceptance.
Continuation RUNa07a72f6bef84fa9803c32b705e270e7 supervises the same free session
with a ten-minute bound and the same eight-file scope. Exact resumed baseline
copies and brief: ~/.local/state/codex-opencode/backups/vortex-c9-resume/.
No installed service, dependency, model wake or network-facing field changed.

## Verified C9 subject/provenance milestone

Continuation RUNa07a... completed. Root read the final eight-file diff and
independently verified full Bun suite: 438 pass/0 fail; typecheck and whitespace
clean. Real fresh-instance recovery from serialized snapshot and exported identity
retains original query despite offline host revision and authenticated history
replay. Host and participant certified roster access is session-gated; source is
absent from public projections and conference packets. Legacy memberships remain
compatible; original source survives renewal and refresh, save failure is atomic.
C9 remains incomplete: leave/unsubscribe feedback, service expiry/preferences and
CLI/API/MCP bindings are next. ExUnit baseline75/0 unchanged (no Elixir edits).

Checkpoint2af2d09 contains verified subject/provenance. Feedback/expiry/preferences
RUNd054ab6a6ed14c86bd1f7eccbcd11ea5 active in same free OpenCode session, bounded
to service.ts/service.test.ts for15minutes. Exact baseline copies/brief durably
saved at ~/.local/state/codex-opencode/backups/vortex-c9-feedback/. No bindings
or deployment changes in this run. Supervise before any continuation; independent
verification still required.

Feedback RUNd054... stopped confirmed on15minute budget. Source/tests remain
uncheckpointed. Root read whole source diff and reproduced two RED review tests
in isolated /tmp/vortex-feedback-review-overlay: queued subscribe/unsubscribe
ordering regressed; wrong-dimensional override vector accepted. Additional
review issues: first100-only departed proof, configured batch bound before
embedding, expiry scheduling on early return, captured subscription incarnation
and restored memory bounds. Correction brief and exact partial copies durably
saved in ~/.local/state/codex-opencode/backups/vortex-c9-feedback-review/.
No feedback completion claim until independent regressions and suite pass.

Correction RUN40ad66fb527046daa63ea112574b303a active, same free session and
two-service-file scope,15minute bound. Root-owned independent RED overlay tests
are provided for regression reuse. Resume via delegate helper, not a fresh model
or cold session.

Correction RUN40ad... intentionally stopped with confirmed abort after root
independent review. First2 overlay regressions are GREEN. Root next maintenance
probe gives1pass/1fail: normal expiry save retry works, reduced bounds retry
waits until distant record expiry. Root also identified a new acceptance test
blocking embedding during announcement setup and a stale embedding-counter
assertion. Final RUN2405654162fd469c9fa97207db2fed28 active, same session, two
service files,12minute bound. Exact partial copies and narrow brief durably
saved at ~/.local/state/codex-opencode/backups/vortex-c9-final-feedback/.
Also address committed feedback expiry on early unsubscribe and service threshold
lookup. Bindings remain queued; no service feedback checkpoint/completion yet.

## Verified C9 feedback/expiry/preference milestone

Final RUN240565... stopped confirmed on12minute budget after60service tests
passed. Root read source/tests and added quiescent recovery to a final expiry
probe: unsubscribe feedback committed during engine leave missed its timer.
Root regression RED then minimal scheduling correction GREEN; independent
maintenance tests (normal expiry and failed restored-bound save retry) and
positive private override coverage passed. Root full final checks:451Bun/0fail,
typecheck and whitespace clean. Includes all new regressions.
Feedback verifies current roster or complete bounded verified events, captures
inputs, rejects malformed/self/unproved participants before inference, atomically
saves outcomes plus subscription removal before leave. Original query/current
host topic defaults, explicit private override, configured TTL/count/bytes,
durable maintenance retry, and subject-scoped ordering over admitted matches
are implemented. Renewed subscriptions survive guarded removal races. Stats
expose count/bytes only. No installed services/models/wire changed.
C9 remains unchecked until owner CLI/API/MCP feedback/settings bindings finish.

Checkpointecf034d contains verified feedback/expiry/preferences. Owner bindings
RUNacfb71149ad54c71986bd728f7ab72cd active, same free session, five-file scope
CLI/MCP source/tests plusREADME,10minute bound. Exact baseline and brief durably
saved at ~/.local/state/codex-opencode/backups/vortex-c9-bindings/. Core remains
unchanged during run. Root will independently verify bindings before C9 check.

---

The rest of the progress log is in this part:

- [Part 2: from "Quota-safe delivery handoff, 2026-10-13" to the end](DELIVERY-PROGRESS-part2.md)
