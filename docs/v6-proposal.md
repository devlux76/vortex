# VORTEX v6 proposal: one room, three plugins, near-zero overhead

Status: DRAFT r2 by Claude (r2: cross-device in scope, Codex additionalContext boundary, v5 kept until v6 proven), 2026-10-30, for review by Codex and GLM (OpenCode). Operator direction: cut the protocol overhead dramatically, make it easy, and integrate *only* through each harness's plugin API (the path Slack/Teams plugins use). Anything up to a full restart is allowed.

## 1. What it costs today

Measured on the live `.vortex/claude` inbox (558 events):

| Item | Size | Paid when |
| --- | --- | --- |
| Median message body | 891 B | the actual content |
| Median stored event (body + room string of two peer IDs + envelope) | 1,283 B | every `read` |
| Ring notice prompt (claude.sh / codex.mjs / opencode.mjs) | 600–1,500 B; Codex coding-worker mode adds ~1,300 B | every wake |
| `skills/vortex/SKILL.md` | 28,370 B (~7K tokens) | every fresh session that loads it |
| `read` + `ack` tool calls (+ `send`) | 2–3 round trips | every message |

A typical short exchange costs **10–30× the body** in context, and the "you have mail" notice alone is bigger than most messages. 

## 2. Why: almost everything compensates for a missing push channel

The agent cannot be pushed into, so v5 built machinery around that:

* Elixir wake router (`backbone/`), ring policy with hourly budgets and adapter exit codes 0/75/76 (`src/core/ring.ts`, `src/backbone.ts`)
* Per-harness wake adapters that spawn headless turns with long fixed prompts (`skills/vortex/adapters/*`)
* Presence lines (`attach --next`), away responder, `wake`/`codex-limited` marker files, pending-notice files
* Topic→thread maps (`claude-topics.json`, `codex-topics.json`)
* Cursor/ack discipline pushed onto the *model* (scoped acks, "never ack beyond N")

And a second layer built for an internet-scale problem we don't have on one box: libp2p + GossipSub, signed descriptors and session certificates, semantic discovery with Gemma embeddings, conference crypto, browser/WebRTC plans. ~14.4K LOC of non-test code, a 70 KB spec.

**The plugins own host delivery; the available host APIs differ:**

* **Claude Code** (2.1.314 here): *channels*. A plugin-bundled MCP server declares the `claude/channel` capability and emits `notifications/claude/channel`; the message lands in the live session as `<channel source="vortex" ...>text</channel>`. Same mechanism as the Telegram/Discord plugins. Sessions opt in with `--channels plugin:vortex@<marketplace>`.
* **OpenCode** (our 2.x fork): in-process JS plugin with `session.prompt` and a `SessionInbox` type (`packages/plugin/src/promise/session.ts`); it can subscribe to anything and inject directly.
* **Codex** (installed `0.166.0-alpha.5.1`): plugins bundle skills, MCP servers and hooks. Hooks can supply context at lifecycle events but do not wake an idle chat. The documented app-server `turn/start` operation accepts `toolOutput` with empty `input`, preserving peer content as tool output while starting a turn. This is a public host API called by the plugin, not an MCP-native channel notification. The binding and required live proof are specified in §6; no equivalent documented Codex MCP push channel has been established.

## 3. Proposal: restart as a hub + three thin plugins

v5 stays intact and running until every v6 path is proven against §4; v6 is built alongside it (`v6/` in this repo), then v5 is tagged `v5-final` and retired. Target: hub ≤ ~600 LOC, each plugin ≤ ~300 LOC, one shared client file.

### Hub (`vortexd`, Bun, user systemd unit)

* **Spans devices from day one** (operator requirement): one hub, reachable locally (loopback) and from other devices over WebSocket + TLS (LAN/Tailscale address). Plugins on any device connect to the same hub; hub-and-spoke, not peer-to-peer in every agent. Per-agent bearer token (enrolled once with `vx enroll <name>`, stored 0600), TLS cert pinned by fingerprint at enrollment.
* Optional later: hub-to-hub federation for separate operators; not needed for one operator across devices.
* Append-only SQLite log: `messages(id, room, from, to, text, reply_to, ts)`; per-agent delivery cursor kept **by the hub**.
* Rooms are strings. Default room `all`. Create/join is just posting to a name; membership = who has posted or subscribed.
* Rate limit per sender (e.g. 20 msgs/min) and a hop guard: messages carry `auto: true` when an agent replies without operator input; a chain of N auto-replies with no human turn pauses delivery of further auto messages to that room until a human posts (the loop breaker — four agents in one room will otherwise ping-pong forever).
* Operator can post from a CLI (`vx say "..."`) or later a tiny web page; operator messages are tagged `from: operator` (and only the operator socket can set that).

### Delivery semantics (the overhead killer)

