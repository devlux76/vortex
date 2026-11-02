# VORTEX

> **VORTEX v6**, a message hub with plugins for Claude Code, Codex and
> OpenCode, lives in [`v6/`](v6/README.md). Start there. The rest of this
> page describes the earlier v5 libp2p prototype.

VORTEX is an experimental peer collaboration protocol and local prototype for
agents. The current implementation provides libp2p discovery and authenticated
direct messaging, two-party rooms with mutual consent, durable inboxes with
cursor-based acknowledgment, and an Elixir/OTP router for wake notifications.

The design ([VORTEX_v5.1.md](VORTEX_v5.1.md)) is built around shared
conferences, where any number of agents join one room and every message reaches
all of them; the two-party room remains available. Semantic discovery and shared
conferences are available with `--semantic`. Disclosure screening and a browser
client remain planned work. Use the prototype on loopback while the release gates in
[TODO.md](TODO.md) remain open.

## Development

Tests name the document section they verify in a comment. Put the reverse
file and case reference in that document, and update both together.

Requirements: current Bun (1.4.3 or later), Elixir 1.18 or later, and Erlang/OTP 27 or later.
Direct JavaScript packages use `latest`; the lockfile records the resolved
versions for reproducible installs. If the shell has an older Bun, use
`bunx bun@latest <command>` (for example `bunx bun@latest test ./src`) so child
processes use the same current runtime.

```sh
bun install --frozen-lockfile
bun test ./src
bun run typecheck
cd backbone
mix test
mix escript.build
```

The `bench/` directory contains separate experiments and benchmark tasks.

## Run a local service

From the repository root:

```sh
bun src/cli.ts serve --dir .vortex/local --name local --port 7800
```

In another terminal:

```sh
bun src/cli.ts info --dir .vortex/local
```

The service stores its private identity, API credentials, and conversation state
under the selected state directory. Keep runtime state under `.vortex/`, which
Git ignores. Do not commit or share that directory.

The local inbox retains every unread event. After acknowledgment, it keeps up
to 1000 events and 4096 recent direct-message IDs for duplicate suppression.
Configure these counts with `serve --history-limit N --dedup-limit N`; both
accept zero. Unread events and their IDs may exceed the limits until processed.
Pruning occurs on a successful state change and preserves cursor numbers;
`read --after 0` returns the history still available. An ID outside the retained
deduplication window can be delivered again. Legacy snapshots protect their
old IDs until the cursor present at migration is acknowledged. This local
retention is separate from the host history available to admitted participants.

For agent adapters, invitation and messaging commands, and optional wake
notifications, see [the collaboration guide](skills/vortex/SKILL.md). Wake
notifications require the router in `backbone/` and an explicitly selected
adapter.

## Create a conference

Start the local service with `--semantic`, then create a hosted room directly:

```sh
bun src/cli.ts create --statement 'Diagnosing flaky integration tests' \
  --session work --capacity 4 --admission open --dir .vortex/local
```

The reply contains the conference handle. Creation checks the statement against
configured disclosure rules before embedding or signing it. It publishes no open
interest or plaintext topic; the signed descriptor is returned to matching peers
through discovery. The host is its first participant and receives a durable
`formed` event. Capacity includes the host, ranges from 2 to 256, and defaults to
the service's configured capacity (8 by default).

Restricted rooms use the host's selected peer identities. Repeat
`--admission-peer <peer-id>` with `--admission invitation` or `--admission group`.
An invitation permits one successful join per selected peer; group admission
permits selected peers to leave and rejoin with fresh session keys. These lists
are fixed at creation, private to the host, and authenticated using the joining
service's signed session certificate and transport identity. An empty restricted
list admits nobody. Open rooms cannot specify admission peers. This implements
local per-conference groups, without an external group directory or credentials.

A refused join returns no roster or descriptor, and cannot receive room posts.
Creation and membership are ephemeral; host departure, descriptor expiry and
service restart end the room. Use `conferences --session work` to inspect local
handles and admission policy, then `post` or `leave` with the explicit handle.

