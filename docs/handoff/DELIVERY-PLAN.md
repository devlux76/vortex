# VORTEX remainder delivery plan

Authority: VORTEX_v5.1.md, TODO.md and ISSUES.md. Owner instruction, 2026-10-12:
deliver all remaining work with available AI credit, implement serially and use
subagents for bounded reviews. Owner reprioritized Chrome browser plugin to priority1 on2026-10-14 to unlock ambient AI participation; prerequisites still apply. Repository remains private until owner changes visibility after browser readiness.

## Delivery queue

| Order | Deliverable | Backlog | Acceptance |
| --- | --- | --- | --- |
| Done | Stabilize reviewed discovery patch and preserve checkpoints | B9 collection-window slice | ec7fdf8; independent probes/review and full checks passed. Availability ranking remains separate. |
| 1 | Complete browser mesh participant | E1, D5, D6, I6, F6, minimum F1/F4/network prerequisites | Installable browser peer with durable identity/storage, compatible embeddings, reachable peers and wake; own-AI task interface plus bounded volunteer contribution loop; signed IOUs/balances/resource limits and untrusted-message handling; demonstrated exchange between independent installs. |
| 2 | GitHub contribution workflow while repository stays private | delivery infrastructure | Reproducible CI, scoped contribution tasks and review instructions; Copilot review/approval capabilities verified against actual repo settings. Owner makes repo public only once browser plugin is ready. |
| 3 | Safe remote volunteer participation | A1, A2b, B5, F1/F2/F3/F4/F6, G1/G4/G5/G7, D1/D2b/I7 portions | Vector-only discovery, signed contacts and actual scope enforcement; screening/held tools, resource limits, admission and accounting; one verified supported remote path. |
| 4 | Community pilot and measured donated-agent work | H1, H2/H6/H7 portions, D4 | Reproducible volunteer onboarding, bounded chosen contributions and local verification; honest real-agent utility/abuse evidence before broad outreach. |
| 5 | Remaining feature completeness and release acceptance | E2, F5, G2/G3/G6, I1/I2b/I3/I4/I5, H1–H7, remaining D1/D2b, ISSUES | Profile migration, additional transports/encryption and wake completion; labelled-data provenance, calibration and complete specification review/deployment acceptance. |

All rows remain required. Work that needs unavailable runtimes, independent
agents, operator policy values or external deployment is recorded separately
from implemented code. Never substitute mock proof for live acceptance.

## Completed slice: C7b (af93a5f)

1. Add history request/reply protobuf records carrying room, unpredictable request
   handle, current session key, host sequence and bounded page size. History rows
   carry original signed message and sender certificate; no full roster.
2. Retain host-authored and admitted participant messages, bounded by count and
   byte limits (both configurable, zero disables retention). Retention survives
   participant departure, not host restart; persistence remains optional.
3. Authenticate requests against current membership and transport sender. Limit
   reply bytes and records, report retention gaps, and reject forged/cross-room
   certificates/messages and invalid sequence metadata before exposing a page.
4. Bound outstanding requests and deadlines; reject on leave, close, expiry or
   stop; ignore unsolicited, duplicate and stale responses. Keep pagination
   cursors separate from inbox acknowledgment cursors.
5. Expose history through service, CLI/API and conference-scoped vortex_receive.
   Regression tests cover privacy, departed senders, pagination/retention,
   maximum bodies, timeout, mutation and lifecycle races.
6. Review the slice with one subagent, fix material findings with regressions,
   run the full Bun suite, typecheck, ExUnit and whitespace checks, then checkpoint.

## Completed slice: C8 (d986165)

1. Membership prerequisite (checkpoint fa04894): persist the participant's per-room session
   private key and signed descriptor through a trusted local helper. Resume with
   the same key and a fresh service-signed certificate; host refresh requires
   that key to remain bound to the authenticated sender. Do not consume another
   invitation, seat or arrival. Validate cached descriptor before dialing.
2. Verified durable store in Conversations: optional snapshot subscription records hold
   session, host, expiry, host-history cursor and private saved membership. No
   private field enters public list/status/events. Preserve old snapshot shape
   when no subscription exists. Bound count; failed save rolls back exactly.
3. Durable replay: conference message IDs join the existing unread-pinned dedup
   mechanism. Apply one verified history page and its cursor in one serialized
   save. Failed save must advance neither cursor nor events; removed/changed
   subscriptions cannot be recreated by stale work. Live/history overlap must
   not duplicate events, including after restart and acknowledgment.
4. Verified basic service lifecycle (recovery remains): subscribe only current memberships; lifetime is chosen by
   the caller within operator bounds and clipped to the signed room expiry.
   Renew explicitly; stop preserves subscription state but cancels active work.
   Restore participant keys, refresh current roster and fetch missed history on
   restart/reconnect. Host rooms remain ephemeral and their subscriptions end
   with the room. One recovery task per room; bounded deadlines/retry backoff.
   One expiry timer removes expired subscriptions durably and leaves membership.
