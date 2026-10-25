# VORTEX release continuation

Codex, 2026-10-12. This supersedes the implementation queue in the older private
handoff: hosted discovery, durable local retention, bootstrap templates and the
MCP binding for existing operations are implemented. Continue from current
local `main`; do not redo those jobs.

The local loopback prototype now has semantic interests, hosted conference
discovery, multi-participant signed messaging, bounded acknowledged inbox
history, automatic bootstrap configuration and a stateless MCP adapter. This
does not complete the entire v5.1 specification or authorize a remote release.

## Disclosure policy decision and implementation (A2)

The operator selected: implement configurable rules and preserve current
loopback behavior until configured. A2a now provides `--disclosure-policy FILE`
with no built-in blocking patterns and no change when the file is absent.
README documents the configuration and owner-selected approval mechanism.
Personal namespace/network-context rules and identifiers can be supplied in
that file; they do not block implementing the engine.

Implemented and verified:

* Check a semantic statement before embedding, signing or publishing it.
  `Discovery.checkOutbound` awaits the service-supplied policy hook.
* Cover legacy announcement text and all locally authored outbound message
  paths too. Do not screen only the announcement's optional plain-text field:
  the vector discloses the underlying statement as well.
* Enforce configured namespaces/networks and credential, path, hostname and
  project-identifier rejection patterns. Rejection errors must not echo the
  sensitive match. Reject invalid configuration at startup.
* Operator approval must come from an owner-selected local mechanism. An
  agent-supplied boolean must not pretend to be human approval. Peer content
  cannot select an approval executable, path or policy.
* Add regressions demonstrating every rejection happens before inference,
  publication, transport write or durable event creation. Test permitted
  content and configuration errors too; verify the full suite and typecheck.

Remaining A2b: network checks currently use the declared `loopback` deployment
context and do not verify actual egress addresses or mesh locality. Configure
operator rules and enforce real network scope before remote release. Incoming
screening and forwarded peer bodies are outside this local outbound policy.

Do not remove the legacy broadcast (A1) as incidental policy cleanup. That
transition needs its own compatibility decision. All services stay on loopback
until both A1 and A2 are satisfied.

## Discovery lifecycle and conference rejoin assessment

Verified on 2026-10-12 in the working tree: B6 now uses one rescheduled timer to
release expired interests and retained results without an agent read. Stop ends
local interests and matches; announcements interrupted during disclosure,
embedding, signing or publication cannot complete in another run. Failed
replacement publication after restart cannot resurrect the old session.

C6's implementation was already present. Its three-service test now also covers
the same participant leaving, rediscovering a descriptor after the host withdraws
the forming interest, rejoining with a fresh key, and delivering signed posts to
both remaining participants. Do not rebuild this path.

Explicit creation/admission (C3) and `vortex_create` are now implemented in the
working tree: private peer allow-lists authenticate invitation/group joins, with
single-use invitations and reusable group membership. CLI/API/MCP creation checks
disclosure before embedding. Failed admission signing rolls back membership.
C7b authenticated bounded history is implemented in the working tree, including
departed-sender provenance and separate history/inbox cursors. Next: subscriptions
(C8), followed by the queue in DELIVERY-PLAN.md and its progress ledger.
B9's collection window and B5's peer penalties remain independent discovery
work. A1/A2b remain remote release gates. Owner deployment and live-agent
acceptance are separate from code tests.

## Independent remaining implementation

* C7b is implemented: signed bounded pages, membership gates and departed-author
  certificates. Direct history reads do not mutate the inbox. Subscriptions must
  replay verified pages durably with message deduplication (C8).
* C1: ordered signed descriptor revisions now reject replayed discovery metadata
  and membership updates. Receivers refuse descriptors without a positive
  revision; upgrade older hosts before discovery/join. Topic revision remains.
* C8/D2b: subscriptions and content-screen/held-message operations. Advertise tools
  only when their service operations exist. Screening status currently says
  disabled; it must not imply that any screen ran.

Browser runtime/namespace choices, threshold calibration, remote transports,
screening architecture and reciprocal accounting remain in TODO.md. They are
not incidental extensions of the completed local work.

## Owner acceptance and deployment

I2b: substitute public peer IDs into all three verified unit templates and
install them through README's deployment procedure. Automated tests use
temporary identities and ports; installed units were not changed. OpenCode
remains intentionally off; its API was not probed. Claude was not contacted.

H1: once independent agents are available, use the real embedding model under
the machine's inference lock and prove that the agents announce, join,
exchange and use findings. Automated table-embedder services do not count.
Repository publication is now owner-authorized. Moving the pinned deployment
checkout remains a separate owner action; installed services were not changed. The old hosted-discovery handoff's review checkpoint is completed.
