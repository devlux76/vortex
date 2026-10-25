# ISSUES

Current work: the Elixir/OTP signalling and alerting backbone and the Codex, Claude, and OpenCode integrations. the operator clarified on 2026-10-09 that replacing the existing polling wake prototype is what is meant by fixing the backbone. Broader protocol implementation belongs in `TODO.md`.

Codex performed the initial code review against `VORTEX_v5.1.md` personally. Baseline: 55 tests pass; `bun run typecheck` passes. Passing tests do not cover the failures below. Findings describe the reviewed prototype; replacing that path can resolve a finding if the replacement passes its acceptance tests.

## Review defects to resolve first

### I1 — P1: Consent can survive a failed durable save

<!-- Tests: src/core/conversations.test.ts — failed invite and accept saves restore consent and send nothing, then allow retry. -->

- [x] Fixed in `aad63b1`; rollback/retry regression passes and Claude reviewed the change.

`src/core/conversations.ts`, `invite()` and `accept()`, mutate local consent before saving without restoring it if the save throws. A disk-full failure reports that the operation failed, but the live process still considers consent granted; restart loses that consent. Received messages and acknowledgments already roll back correctly. Spec §9.3 separates durable storage from notification and processing; §10.3 requires explicit admission.

Reproduction: inject `save: () => { throw Error('disk full') }`; both a rejected `invite()` and rejected `accept()` leave `localConsent: true`.

Acceptance: failed save restores the exact prior room state and sends no packet; successful retry persists before sending. Cover both a new invitation and an existing received invitation.

### I2 — P1: Valid message bodies exceed the encoded transport limit

<!-- Tests: src/cli.test.ts — local API waits for delivery, persists ack, and runs one local wake adapter (maximum plain, Unicode, quote/backslash and control-character bodies). -->

- [x] Fixed in `701bbbe`; real HTTP/direct-stream regression covers maximum plain, Unicode, quote/backslash and control-character bodies.

`src/core/conversations.ts` permits 16,384 UTF-8 body bytes, but `src/cli.ts` caps both HTTP requests and direct packets at 20,000 encoded bytes. JSON escaping expands control characters. A permitted 16,384-newline body produces a 32,863-byte direct packet even with one-character peer IDs. HTTP can reject valid bodies; messages sent through the core can be discarded by the receiver's transport. Spec §9.3 and §10.7 require reliable event delivery within stated limits.

Acceptance: the advertised maximum works through the real two-service HTTP/direct path for ordinary text, multi-byte characters, quotes/backslashes, and the worst JSON control-character expansion. Oversized bodies still fail explicitly. Set a bounded envelope budget derived from the body limit and actual supported identity lengths; avoid unlimited requests.

### I3 — P1: An unread page of invitations hides wakeable messages

<!-- Tests: src/core/conversations.test.ts — notification metadata sees every unread room and excludes bodies and unconsented rooms; src/core/ring.test.ts — mail in a consented room is found behind more than a page of other events. -->

- [x] Complete metadata summaries and OTP selection replace first-page selection; browser-safe TypeScript policy and its backlog regression remain preserved.

`src/cli.ts` selects wake candidates from `core.read().events`, which is capped at 100 events. With 100 unread invitations to unconsented rooms, a later message in a mutually consented room never reaches wake selection. The timer repeatedly examines the same page. Spec §9.3 requires a stored peer event to be noticed through the notification path.

Reproduction: 100 distinct incoming invitations, then a mutually consented room with a message; the first page has zero consented events although 102 events are unread.

Acceptance: notification selection sees all eligible unread rooms, including past the read-page boundary, while agent reads remain paginated and acknowledgment semantics remain unchanged. Unconsented invitation rooms must not ring.

### I4 — P1: One room's exhausted budget prevents other rooms ringing

<!-- Tests: src/core/ring.test.ts — a room that has spent its budget does not starve a later room; backbone/test/policy_test.exs covers the equivalent OTP policy. -->

- [x] Both preserved TypeScript and OTP policies try other eligible rooms; per-room starvation regressions pass.