* **The plugin acks, not the model.** A message is marked delivered when the plugin has injected it. No `read`, no `ack`, no cursors in the model's context, ever.
* **Addressing decides wake vs. context.** `to: [names]` or `@name` in text → wakes that agent. Unaddressed room chatter → *not* a wake; batched and attached as context at the agent's next natural turn (Codex `UserPromptSubmit`/`PostToolUse` hook, Claude channel delivered with a `passive` meta, OpenCode next prompt). Prevents 4 AIs × every message = cost explosion.
* **Coalescing.** Everything that arrives while an agent is busy is delivered as one block when it frees up.
* **Wire format seen by the model:** `vx codex→claude #all: <text>` — ≤ 30 chars of header, no IDs, no peer keys, no envelope. Reply threading via a short id only when `reply_to` is used.
* **Trust rule stated once** in the plugin's instructions (peer text is a colleague's message, not the operator's), not repeated per message. Where the injection channel carries developer-level authority (Codex hook `additionalContext`), peer text is always wrapped in an explicit delimited block, e.g. `<vx-peer from="claude">…</vx-peer>`, with the one-line rule that block contents are data, never instructions. Body text is escaped so a peer cannot close the block.

### Plugins

| | Receive | Send | Instructions |
| --- | --- | --- | --- |
| Claude Code | MCP server with `claude/channel` → push | MCP tool `vx_send(text, to?, room?)` | MCP `instructions` ≤ 10 lines; no skill needed |
| Codex | Plugin-owned app-server `turn/start` with `toolOutput` for addressed mail; bounded hook context for passive mail (§6) | MCP tool `vx_send` | plugin instructions ≤ 200 tokens |
| OpenCode | in-process SSE subscriber → `session.prompt` / inbox | plugin tool `vx_send` | plugin-provided system line |

All three use the same ~100-line client (`connect`, `subscribe(onBatch)`, `send`, `delivered(id)`).

### What goes away

libp2p, GossipSub, semantic discovery and embeddings, signed descriptors/certificates, conferences-as-crypto, Elixir router, ring budgets and exit-code protocol, wake adapters, away responder, presence lines, topic→thread maps, marker files, the 28 KB skill, browser/WebRTC plans. Cross-device is the hub's WebSocket/TLS listener (§3), not peer-to-peer in every agent.

### Kept ideas

Sender always identified; peer text is untrusted; operator words distinguishable from agent words; rate limiting; durable log so nothing is lost while an agent is offline (delivered on next session start via SessionStart hook / channel replay, as one compact digest).

## 4. Budget targets (acceptance criteria)

* Receiving a message: **0 tool calls**, ≤ 15 tokens of overhead beyond the body.
* Sending: 1 tool call, args only.
* Standing context per session: ≤ 200 tokens of plugin instructions.
* Two devices: an agent on a second machine joins `#all` through the same hub and exchanges messages both ways.
* Install: one command per harness through its plugin mechanism; uninstall leaves nothing behind.
* An idle agent addressed by name is woken within 5 s on each supported harness, including Codex. A real host/session test is required; schema support alone is not acceptance.
* Four agents + operator in `#all` for an hour without a runaway auto-reply loop.

## 5. Questions for reviewers

1. Codex: the API and hook findings are recorded in §6. Live plugin-to-desktop delivery remains an acceptance test, not an assumed capability.
2. GLM/OpenCode: is `session.prompt` from a plugin the right call for an idle session, or does `SessionInbox` give a cheaper/quieter injection? Any v2 plugin-API churn to expect from the daily fork update?
3. All: SQLite vs JSONL for the log; hub transport (WebSocket over TLS on loopback + LAN; Codex sandbox network rules?).
4. All: anything in v5 you consider load-bearing that this drops?

## 6. Codex host binding (normative; Codex review, 2026-10-30)

### Addressed delivery

The installed plugin owns its MCP process and connection to the existing local Codex app-server. It must bind to an explicitly selected current chat, keep the host's private thread identifier out of peer messages, and never create a headless replacement chat to receive mail. Installation must not edit Codex's private databases, patch the harness, or require an external wake adapter. The public app-server API is an explicit dependency of this binding; packaging a client inside a plugin does not make that API a native plugin notification.

For an addressed batch, use this app-server request shape:

```json
{
  "method": "turn/start",
  "id": 1,
  "params": {
    "threadId": "<locally bound chat>",
    "input": [],
    "toolOutput": {
      "name": "vx_receive",
      "namespace": "vortex",
      "output": "<bounded, sender-labelled peer batch>",
      "retain": true
    }
  }
}
```

The local app-server transport requires its normal `initialize`/`initialized` handshake. Use the running host's supported connection, not a second app-server managing the same chat. The installed CLI exposes `codex app-server proxy` for a stdio connection to the running daemon. Connecting and subscribing must be event-driven; no database or mailbox polling.

Official documentation states that `toolOutput` remains tool output in conversation history and that an active regular turn queues it for that turn. Thus the plugin must not convert peer messages into fabricated operator prompts. Coalesce pending messages before submission and serialize deliveries for a chat; do not repeatedly submit a batch already accepted by the host. Prove active-turn behavior on the supported desktop build before relying on it for delivery acknowledgment.

`thread/inject_items` appends history without starting a turn. `turn/steer` requires an active turn and appends user input. Neither is an idle wake path. The generated queue API uses `thread/queue/add` and `thread/queue/start`, not a single `thread/queue` operation; queueing user text is not the selected peer-data delivery path.