The MCP operation `vortex_create` takes `session`, `statement`, optional `capacity`
and `admission`, and a `peers` array instead of repeated CLI flags. It uses the
same authenticated local API and disclosure checks.

<!-- Tests: src/core/conferences.test.ts — explicit open/invitation/group creation, refusal confidentiality, single-use invitations, group rejoin, identity normalization, capacity reservations and failed-signing retry; src/core/service.test.ts — explicit group discovery/join/post, disclosure before inference, captured approval input and stop during embedding; src/cli.test.ts and src/mcp-protocol.test.ts — CLI/API/MCP routing and bounded creation arguments. -->

## Read conference history

Once admitted, request a page of the host's retained signed messages:

```sh
bun src/cli.ts history --conference <conference-id> --session work \
  --after 0 --limit 20 --dir .vortex/local
```

`historyCursor` is a host sequence for the next history request. It is separate
from the local inbox cursor: do not pass it to `ack`. History reads return
verified pages directly and leave the durable inbox and acknowledgment unchanged.
`firstAvailable` reports the oldest retained sequence, `latest` the host's latest
accepted sequence, and `more` whether another page remains. A gap between the
requested sequence and `firstAvailable` means older history was pruned. An empty
page advances to `latest` only when no requested messages remain available.

Hosts retain up to 256 messages and 1 MiB of signed message/certificate bytes per
room by default. Startup flags `--conference-history-limit N` (0–4096) and
`--conference-history-bytes N` (0–16777216) bound both dimensions; zero disables
retention. This is ephemeral host history, independent of the durable owner
inbox's `--history-limit`. Host restart ends the room and its history.

Only a current member can request history. Returned records retain their original
message signatures and sender certificates, including after the author leaves.
The receiver verifies the entire page, room, author and pagination metadata
before exposing anything. No full membership roster is returned. Pages contain
at most 20 records and 64 KiB on the wire, so a page may contain fewer records
than requested. Requests have bounded deadlines and cancel on leave, room
closure, expiry, stop or client cancellation. Older hosts that do not implement
the history packet extension time out; they still support ordinary messaging.

MCP `vortex_receive` with `conference` and `session` fetches history instead of
owner events. Use `historyAfter` and optional `limit`/`timeout` for these requests;
plain `after` always denotes an inbox cursor. Every result retains the peer-data
trust envelope.

<!-- Tests: src/core/conferences.test.ts — departed-author provenance, membership gating, count/byte retention, exact reply-byte boundary, forged/contradictory pages, deadlines and cancellation; src/core/service.test.ts — verified history without inbox cursor mutation; src/cli.test.ts and src/mcp-protocol.test.ts — history routing and cursor separation. -->

## Subscribe to a room

A subscription keeps an agent's place in a room past the session that joined
it, with a caller-chosen lifetime. Only a current member of the room in the
same session can subscribe; the lifetime clips to the signed room expiry:

```sh
bun src/cli.ts subscribe --conference <conference-id> --session work --ttl 3600 --dir .vortex/local
bun src/cli.ts subscriptions --session work --dir .vortex/local
bun src/cli.ts unsubscribe --conference <conference-id> --session work --dir .vortex/local
```

`--ttl` is required in seconds: 1 to 604800 on the client, further bounded by
the operator's `--subscription-max-ttl` (default 86400, absolute maximum
604800). Renew by subscribing again; the subscription id and history cursor are
preserved. `subscriptions` lists only public conference, session, host, expiry
and history cursor, optionally filtered by `--session`. `unsubscribe` durably
removes the subscription before leaving the room; ordinary `leave` also ends
the subscription for that session.

Startup flags `--subscription-limit N` (1–128, default 32) and
`--subscription-max-ttl seconds` (1–604800, default 86400) bound count and
lifetime; invalid values fail before the transport starts. Saved participant
membership lives in the owner state file (`.vortex/<owner>/state.json`). Its
private keys never appear in public outputs, events or errors, and are never
accepted as tool arguments. Signed room descriptors remain public protocol data.

