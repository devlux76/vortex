# Native VORTEX Read Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Claude owns the separate host wiring; do not duplicate it.

**Goal:** Expose non-consuming, principal-scoped message history through the shared `vx_read` tool, matching the ordinary Slack/Teams connector workflow.

**Architecture:** Add an authenticated own-DM GET route using the existing store `dmLog(principal, after, limit)`. A shared client helper validates arguments, requests history, renders bounded pages, and returns a cursor footer. No delivery or wake state changes.

**Tech Stack:** Bun, TypeScript, SQLite, existing HTTP client and renderer; no new dependencies.

**Spec:** `docs/v6-amendment-a5-connector.md` (agreed at 8c01f9f, bug:18f6172).

## Global Constraints

- `vx_send` unchanged. Shared API: `READ_TOOL`, `parseReadArgs`, `readHistory(client, args): Promise<string>` in `v6/client/read.ts`.
- Read arguments: scope room/dm, optional room, after safe integer >= 0, limit integer 1..20; default room/all, after 0, limit 20. Unknown keys rejected; no model-selected identity.
- Payload <=20 messages, <=6000 code points, <=8192 UTF-8 bytes; ASCII cursor footer plus separator <=96 bytes, total <=8288 bytes.
- Cursor advances only through returned messages; empty page preserves input cursor. Determine `more` by actual lookahead.
- `/v1/dms` stays operator-only; `/v1/dms/mine` uses authenticated principal. Room membership unchanged.
- No acknowledgment, batch creation, wake permits, counter changes, polling, model calls, live config changes or pushes.

## Review Focus

- Another pair's DMs must remain invisible even with a caller-supplied principal query.
- Near-bound accepted single messages must remain readable with the cursor footer.
- A small configured hub log cap must not cause a false `more=false` result.
- Render-size pagination must never skip an unreturned message.
- Reads must not consume held messages or mutate cooldown/budget state.

## Task 1: Principal-scoped DM endpoint

Files: `v6/hub/api.ts`, `v6/client/client.ts`; test `v6/hub/read.test.ts`. Reuse the existing store `dmLog`; no new store query.

- [x] Add real HTTP tests for own incoming/outgoing DMs, ordered cursor/limit, identity isolation, 401, and existing operator-only endpoint.
- [x] Run `bun test v6/hub/read.test.ts`: expect missing `/v1/dms/mine` route to fail with 404 instead of 200.
- [x] Add GET route/handler and `VortexClient.ownDmLog(after=0, limit=100)`; authenticate token, clamp with existing API limits, call existing principal-scoped store method.
- [x] Re-run focused tests; require all passing.

## Task 2: Shared bounded read tool

Files: `v6/client/read.ts`; test `v6/client/read.test.ts`. Host wiring consumes the three exports above and belongs to Claude.

- [x] Write behavioral tests for room/own-DM visibility, validation, cursor/lookahead, render escaping/size pages, near-bound single message, small hub cap, and unchanged delivery state.
- [x] Watch expected failures before implementing each behavior; use real scratch hubs and existing HTTP/render code.
- [x] Implement strict parser/schema and read helper, fetching at most limit+1 messages plus one fallback lookahead if the server cap prevents an extra result. Choose a FIFO prefix that fits the renderer, render `batch="history"`, append the cursor footer.
- [x] Run both focused files, then `bun test v6` and v6 TypeScript checks. Known inherited v5 failures remain outside this change; do not claim the whole repository is green.
- [x] Verify issue 18f6172 exists, diff clean, commit <=255 characters citing the issue; publish local pin/interface to Claude for integration and independent review.

## Ledger

- Base: 96d2d62. A4 review is independent; shared read work is isolated on `codex/v6-native-read`.
- Existing store already implements the own-DM query; reuse it instead of the initially proposed new method.
- Existing dependency tree is symlinked from canonical v6-impl; no installation or lockfile change.

- Shared slice: API 2 expected HTTP failures then green; helper scaffolding exposed 8 behavioral failures then green; explicit-null and omitted-arguments cases each failed before their correction. Focused 10/10.
- Integration ruling: fast-forwarded onto Claude host wiring 9f040f2 before the shared commit so the A5 spec and host source have common ancestry. Four stale one-tool assertions failed as expected, updated to the agreed two-tool contract; isolated bundles now execute vx_read before hook receipt.
- Combined verification: 113/113 v6; v6 tsc clean; real-fork conformance OK against4d272be6e; bundles rebuilt; diff-check clean. Full legacy v5 suite has previously recorded inherited adapter failures; this does not claim full-repository green.
- Final whole-branch review: Claude reviews the shared implementation independently; Codex reviews final host wiring/manifests before canonical integration. No push or live cutover.
