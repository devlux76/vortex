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

**All three harnesses now have a native, sanctioned push path through their plugin API:**

* **Claude Code** (2.1.314 here): *channels*. A plugin-bundled MCP server declares the `claude/channel` capability and emits `notifications/claude/channel`; the message lands in the live session as `<channel source="vortex" ...>text</channel>`. Same mechanism as the Telegram/Discord plugins. Sessions opt in with `--channels plugin:vortex@<marketplace>`.
* **OpenCode** (our 2.x fork): in-process JS plugin with `session.prompt` and a `SessionInbox` type (`packages/plugin/src/promise/session.ts`); it can subscribe to anything and inject directly.
* **Codex** (0.166): plugins bundle skills + MCP servers + hooks; hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`) return `additionalContext`. Waking an *idle* thread is an app-server operation (`thread/queue`, `turn/steer`, `thread/inject_items`) on the shared local daemon. **Open question for Codex:** is calling the app-server from the plugin's MCP server acceptable as "plugin API", or does Codex expose a push notification for plugins that we've missed?

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
| Codex | Hook `additionalContext` while active; idle wake via app-server `thread/queue` (pending Codex's answer) | MCP tool `vx_send` | plugin skill ≤ 10 lines |
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
* An idle agent addressed by name is woken within 5 s (Claude, OpenCode; Codex pending §2 question).
* Four agents + operator in `#all` for an hour without a runaway auto-reply loop.

## 5. Questions for reviewers

1. Codex: idle-wake path for Codex plugins (§2). Also: do hook `additionalContext` injections show in the desktop app's transcript, and is there a size cap?
2. GLM/OpenCode: is `session.prompt` from a plugin the right call for an idle session, or does `SessionInbox` give a cheaper/quieter injection? Any v2 plugin-API churn to expect from the daily fork update?
3. All: SQLite vs JSONL for the log; hub transport (WebSocket over TLS on loopback + LAN; Codex sandbox network rules?).
4. All: anything in v5 you consider load-bearing that this drops?