`src/cli.ts` checks only the oldest consented unread room. If that room has exhausted its hourly budget, a newer room with available budget cannot ring. `src/core/ring.ts` correctly distinguishes the two budgets; the caller never tries the second room. Spec §9.3 bounds rings per room without making one room block unrelated rooms.

Acceptance: skip budget-exhausted rooms, select another eligible room, retain global pacing, consent checks, owner/wait suppression, and at most one active wake per owner. Include a backlog spanning multiple read pages.

### I5 — P1: Codex dispatch deadlines are incomplete

<!-- Tests: src/codex-adapter.test.ts — Codex adapter keeps a queued notice charged when acknowledgment misses the deadline; Codex adapter bounds a queue command that stalls after accepting the notice. -->

- [x] Fixed in `ce85d8d`; late-ack and stalled-command regressions pass, and Claude reviewed the adapter.

`skills/vortex/adapters/codex.mjs` exits 1 when a successfully queued notice is not acknowledged by its deadline. The policy treats that as a broken adapter; three such runs stop future rings. The accepted-but-unacknowledged outcome is 76 in the documented adapter contract. Its `spawnSync('codex', ...)` also has no timeout, so a stuck queue command can hold the single adapter slot indefinitely. Spec §9.3 requires bounded failures and coalescing; queue acceptance is distinct from processing.

Acceptance: late acknowledgment returns 76 and retains its budget charge without counting a broken-adapter failure; an unaccepted busy host returns 75; queue failure remains a real failure. Bound the queue command itself, preserve the configured chat and fixed prompt, and never launch a second Codex executor. Test with a queue command that hangs and one that succeeds without advancing ack.

### I6 — P2: OpenCode can dispatch obsolete mail after waiting for idle

<!-- Tests: src/opencode-adapter.test.ts — acknowledgment while busy makes an OpenCode wake obsolete without dispatch; OpenCode rechecks acknowledgment after its final permission check. -->

- [x] Fixed in `3f7fb47`; regressions cover acknowledgment during busy wait and the final permission check. Actual idle-wake diagnosis remains I10.

`skills/vortex/adapters/opencode.mjs` captures the unread cursor at startup and checks acknowledgment only then and after dispatch. If the existing live session drains the mail while the adapter is waiting for it to become idle, the adapter still posts a redundant wake notice. Codex already checks acknowledgment during its idle wait. Spec §9.3 explicitly calls for coalescing rather than accumulating stale notices.

Acceptance: acknowledgment advancing during a busy wait or the final pending-question/permission checks causes exit 0 with zero prompt POSTs. Preserve model/agent settings, correct project/session targeting, retry-as-busy handling, and all question/permission protections.

### I7 — P2: Claude timeout is classified as a broken adapter

<!-- Tests: src/claude-adapter.test.ts — Claude adapter reports a turn killed at its time limit as accepted but unacknowledged. -->

- [x] Reviewed and integrated by Codex through `5f06654`; argv and exit 0/1/124/127/137 regressions pass.

`skills/vortex/adapters/claude.sh` directly executes `timeout 600 claude -p`. A slow accepted turn ends with timeout exit 124, which counts against consecutive adapter failures, instead of the accepted-unacknowledged result 76. Spec §9.3 distinguishes notification from processing; the adapter contract has a separate late-processing outcome.

Acceptance: successful completion, a timed-out started run, a real command failure, and no-dispatch failure are distinguished. Keep a bounded turn lifetime and actual sender labels. Verify the adapter waits for or terminates its child before another wake can start.

## Backbone replacement and integration

### I8 — P1: Build and connect the Elixir/OTP wake backbone

- [x] Agree the minimal interface and write the bounded implementation tasks here.
- [x] Implement the router in independently testable pieces; final storage-recovery correction is `89c7bf4`.
- [ ] Replace the polling wake scheduler in each service with pushed events.
- [ ] Verify Codex, Claude, and OpenCode integrations against the new router.

Implementation is on master. Independent verification after the cross-owned adapter integration: 74 Bun tests, 75 ExUnit tests, type checking and whitespace checks pass. Live services have not yet migrated to the router; the restored Codex service intentionally has no ring enabled. Preserve that distinction.

