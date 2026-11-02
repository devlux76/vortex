# Codex hook isolation implementation plan

> Execute inline with test-driven-development and executing-plans. Cross-review the final candidate with Claude, who owns the hub/outbox slice.

**Goal:** Only the locally selected Codex chat can receive or acknowledge passive mail and set the binding's human-turn provenance.

**Architecture:** BridgeBase checks a host policy at context entry, again after an awaited passive pull, and before accepting the offer's acknowledgment. Codex's policy requires a nonempty hook `session_id` matching the current local thread binding. Other hosts preserve their existing policy.

**Tech stack:** Bun, TypeScript, existing real scratch hub/socket/CLI integration fixtures.

**Spec:** `docs/v6-proposal.md` sections 6, 8.4, 8.5 and 8.7. Issue `vortex:9edac06`, related parent `vortex:e769658`.

## Constraints and review focus

- Local thread IDs never go to the hub or peer messages.
- Foreign, absent, malformed and unbound sessions must not pull/offer/ack mail or set human provenance.
- A rebind during an outstanding hook offer must not let the old chat acknowledge it.
- Re-check binding after the asynchronous pull; release a declined offer for the rightful chat.
- Correct-session delivery, pending-mail preservation, human provenance and all other hosts must still work.
- No hub/outbox changes, v5 revival or push. Desktop delivery remains separate live acceptance.

## Task 1: Isolate passive Codex hooks

- [ ] Add authenticated session IDs to existing Codex hook fixtures.
- [ ] Add integration tests for rejected identities/provenance, unbound mail, passive rebind and rebind before ack.
- [ ] Run the Codex tests; observe the intended failures against the old handler.
- [ ] Add `protected acceptsHook(event: Record<string, unknown>): boolean` to BridgeBase and a Codex override using `loadThreadBinding`.
- [ ] Check policy before mutation/pull, after a pull, and against the stored offer event on acknowledgment; reject without persisting or hub acknowledgment.
- [ ] Run Codex tests, all v6 tests, full project suite and both typechecks; rebuild committed plugin bundles and run bundle tests.
- [ ] Verify issue, clean diff and surgical changes; commit with existing bug reference and <=255 characters. Hand exact base/pin/evidence to Claude for cross-review without pushing.

## Task 2: Establish the real desktop probe boundary

- [ ] Check installed CLI proxy/thread-read against the actual desktop chat without a model turn.
- [ ] Record actual host support/failure and plan a bounded real desktop/plugin delivery probe through the supported path. A fake inference server or fixture is not desktop acceptance.
- [ ] Keep deployment, cross-device exchange and cutover incomplete until the required live proofs exist.

## Ledger

Baseline: v6-impl `89bfca9`; isolated branch `codex/v6-binding-isolation`; original Codex integration suite 11/11 pass. Native app worktree tool rejected the nested repository as outside its accepted source-root list, so normal Git worktree fallback was used. Existing installed dependencies are linked locally; no dependency changes.

Ruling: the operator already opted out of further permission gates and the design/split exists, so execute this bounded repair inline. Claude remains the independent reviewer; do not spawn another implementation agent.

Execution evidence: five new regressions reproduced the missing isolation/rebind checks (four original failures plus an independent post-pull mutation RED/GREEN). Final v6 suite 73/73; both v6 and root TypeScript checks pass; bundled plugin tests pass. Full repository `bun test` was attempted and is not green: legacy OpenCode adapter failures reproduce unchanged on the base (10 failures, 20 pass in that file); legacy live-adapter wake test also fails. Broad run stopped after those failures and no further progress; unrelated v5 code was not changed. Detailed baseline log retained outside source. Desktop read-only probe: default app-server proxy cannot connect because its control socket is absent, despite the desktop being active. No model request, alternate chat or receipt was created; real desktop acceptance remains pending.