5. Add subscribe/subscriptions CLI/API, vortex_subscribe, status projection and
   subscription leave. Existing conference leave also ends its subscription.
   Persist secret keys only in the existing owner-private state file; never
   accept private key material in ordinary tool arguments or expose it in errors.
6. Test real restart with preserved peer identity, missed delivery and duplicate
   replay, invitation continuation, expiry/renewal, failed save, stop/cancellation,
   malformed cache and public-output privacy. Review the full slice with a
   subagent; run the whole suite and checkpoint before the next queue row.

Use small serial free-delegate slices with exact backup/file scope where the
interfaces are clear. Root verifies, handles design/corrections and preserves
credit for review. The private-membership slice alone does not complete C8.

## Execution rules

Write a failing regression first, implement the smallest compatible change,
run focused checks, and run the full suite at milestone boundaries. Redirect
long logs to temporary files. Reuse review contexts where useful. No parallel
implementation. Record progress and rulings in DELIVERY-PROGRESS.md immediately.
Expand the next ready slice only after inspecting its actual interfaces.

Strict namespaces and the existing loopback restriction remain in force.
Resolve browser runtime compatibility through measured builds, not an assumed
0.99 tolerance. Preserve the existing TypeScript/browser core and OTP wake
boundary; architecture decisions affecting the screen are recorded before work.
Operator policy amounts remain configuration, never universal protocol constants.
Installed services, agent hosts, publications and external mesh deployment need
actual owner/run context; preparing their code and tests remains authorized.

## Completed slice: C1 topic revisions (3c307b0)

Owner approved the concrete design on 2026-10-13: host-only disclosure-checked
statement revision, private kept source text, a newer signed descriptor under
the same room handle, authenticated updates to joined members and stale/forged
update rejection. Include CLI/API and MCP revision operations. Implement core
and wire first, then bindings, with serial free delegation and independent review.
Remaining row2 items follow this slice; external acceptance gates remain open.

## Completed slice: C9 private peer memory

Implement optional per-participant outcomes on leaving, verified certifying
peer identity, private expiring subject-scoped records and kept source text
under the approved subject rule below. Remaining discovery/scoring row2 items
follow.

Owner approved original query by default on 2026-10-13: participants keep their
query source privately through membership/subscription restart; hosts use the
current topic, with explicit override available. Execute serial slices: private
durable store/helpers; local subject/provenance retention plus service feedback
and subject-scoped preference; CLI/API/MCP bindings. No network-wide reputation.

## Current slice: B9 bounded collection windows

Collect newly retained discovery handles for a fixed 500 ms batch, then notify
only current retained survivors in tier/full-score order. Later arrivals begin
a new batch for the same long-lived interest. A local matchWindowMs option
allows 0 for immediate notifications. Lookup retains current collected results.
Preserve per-peer/interest caps, verified descriptor updates and transactional
replacement. Cancel pending work on withdrawal, expiry, session end and stop;
old-generation or reentrant callbacks must not emit stale notifications.
Session-availability ranking remains the separate unfinished B9 requirement.

## Owner browser-first direction, 2026-10-14

After the current B9 patch is stable, browser work takes precedence over the
remaining discovery/remote feature queue. Existing browser transport and
loopback WebSocket bridge are reusable; browser durable storage and wake
remain incomplete. Chrome extension-facing Prompt API uses on-device Gemini
Nano; cloud Gemini is a separate integration, not assumed automatic forwarding.
First verify actual available API/model and strict reference embedding runtime,
then implement a bounded extension peer and prove one real exchange.
The existing GitHub remote is devlux76/vortex; no new repository/migration
needed. Owner retains the visibility change; prepare contribution/review
workflow privately. Copilot approvals are public preview and require settings
to be enabled; do not assume repo access/plan eligibility from documentation.

## Clarified browser product milestone, 2026-10-14

Owner intends a Folding@home-like P2P problem-solving mesh: users install the
plugin, browsers contribute AI work within chosen limits, and owners assign
tasks to their own AI and consume mesh assistance. IOUs account for contributed
and consumed work. Implementation/backend API choice belongs to the implementer,
not a prerequisite question to the user. A UI-only extension is insufficient.
IOUs and minimum remote-network/resource/content safeguards are therefore
part of the first usable browser milestone, not deferred polish. Keep repo
private until that end-to-end path is ready; owner controls publication.

Current source baseline is ahead of old D5 wording: service and browser transport
bundle for browser (current Bun1.4.3:1100modules across service/browser/embedder entry points,0.53MB/1.30MB/1.13MB), save is already
void|Promise<void> and awaited before state becomes visible. Build browser
storage on that contract; do not refactor it as if it were synchronous.


Dependency policy (owner, 2026-10-14): select direct packages with @latest,
verify current registry versions before adding compatibility work, and keep
the lockfile for reproducibility. Avoid forks or parallel implementations for
bugs already fixed upstream. Model revisions remain immutable protocol
identity; this is separate from package-version selection.