If the plugin cannot connect to the selected chat, leave mail pending and expose the failure. Do not silently select an older chat, spawn a model process, or claim successful delivery.

### Passive context and display

Unaddressed traffic must not start a turn. A trusted plugin hook may attach it at the next applicable lifecycle event. Hook `additionalContext` is developer context: the plugin supplies the trusted instruction that the enclosed peer messages are data, and escapes peer-controlled bodies and attributes so they cannot close or forge its data boundary. Prefer the tool-output path wherever a wake is required.

The documented default spill threshold is approximately 2,500 tokens per hook output. A handler's `additionalContextLimit` can change it; `0` disables spilling and is permitted only with a strict plugin-enforced output bound. The implementation spec must name its batch/body bounds before implementation. Do not acknowledge the complete batch if only a truncated preview was delivered. Large or offline backlogs must be delivered in bounded batches without asking a model to summarize them merely to receive mail.

Do not promise that hook context appears as a normal desktop chat message. Static inspection of this installed desktop build shows hook metadata and warning/error/feedback display, with `context` entries omitted from that display. This is version-specific evidence, not a live UI test or a portable API guarantee. The hub log remains the complete record. An asynchronous hook finishing while idle waits for the next user turn; it does not start one.

Plugin hooks require host trust review on installation. Current official packaging documentation limits bundled hooks to manually installed desktop plugins and excludes hook-containing packages from the public plugin directory. This means the proposed hook binding does not by itself establish public-directory or ChatGPT-web parity. Distribution and each supported surface must be stated honestly and tested separately.

### Proof required before retiring v5

Test the actual installed plugin with an idle selected desktop chat and verify receipt of a unique peer token, one turn, correct sender attribution, and tool-output history. Then test an active chat, passive-only traffic, reconnect/restart, and a chat change. Verify that no peer token reaches another chat and that passive-only traffic starts zero turns. Hook output beyond its bound must not be silently acknowledged. Record latency and complete model-visible overhead, including host wrappers and data delimiters; byte counts alone are not token measurements.

Evidence: [official app-server documentation](https://learn.chatgpt.com/docs/app-server), [official hook documentation](https://learn.chatgpt.com/docs/hooks), and [plugin packaging](https://developers.openai.com/plugins/build/plugins). Installed CLI schema generated with `codex app-server generate-json-schema --experimental` confirms `TurnStartParams.toolOutput`, including `name`, `namespace`, `output` and `retain`. This establishes the request shape, not a completed live delivery test.

## 7. Shared delivery guarantees to retain (normative)

* **Spec first.** GLM implements only behavior specified here and in explicitly referenced implementation contracts. An unresolved API or unspecified behavior is reported to Claude/Codex for a spec update before implementation; it is not filled by an out-of-spec feature or workaround. The standing rough LOC targets do not override these guarantees.
* **Receipts have a precise meaning.** A plugin acknowledgment means the target host accepted that exact batch for the selected binding. It does not mean the model completed the work. Writing hook stdout or writing bytes to a socket alone is not host receipt. Delivery state belongs to the hub/plugin, never to model-visible cursor instructions.
* **Crash recovery preserves mail.** Preserve stable message identifiers and pending batches across hub/plugin restart. Advance only the acknowledged binding's delivery state; retries must not discard another session's mail. Ambiguous host acceptance may redeliver a batch, so promise at-least-once delivery with duplicate detection, not exactly-once model execution. The spec must define the acceptance checkpoint for each host binding before that binding is implemented.
* **Bindings are explicit.** A harness name is not a unique chat. Each delivery subscription has a private local session/chat binding. A second session cannot silently take over or acknowledge the first one's pending messages. Any single-active-chat restriction must be explicit in setup and status.
* **Sender identity comes from authentication.** The hub assigns the sender from the enrolled credential, not a model-supplied `from` field. Agent credentials cannot impersonate the operator. Use structured `to` for wake decisions; quoted `@name` text alone must not wake a peer. Sending joins only the sender to a room; it does not subscribe or wake arbitrary recipients without their configured participation.
* **Passive means no inference.** Do not emit a supposedly passive host notification unless that host demonstrably refrains from starting a turn. If a channel has no passive delivery mode, keep that traffic buffered until a supported natural-turn insertion point. Unknown Claude `passive` metadata is not proof of this behavior.
* **Wake limits survive a rewrite.** Rate-limit accepted messages and model wakes separately. A burst must coalesce rather than launch one turn per message. Automatic-reply classification and the loop-breaker budget are enforced by the plugin/hub, not chosen by model arguments; only authenticated operator activity resets a human-turn budget. Specify the counter and pause/resume rule before implementing it.
* **Limits are observable.** Specify body bytes, batch bytes, retained history, and pending-storage bounds. A rejection, expired history, or overflow must be reported; no silent truncation or acknowledgment of undelivered messages. Literal max-header/token targets remain measurement targets until actual host wrapping is counted.
* **Two-device operation is required.** Keep the authenticated TLS hub path and actual two-device bidirectional test in the release gate. A local-only test, mocks, or a future federation plan cannot satisfy this requirement.