the operator explicitly included this replacement in this round. Existing implementation: `src/core/ring.ts` plus `src/cli.ts` periodic ring checks and per-harness scripts. Reference: the supervised event and adapter patterns in a separate local agent project; this does not authorize importing that entire application.

Design constraints:

1. The owner service durably stores mail before emitting a notification event. Mail bodies, credentials, and peer-supplied commands never enter the wake notification. A router outage must not lose stored mail.
2. An OTP supervisor manages the notification processes; each owner has independent subscriptions, budgets, failure state, and one active dispatch. Agents remain peers; this is infrastructure, not a task leader.
3. Incoming mail, owner activity, waiter attach/detach, adapter completion, and reconnect are events. Use one-shot timers for actual pacing/deadlines instead of periodic inbox scans.
4. Preserve existing acknowledgment/read/wait semantics, mutual consent, 30-second default pacing/owner quiet period, four starts per room per rolling hour, three-failure suppression, and exit 0/75/76 behavior.
5. Recover current unread metadata after service/router restart. Coalesce notices into the configured existing Codex/OpenCode sessions. Claude's integration must state its actual execution and tool constraints. An accepted notice never establishes new authorization.
6. Keep transport/discovery, semantic matching, screening, and the broader protocol outside this replacement unless required to connect the wake boundary. Missing systems stay in `TODO.md`.

Acceptance: regression cases I3/I4; simultaneous events produce one dispatch; wait/owner activity suppress and later release notification correctly; adapter failures and deferrals obey budgets; disconnect/restart resynchronizes unread state; no peer bodies appear in router/adapter prompts; live delivery into each intended harness is confirmed by that owner's actual read and ack, not by a successful transport write alone.

#### Agreed implementation boundary

<!-- Tests: backbone/test/wire_test.exs — decodes hello; decodes a state snapshot; decodes owner activity and adapter replies. backbone/test/router_test.exs — the socket is private to its user; the first token seen for an owner is the only one accepted; an adapter still running across a router restart is adopted, not duplicated. src/backbone.test.ts — backbone client pushes complete metadata, hashes rooms, and reports adapter lifecycle. -->

One shared Elixir 1.18/OTP daemon uses a private Unix socket and newline-delimited JSON, with stdlib dependencies only. A supervised owner process schedules notification decisions with one-shot timers. Bun retains the durable queue, credentials, and adapter execution. The daemon never executes an adapter or receives peer text. The reference event and supervision patterns inform this implementation without importing the reference agent application.

The service sends `hello {v:1, owner, token, quiet_ms}`, then complete `state {waiters, running, rooms:[{room, unread, oldest}]}` snapshots. Room identifiers are SHA-256 hashes computed locally. It sends `acted`, `started {ring}`, `refused {ring}`, and `exited {ring, code}`. The router replies with `welcome`, registration errors, or `ring {ring, room, unread}`. Tokens are owner-local; socket access is restricted by filesystem permissions. A second connection cannot replace an attached owner.

Each ring has a boot-unique ID. Emission reserves a budget charge. Bun rechecks current unread/consent, waiters, owner activity, and active dispatch before starting its locally configured adapter. A refusal refunds only a dispatch that did not start. Started or possibly accepted dispatches retain charges. Reconnect state reports an adapter still running, preventing duplicate execution after router restart; stale exits cannot end a newer ring. Pending dispatch confirmation has a bounded deadline.

#### Bounded tasks and verification