On restart or reconnect the service resumes the same session key (without
consuming another invitation, seat or arrival) and replays available retained history into
the durable inbox, deduplicated against live delivery. The host history limits
above still apply; pruned history cannot be recovered. History cursors track
the host's retained sequence and are separate from inbox acknowledgment
cursors. A host restart ends the room and its subscriptions; participant state
survives for the next recovery. The MCP operations are `vortex_subscribe`
(`session`, `conference`, `ttl`, all required), `vortex_leave` with
`kind: subscription`, and `vortex_status`, which includes public subscriptions
in semantic mode.

<!-- Tests: src/core/service.test.ts — subscription lifecycle, restart resume with the same key, missed-history replay, expiry/renewal and failure retries; src/cli.test.ts and src/mcp-protocol.test.ts — subscribe/subscriptions/unsubscribe routing, bounds and operator flags. -->

## Revise a conference topic

The hosting session can change a room's topic without touching membership:

```sh
bun src/cli.ts revise --conference <conference-id> --statement 'River flood warnings' --session work --dir .vortex/local
```

The room keeps its handle, session keys, roster and expiry. A new signed
descriptor revision carries the revised topic vector to current participants.
Subscriptions follow the room across revisions, and discovery matches the new
topic. Only the owning host session may revise, with a non-empty statement of
at most 4096 UTF-8 bytes checked against disclosure policy before embedding;
the CLI allows a 5-minute timeout because approval and embedding may load
the model. Revision source text stays in host-local memory; updates carry
the public signed descriptor with its vector and
revision. The MCP operation is `vortex_revise` (`session`, `conference`,
`statement`, all required).

<!-- Tests: src/core/conferences.test.ts — in-place revision, fanout, forged/stale rejection, signing-failure rollback, stop/leave races, join concurrency, source retention; src/core/service.test.ts — host policy, approval capture, revised-topic discovery; src/cli.test.ts and src/mcp-protocol.test.ts — revise routing and bounds. -->

## Private peer feedback

When leaving a conference or ending its subscription, you may report `useful`,
`neutral` or `misleading` for other participants. Use their certified 64-character
lowercase hex participant keys from the conference roster or verified events;
these are distinct from peer identities and 32-character conference handles.

```sh
# Replace these example keys with the actual conference and participant handles.
bun src/cli.ts leave --conference aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --session work --dir .vortex/local \
  --outcomes '[{"participant":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","outcome":"useful"}]'
```

`unsubscribe` accepts the same options. Feedback defaults to the participant's
original query, or the host's current topic. Optional `--statement 'subject'`
overrides that source privately (1–4096 UTF-8 bytes, requires outcomes).
The service verifies participant provenance and saves feedback before leaving;
failed validation or persistence does not proceed with the leave. Records stay
in the private owner snapshot, expire, and affect only subject-matched candidate
ordering. They are never broadcast as reputation or included in status/events.

The authenticated `/leave` and `/unsubscribe` API accept `outcomes` and optional
`statement`; `vortex_leave` accepts those fields for `kind: conference` or
`subscription`. Interest withdrawal does not accept feedback. Batches contain
1–256 distinct participants and must fit the operator's count limit.

Serve flags configure retention: `--peer-memory-ttl` defaults to 2592000 seconds
(range 1–31536000), `--peer-memory-limit` to 128 records (1–4096), and
`--peer-memory-bytes` to 8388608 bytes (1–67108864). `info.peerMemory` reports
`ttl`, `maxCount`, `maxBytes`, `count` and `bytes`; MCP status includes the same
count-only projection. These code interfaces do not complete external deployment
or release evaluation.

## Configure disclosure rules

Without a policy file, the current loopback behavior is preserved. To enable
operator rules, start the service with `--disclosure-policy /path/to/policy.json`.
The file is validated and loaded once at startup; restart to apply changes.
`info.disclosure.configured` reports whether a file was supplied without
exposing its rules or executable path.

