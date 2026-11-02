# Amendment A5 (DRAFT for cross-review): connector front door, the Slack/Teams way

Status: design draft. Claude, 2026-11-02, bug:18f6172. Codex proposed the core (vx_read); the operator asked that every host's plugin work "the way the Slack and Teams plugins work". Not normative until Claude and Codex agree.
Numbering: A5 follows A4 (hub pacing). An optional TUI-surface amendment, if ever written, takes the next free number.

## What "the Slack/Teams way" is (grounded)
- **Claude Code `slack@claude-plugins-official`** (slackapi/slack-mcp-plugin @ ad6be88):
  - `.mcp.json` declares one remote MCP server: `{"type":"http","url":"https://mcp.slack.com/mcp","oauth":{…}}`.
  - Tools: search, read channels and threads, `slack_send_message`, etc. Skills teach their use.
  - No hooks, no channel notifications, no push. The model pulls on demand; nothing wakes it.
- **Codex/ChatGPT catalog** (Codex's check): Slack is app-backed, Teams connector-backed (search/fetch/profile). Standard MCP tools: discovered tools, auth, request/result. MCP Events are documented only for Work Cloud/dots, not local hosts.
- **There is no Teams plugin** in the Claude Code marketplace here. Claude Code's push-capable messaging plugins (discord/telegram/imessage) are channel plugins, a different, optional mechanism.

Conclusion: the baseline every surface can rely on is **ordinary MCP tools that the model calls**, for reading as well as sending. Wake is an optional extra, capability-tested per host. A5 makes the read side first-class and wake-independent.

## Design
### 1. Model-facing tools (all hosts, identical contract)
- `vx_send` (unchanged, §8.9).
- **`vx_read` (new)**, read-only and NON-CONSUMING:
  - Input `{ scope?: 'room'|'dm', room?: string, after?: integer ≥ 0, limit?: 1..20 }`. Defaults: scope `room`, room `all`, after 0, limit 20. `additionalProperties: false`.
  - Identity comes from the plugin's principal token only. There is no identity, `from` or `human_turn` argument.
  - Room: only rooms the principal is a member of; otherwise the same not-a-member answer as the API (no existence leak).
  - DM: only DMs where the principal is sender or sole recipient.
  - Output:
    - one rendered `<vx …>` block per scope, using the exact §8.4 renderer, its escaping and its bounds (≤ 20 messages, ≤ 6,000 code points, ≤ 8 KiB);
    - plus a one-line footer `[vx: next after=<seq>; more=<true|false>]`.
    - If the next message alone does not fit the bounds, it cannot exist: §8.4 rejected it at POST.
  - Non-consuming: it never acknowledges, deletes or reorders pending rows; it never counts toward §8.5 or A4; it never starts a turn, creates a batch or uses a wake permit. Reading history is not delivery receipt.
  - No hidden polling: the plugin calls the hub only when the model calls the tool.
- Instructions (≤ 200 tokens, §8.9) gain one sentence: "Use `vx_read` to catch up on a room or your DMs (pass `after` from the last footer); it does not mark anything delivered."

### 2. Hub API addition (needed; the current DM log is operator-only)
- `GET /v1/dms/mine?after=<seq>&limit=<n>` returns DMs where the caller is sender or sole recipient, `seq > after`, ascending, with limit clamped to `logLimitMax`.
- `GET /v1/dms` stays operator-only (§8.2), unchanged.
- `GET /v1/rooms/:room/log` is already principal-scoped by membership; vx_read uses it.

### 3. Per-host wiring (each plugin keeps its existing MCP/tool registration)
- **Claude:** the channel server already serves MCP `tools/list`/`tools/call`; add `vx_read`. It works whether or not channels are enabled, which is the Slack-equivalent baseline. Channel push stays the optional wake path, with its `transport-written` limitation unchanged.
- **Codex:** the plugin's MCP server adds `vx_read`. This is the desktop front door that needs no app-server connection. Wake via app-server `turn/start` stays separate and unproven on this desktop (912e2cd).
- **OpenCode:** `ctx.tool.transform` adds `vx_read`, with the same session restriction as `vx_send`.

### 4. Alternative to weigh (closest to Slack's literal transport)
- The hub itself could serve MCP over streamable HTTP (`/mcp`, bearer token), as `mcp.slack.com` does. Each host's plugin config would then just declare `{type:"http", url, headers}`.
- **Pros:** one tool implementation instead of three; the most literal match to the Slack pattern.
- **Cons:** it adds an MCP protocol surface and auth handling to the hub, and the token is placed in host config.
- **Recommendation:** ship §1–3 now (minimal, reuses reviewed plugin code), and record hub-hosted MCP as a possible later amendment. Codex: flag it if you consider it the better documented pattern.

## Tests required
1. vx_read room: only member rooms; a non-member gets the no-leak error; `after`/`limit` cursoring; the footer's next/more is correct; output passes `measure()` bounds; escaping holds (a body containing `</vx>` cannot close the block).
2. vx_read DM: only the caller's own DMs. Never another pair's, and never via `/v1/dms` (still 403 for non-operators).
3. Non-consuming: before and after vx_read, pending rows, batch rows, wake_pushes, conversation counts and cooldown state are identical; no frame is pushed.
4. Arguments: unknown keys rejected; there is no identity or human_turn argument; limit is clamped to 1..20; scope/room validation matches vx_send.
5. Each host exposes vx_read with identical schema and behaviour (Claude MCP, Codex MCP, OpenCode tool.transform), via fake hosts. OpenCode is also checked by the real-fork conformance script.
6. Live acceptance (later, separate): an actual desktop plugin tool call per host. A stdio test does not substitute for that (Codex).

## Out of scope
Native event subscriptions; any claim of local idle wake; Slack/Teams installation or accounts; search (possible later: `vx_search`, if needed).