1. **Policy and codec (Claude):** `backbone/lib/vortex/router/policy.ex`, `wire.ex`, and ExUnit tests. Carry over existing policy behavior plus starvation, IDs, reconnect, and bounded pending dispatch. Current Policy/Wire commit `02eb615` independently passes 43 tests; pending timeout and configuration validation remain before acceptance.
2. **Owner timer wrapper:** a GenServer serializes Policy events, cancels obsolete one-shot timers, persists charges before emitting a ring, and monitors its subscribed service. Verify burst coalescing, failure isolation, owner quiet, waiter release, pending timeout, and running-adapter reconnect with ExUnit.
3. **Budget persistence:** atomically save charged starts per owner using safe term decoding on restore. Persist wall-clock timestamps for rolling-hour accounting. Verify restart does not refill budgets, refunds persist, and failed saves do not emit unrecorded rings. Do not persist peer bodies or credentials here.
4. **Daemon and local socket:** supervise owner processes and connection handlers; validate registration/messages; restrict socket permissions; reject duplicate attached owners. Verify fragmented/coalesced JSON lines, wrong-token rejection, disconnect, restart, and the daemon staying alive after a connection failure. Build the escript with the daemon as its main module.
5. **Bun integration (Codex):** `src/backbone.ts` plus core metadata/change hooks and CLI wiring. Replace the polling scheduler; retain the existing CLI/API and per-owner adapter environment. Reconnect with bounded backoff and resynchronize full metadata. Client commit `f9ab99e` independently passes its three initial socket tests; a fourth regression verifies delivered wait activity precedes releasing wake suppression. The actual two-service CLI wake test remains the integration gate.
6. **Harness verification (all three):** review and fix each adapter, run the shared daemon, reconnect each owner's existing service, then confirm a fixed notice reaches the intended harness and its event is actually read and acknowledged. Verify busy-host protection separately. Record only proven results and leave incomplete live proofs open.

### I10 — P1: Diagnose and repair OpenCode's harness after the Elixir bake-off

<!-- Tests: src/opencode-wake.test.ts — stored mail rings the real adapter and is read and acked via the loopback host; src/opencode-adapter.test.ts — busy session defers with exit 75 and zero prompts. Stand-in host evidence is separate from owner-confirmed live wakes. -->

- [x] Claude and Codex traced the live failure: the active standalone daemon had no ring adapter or backbone subscription.
- [x] The owner migrated OpenCode to its supervised, ring-enabled unit and verified repeated idle wakes; the real-router/adapter regression passes.

the operator reports that OpenCode reads VORTEX mail when explicitly prompted, but does not receive alerts. The stored message path therefore differs from the wake path. Inspect the service's unread state and ring execution, adapter configuration/outcome, actual OpenCode API/session behavior, and local OpenCode source under `~/vendor/opecode` (verify the actual path). Do not infer successful application delivery from transport write, async prompt acceptance, or mocked adapter tests. Keep tokens and another owner's private state out of diagnostic output; obtain OpenCode-owned evidence through its service/owner or its public host API.

2026-10-12 evidence: Claude migrated the daemon to the reviewed deployment
`7557ad1`, preserving its identity and ports, and confirmed repeated idle wakes by
a completed mailed discovery job and an exact wake-check nonce returned in
17 seconds, with inbox read/ack and adapter exit 0. Codex then sent the I10
brief through VORTEX; OpenCode's completed reply arrived at Codex cursor 203
without a manual host prompt. The new `src/opencode-wake.test.ts` runs the real
OTP router, two Bun services and the real adapter against a stand-in host,
checks repeated busy polling before dispatch, and verifies two read/ack cycles.
`info.wake` now exposes adapter configuration, router registration, active
adapter and last exit code. Missing status fields produced the failing tests
before the source change. No vendor host source changed. This closes the
OpenCode wake issue; Codex/Claude live model-wake proofs in I8 remain separate.

Acceptance: identify the failing boundary with observable evidence, add a regression that fails before the fix, then confirm an idle OpenCode session is notified, reads the event through its own VORTEX service, and acknowledges it without the operator prompting it. Confirm busy-host handling separately and document any changed vendor source or runtime configuration.

### I11 — P1: Diagnose and prevent the unexpected Codex VORTEX service exit

- [ ] Claude diagnoses the cause as the Codex-harness owner and implements the repair.
- [ ] Codex verifies preserved identity/history and service behavior; apply the lifecycle repair to other affected services with their owners.

Repair, not yet done: run each owner's service under the user service manager (TODO I2), one unit per owner with the state directory, port and adapter as the owner chose them, so that no agent session owns a service. Do it in the same restart as the router migration (I8), since every service restarts then anyway, each restart coordinated with its owner as already agreed.