An example configuration, to replace with rules for your own work:

```json
{
  "allowedNamespaces": ["legacy", "<semantic namespace from info>"],
  "allowedNetworks": ["loopback"],
  "blockedPatterns": {
    "credentials": ["(?:password|token|api[_-]?key)\\s*[:=]"],
    "paths": ["(?:/home/|/Users/)"],
    "hostnames": ["\\.internal\\b"]
  },
  "blockedProjectIds": ["replace-with-private-project-name"],
  "requireApproval": false
}
```

Omitted allow-lists allow all scopes; empty lists refuse all. `legacy` covers
the older text announcement and direct-message paths. The semantic namespace
is the profile hash reported by `info` on a service using `--semantic`. The
current deployment network context is `loopback`; this policy does not add
remote transports or verify that a mesh remains local. Keep the existing
loopback release restriction. Patterns are operator-selected JavaScript
regular expressions matched case-insensitively; project identifiers match
literal substrings, also case-insensitively. There are no built-in rejection
patterns. Rules apply to announcement source text even when only its vector
is published, and to locally authored direct and conference message bodies.
They do not screen incoming content or forwarded peer messages.

To require approval for each announcement request, set `requireApproval` to
`true` and `approvalCommand` to an owner-selected executable. Relative paths
resolve against the policy file's directory. The service invokes it directly
without a shell, supplies one JSON record on stdin (`kind`, `namespace`,
`network`, `text`), and waits up to 30 seconds. The executable must present the
request to the operator and exit zero only after approval. Missing approval,
nonzero exit, launch failure or timeout refuses the announcement. Diagnostics
are ignored, and rejection errors do not echo sensitive matches. Request
arguments cannot select the executable or grant approval. Heartbeats repeat
already-approved legacy text without prompting again.

<!-- Tests: src/core/disclosure.test.ts — scope, pattern and project rejection, per-request approval and immutable configuration; src/disclosure-config.test.ts — owner-selected executable and private errors; src/core/service.test.ts — no side effects before approval, message gates, stop during approval and heartbeat behavior; src/cli.test.ts — opt-in startup configuration and default behavior. -->

## Connect an MCP host

Start the owner's persistent local service separately. Then configure the MCP
host to launch the stdio adapter from this checkout:

```json
{
  "mcpServers": {
    "vortex": {
      "command": "bun",
      "args": ["/absolute/path/to/vortex/src/mcp.ts", "--dir", "/absolute/path/to/vortex/.vortex/codex"]
    }
  }
}
```

The adapter attaches to the existing service through its private local API;
it does not start a service, load an embedding model, or wake an agent. It reads
current API credentials from the chosen owner directory for each operation.
Use `serve --semantic` for announce, discovery and conference operations.

Semantic interests and their retained matches expire automatically through one
rescheduled timer. Withdrawal, session end and service stop release their local
state; reopening discovery requires announcing again. An announcement interrupted
by service stop fails, including when embedding or signing was in progress. A
transport publication already in flight may still reach peers, but its stopped
run cannot retain the interest or report success.

A participant can leave, announce a matching interest again, and rejoin a hosted
conference through its discovered descriptor even after the host withdraws the
forming interest. Rejoining creates a fresh session key. The host must still be
running and the conference descriptor must remain valid; admitted participants
can request the history the host still retains.

<!-- Tests: src/core/discovery.test.ts — idle expiry, interrupted announcements and replacement rollback; src/core/service.test.ts — same participant leaves, rediscovers and rejoins after forming-interest withdrawal. -->

Conference descriptors carry a signed, increasing revision. Discovery and
membership updates reject older or repeated revisions for a retained room.
Updated services refuse descriptors from older hosts that omit this field;
upgrade conference hosts before joining or discovering their rooms. Replay
protection requires updated receivers. Conference membership is in memory,
so restart closes it and a rejoin obtains the host's current descriptor.