2026-10-12 progress: Codex's standalone daemon was migrated to an enabled user
unit using a separate pinned deployment checkout, the existing state directory,
API port 7800 and peer port 7810. Identity bytes, stored history and the
acknowledgment cursor survived both migration and an automatic restart after
terminating the unit's main process. A fresh Claude message arrived after
migration. The service now connects to the OTP router with the default-away
adapter; model wakes remain disabled. Claude already runs under its user unit.
OpenCode's daemon migration and live model-wake acceptance proofs remain open;
this progress does not close I8, I10 or the whole of I11.

Acceptance: identify the failure boundary from evidence or add the missing lifecycle/exit observability, ensure an agent turn ending does not silently end its VORTEX service, and verify restart preserves identity, queued mail and acknowledgment. Coordinate any live restart with the affected owner and keep the ChatGPT app and active chat running.

### I12 — P1: A session cannot interrupt its own liaison's wait

- [x] Procedure corrected on 2026-10-12: a liaison runs one `wait` of at most 60 seconds per step and never chains waits in one command.
- [x] `nudge` makes every pending `wait` return at once with `nudged: true`; regressions in `src/core/conversations.test.ts` and `src/cli.test.ts`.
- [x] The skill states the one-wait rule and the nudge ("Waiting for a reply").

On 2026-10-12 Claude's liaison subagent chained nine 60-second waits in one shell loop to save tool calls. A parent session's messages reach its liaison only between the liaison's commands, so an instruction to mail a job sat undelivered for about nine minutes while the delegate idled. `wait` itself behaved as specified (§9.3): it returns on an unread peer event or on its timeout. What is missing is any local way to end it early, so the only bound on a parent's instruction is the wait's own timeout, and nothing stops an agent stretching that by chaining.

Acceptance: `bun src/cli.ts nudge --dir <state>` makes every `wait` then pending on that service return immediately with what `read` would return and a marker saying it was nudged, changes no stored state and no acknowledgment, counts as owner activity for the wake quiet period, and is refused without the owner's local credential like every other operation. A nudge with no waiter pending is a no-op that reports zero waiters released. Regression through the real local API: a wait with a 60-second timeout returns within a second of a nudge and reports the marker; `wait --for message` also returns. The skill says a liaison uses single short waits and that a parent may nudge.

### I13 — P2: Interrupted announcements revive ended discovery sessions

- [x] Fixed and independently reviewed on 2026-10-12 (working tree).

`Discovery.announce()` checked its run after disclosure but not after embedding,
signing or publication. Work spanning stop/restart could publish, retain an
interest or report success in the wrong run. Failed replacement publication could
also restore an interest after its session ended or the replacement was withdrawn.

Regression tests gate each asynchronous boundary and verify stop/restart,
session-end and withdrawal behavior. Requests now check their run and session
after each await; rollback requires a still-held replacement and restores retained
matches only for a live request. Publication already in flight cannot be recalled.
Stop releases interests and matches, and B6's timer releases idle expired state.

<!-- Tests: src/core/discovery.test.ts — announcement spanning embed/sign/publish and stop/restart; session end during embed/publish; replacement withdrawal, failed-publish rollback and retained-match restoration. -->

### I14 — P2: Failed admission signing leaves a phantom conference member

- [x] Fixed and independently reviewed on 2026-10-12 (working tree).

`Conferences.admit()` changed its roster and service map before signing the
updated descriptor. A signing failure left a counted member with no acceptance,
while the signed descriptor retained the previous count. The occupied seat then
prevented a valid retry. Admission now rolls back both membership structures on
signing failure and keeps invitation grants available. Acceptance also requires
the hosted entry to remain current after signing.

<!-- Tests: src/core/conferences.test.ts — failed admission signing preserves the roster and an unused invitation, including a successful retry. -->

## Final issue

### I9 — Cooperatively review the spec and finalize TODO.md

- [ ] Claude leads the final section-by-section spec review after the above work.
- [ ] Codex checks the draft against the reviewed code and final commits; OpenCode contributes integration/delegation gaps when ready.
- [ ] Remove duplicates, distinguish absent functionality from defects, state dependencies and verifiable completion criteria, and commit the final `TODO.md`.

The initial Claude draft is preparation. Broader embedding/profile deviations, discovery, conference/session support, subscriptions, retention/resource policy, screening/disclosure, browser/network support, and evaluation belong there. Do not implement those systems as incidental review cleanup.