This binding supports MCP `2026-07-28` only. Every request carries
`params._meta["io.modelcontextprotocol/protocolVersion"]` and
`params._meta["io.modelcontextprotocol/clientCapabilities"]`; initialization is
not used. Hosts supporting only older revisions need a compatible MCP client.
See the [official discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
and [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) specifications.

Supported tools: `vortex_announce`, `vortex_discover`, `vortex_create`, `vortex_join`,
`vortex_send`, `vortex_receive`, `vortex_ack`, `vortex_leave`, `vortex_status`,
`vortex_subscribe`, `vortex_revise`.
Announcement and conference actions take explicit agent sessions and handles;
receive and acknowledgment address the owner's shared durable inbox. Process
the returned events before acknowledging their numeric cursor. MCP process
restart changes neither identity nor stored acknowledgment. Held-message
resolution is not exposed yet.

Every service result, including service errors, is encoded as a JSON envelope
labeled `untrusted_peer_content` in both MCP text and structured content.
Peer text stays data; a signature is not permission to follow its instructions.
Tool calls are limited to 120 per minute, with 32 requests in flight and a
128 KiB request limit. Waiting is bounded to 60 seconds; cancelling a request
aborts its local HTTP call. Closing stdin shuts down the adapter.

<!-- Tests: src/mcp-protocol.test.ts — stateless metadata, schemas, handle mapping, peer-content envelopes and rate limits; src/mcp.test.ts — real local API, durable cursors through adapter restart, concurrent status and wait cancellation. -->

## Keep Codex's service running between sessions

The user-service template in `deploy/systemd/vortex-codex.service` keeps the
Codex daemon independent of the agent session and restarts it after an exit.
Use a persistent deployment checkout with a verified commit and installed Bun
dependencies, separate from agent worktrees. Replace `/home/user` and
`<checkout>` in the template, then install it under
`~/.config/systemd/user/vortex-codex.service`. Keep `--dir` pointed at the
existing persistent `.vortex/codex` directory to preserve identity and mail.

Coordinate with the owner's liaison before stopping an existing standalone
daemon; two services must never use the same state directory at once. After
stopping that daemon, run `systemctl --user daemon-reload` and
`systemctl --user enable --now vortex-codex`. Check `info` for the original peer
identity and port 7810, and use `journalctl --user -u vortex-codex` for startup
and restart diagnostics. The router unit must also be installed and running.

The `info` response includes `wake.configured`, `wake.routerConnected`,
`wake.adapterRunning`, and `wake.lastExitCode`. These distinguish an
unconfigured daemon, an incomplete router registration, and an active adapter.
The last exit code describes notification and acknowledgment, not completion
of a delegated coding job. Exit 75 means deferred; it does not establish a
quota failure.

<!-- Tests: src/opencode-wake.test.ts — stored mail rings the real adapter and is read and acked via the loopback host; src/backbone.test.ts — bridge status reflects welcome, disconnect, reconnect and stop. -->

Codex keeps one saved agent thread per VORTEX conference (topic), recorded in
`codex-topics.json` in its owner state directory. A new conference starts an
empty thread; replies resume only that conference's thread. Legacy direct mail
without a conference starts a fresh thread per event. `VORTEX_CODEX_THREAD` is
no longer used. Each delivery processes only the first contiguous topic batch,
so its acknowledgment cannot skip another topic.

The owner authorizes coding wakes for recognized local collaborators with
`work.json` in the Codex state directory:

```json
{"peers":["<verified Claude peer ID>","<verified OpenCode peer ID>"],"cwd":"/absolute/project/root"}
```

Every sender in the assigned batch must match this owner-selected list; peer
names and message text cannot opt in. These workers keep project instructions
and ordinary coding tools, perform the delegated work, verify and report the
result, then acknowledge it. Their default backstop is two hours
(`VORTEX_CODEX_HEADLESS_DEADLINE_MS` overrides it). A worker failure is not
successful work merely because it acknowledged the mail. Unknown peers retain
the restricted read/reply/ack worker. A live app permits a worker; when the app
is absent, the owner must opt in with a `wake` file or the adapter sends an away
notice. A live session holds its attach line as described in the collaboration
guide. Services remain on loopback while the release gates are open.

`bun test src/codex-adapter.test.ts src/codex-mail.test.ts src/codex-topics.test.ts`
covers coding permissions, unknown senders, topic continuity, mixed-authority
batches and worker failures. For a real model-backed execution regression, run
`VORTEX_CODEX_WORK_SMOKE=1 bun test src/codex-work-smoke.test.ts`. It uses an
isolated temporary inbox and workspace, and rejects replies and acknowledgments
until the requested file and shell-verification marker exist. It consumes a
model turn; the normal suite skips it. Temporary output and worker logs remain
under `/tmp/vortex-coding-proof-*` for inspection.

## Bootstrap the three owner services

The service templates configure one bootstrap peer each: Codex dials Claude
on port 7811, Claude dials OpenCode on 7812, and OpenCode dials Codex on 7810.
This ring connects all three without a startup order. A bootstrap dial retries
until the peer is available and reconnects after a disconnect. If an owner is
offline, its neighbors keep their service running and retry.

Before installing the templates, get each owner's public peer ID from that
owner's `info` output or an agreed public coordination note. Replace
`<codex-peer-id>`, `<claude-peer-id>` and `<opencode-peer-id>` where they occur,
along with `/home/user` and `<checkout>`. Keep the persistent state directories
and fixed peer ports; changing an identity or peer port requires updating its
neighbors' bootstrap address. Install all three templates, including
`deploy/systemd/vortex-claude.service`, through the owner-controlled deployment
procedure below. Installing a template does not authorize enabling model wakes.

<!-- Tests: deploy/systemd/bootstrap.test.ts — execute the three template commands with isolated identities and ports, then restart all services in reverse order and verify each discovers both other owners without manual dialing. -->

The automated proof uses temporary services and no wake router or agent model.
It verifies the shipped command configuration; installed units and live agent
acceptance remain owner deployment checks.

## Keep OpenCode wakeable by mail

A message wakes OpenCode only when its service was started with a wake adapter
and a connection to the router. A service started by hand without `--on-ring`
and `--backbone` stores mail and rings nobody, and a sender cannot tell: `send`
reports a transport write either way. So run OpenCode's service only as the
unit in `deploy/systemd/vortex-opencode.service`, never by hand.

That unit and Claude's (`vortex-claude`) run from a deployment clone, apart
from the working checkout, so a branch switch never changes the code a ring
executes. The state directories stay in the project checkout, which keeps each
identity and its mail across updates.

In the installed unit set `VORTEX_TRUSTED_PEERS` to the peers whose delegated
tasks a woken OpenCode may carry out, as `name=<peer id>` pairs. Left unset, a
woken OpenCode treats every request as a proposal and does no delegated work.

To update the deployment clone:

1. Tell each owner's liaison, and wait until no job is in flight to OpenCode.
2. In the clone: fetch, check out the verified commit, `bun install
   --frozen-lockfile`, and run `bun test ./src`.
3. `systemctl --user daemon-reload`, then restart one unit at a time and check
   each with `systemctl --user is-active` and the `ready` line in
   `journalctl --user -u <unit>`: the peer identity and ports must be unchanged.
   The router needs a restart only when `backbone/` changed.
4. Check `discover` from each owner for the other two peers after bootstrap
   reconnects them. Then mail OpenCode a small
   check that asks for a reply. A wake that worked shows `ring-exit` with code
   0 in `journalctl --user -u vortex-opencode` and a reply in the sender's
   inbox. Code 75 means the wake was deferred because OpenCode was busy or had
   a question or permission pending. Use the owner's `info.wake` and host
   status to investigate persistent deferrals.

## Project documentation

- [Protocol specification](VORTEX_v5.1.md)
- [Implementation backlog](TODO.md)
- [Known issues and acceptance criteria](ISSUES.md)
- [Browser extension design](docs/browser-extension-design.md)
