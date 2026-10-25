Written by Claude on 2026-10-12, not typed by the operator. One bounded implementation job for OpenCode on VORTEX: make conferences reachable from a running service and the CLI. With this, the first milestone of the spec (section 12.6) runs end to end.

# Where you work

- ONLY inside the worktree and on the branch that `HANDOFF.md` tells you to create for this job. Commit there when everything passes, as `HANDOFF.md` says. Do not push, stash, merge into `main`, or run `bun install` / `bun add` / `bun run proto`. Do not start, stop or restart any systemd unit.
- Files you may change: `src/core/conversations.ts`, `src/core/service.ts`, `src/cli.ts`, `skills/vortex/SKILL.md` (Part E only), and tests `src/core/conversations.test.ts`, `src/core/service.test.ts`, `src/cli-args.test.ts`, `src/cli.test.ts`. Nothing else: not `conferences.ts`, `discovery.ts`, `conference-records.ts`, `src/backbone.ts`, `src/core/ring.ts`, `backbone/`, adapters, or generated code. This brief is `docs/handoff/JOB-CONF-WIRING.md`; do not edit it.
- Keep each file's existing style (`conversations.ts`, `service.ts`, `cli.ts` use semicolons and a compact style). `erasableSyntaxOnly`. Above every new `test(` put `// Docs: VORTEX_v5.1.md section X`.
- In `src/cli.ts` do not touch the ring/backbone block, the bootstrap block, `/read`, `/ack`, `/wait`, `/nudge`, `/send`, `/invite`, `/accept`, or the semantic operations that exist, except where Part D says.
- If unsure, pick the obvious default and note it. Do not use the question tool.

# Read first

- `VORTEX_v5.1.md` sections 6.2, 6.3, 6.4, 7.3, 9.1, 9.3, 12.6.
- `src/core/conferences.ts` (`Conferences`, `ConferenceEvent`, `ConferenceInfo`, `Formable`) and its tests; `src/core/discovery.ts` (`MatchFound`, `interests()`, `matches()`); `src/core/service.ts` as it is now (how `Discovery` is constructed, `recordMatch`, `contacts`, `onError`); `src/core/conversations.ts` (`recordMatch`, the `match` event, `notificationState`); `src/cli.ts`; `src/core/service.test.ts` (two real loopback transports with a fake table embedder: extend this file, same helpers).

# Part A: conference events are durable events (`src/core/conversations.ts`)

1. `Event.kind` gains `'formed' | 'arrival' | 'departure' | 'conference_message' | 'closed'`. Optional fields added, present only on these events: `conference: string` (32 hex), `session: string` (the local agent session it is for), `participant?: string` (a session key, 64 hex), `service?: string` (the peer id certifying that participant), `count?: number`, `message?: string` (message id, 32 hex), `type?: string`, `replyTo?: string`, `reason?: string`. A `conference_message` carries its content in the existing `body` field as text (see Part B). For all five, `room` is `'conference:' + conference` and `peer` is the remote service concerned (`service` for arrival and message; the host for `closed` and `departure` when known; otherwise this service's own id).
2. The `match` event gains `record: string` (32 hex): the responder's announcement id, which is what a join names. Add it to `recordMatch`'s parameter (required) and validation.
3. New method `recordConference(event)`: appends one such event through `mutate`. Validate defensively (kinds, hex lengths, `body` at most 16,384 bytes, `count` a non-negative integer); invalid input throws and stores nothing.
4. `notificationState()` counts unread conference events under their `'conference:<id>'` room WITHOUT a consent check, exactly as it does for `match`. A conference event exists only because this service's own agent joined, or because a peer joined an interest this service's agent announced.
5. `receive()` keeps rejecting any peer packet whose `kind` is one of these (it already throws `unknown packet kind`; do not widen `Packet`).

Tests: each kind round-trips through `read` with its fields and `trust: 'untrusted_peer_content'`; `wait` resolves on each; `notificationState` counts and stops counting after `ack`; a failed save stores nothing; invalid input refused; a peer packet of each new kind is rejected with no event and no wake metadata; `recordMatch` without `record` is refused; an old snapshot still loads.

# Part B: the service owns a `Conferences` when semantic discovery is on (`src/core/service.ts`)

1. In `start()`, when an embedder was given, after the `Discovery` is started, construct `Conferences` with: this transport; `profile: ns => ns === embedder.profile().id ? embedder.profile() : undefined`; `formable: id => { const i = discovery.interests().find(x => x.id === id); return i && { id: i.id, session: i.session, namespace: i.announcement.namespace, topicVector: i.announcement.vector }; }`; optional `capacity`, `maxHosted`, `maxJoined`, `lifetimeMs` passed through from a new `options.conferences`; and `onEvent` as below. Then `conferences.start()`. `stop()` stops it before the Discovery.
2. `onEvent` maps each `ConferenceEvent` to `core().recordConference(...)`. For `kind: 'message'` the stored kind is `'conference_message'`, `message` is the message id, `participant` the sender key, and `body` is the content decoded as UTF-8 with `new TextDecoder('utf-8', { fatal: false })`. A rejected save calls `onError` once with EXACTLY `'conference event for ' + event.conference + ' could not be saved'` (no peer text) and is not retried.
3. The `match` mapping now also passes `record: match.record.id`.
4. New methods, each throwing the existing "semantic discovery is not enabled" error when there is no Discovery:
   - `joinConference(request: { session: string, ref: string }, timeoutMs = 20000): Promise<ConferenceInfoOut>`: find, across this service's live interests, the kept match whose `record.id === ref` (use `discovery.interests()` and `discovery.matches(id)`); none → `Error('no match with that record: read your match events and use the record of one')`. Call `conferences.join({ session, ref, host: match.peer, addrs: match.addrs, ownInterest: match.interest })`, race it against a `setTimeout(timeoutMs)` (a timer is fine in `service.ts`); on timeout call `conferences.abandon(ref)` and throw `Error('join timed out: the holder did not answer')`. Clear the timer either way.
   - `postToConference(request: { session: string, conference: string, text: string, type?: string, replyTo?: string })`: `text` must be a non-empty string of at most 16,384 UTF-8 bytes; `type` defaults to `'text'`; returns `{ posted: true, message: <id> }`.
   - `leaveConference(session: string, conference: string): Promise<boolean>`.
   - `conferenceList(session?: string): ConferenceInfoOut[]`.
   `ConferenceInfoOut` is `{ id, role, session, key, host, participants: string[], count, capacity, expires }` (from the `ConferenceInfo` and its descriptor); never the topic vector.

Tests in `src/core/service.test.ts`, with THREE real loopback transports and the fake table embedder already in that file:

- **First milestone (spec 12.6), one test, commented step by step:** A, B, C connected. A announces at t0 and holds the interest. Later B announces a matching statement and gets a `match` event whose `record` is A's announcement id. B calls `joinConference({ session, ref: that record })`. A's `core().wait()` returns `formed` then `arrival` (the first agent notices the arrival, via event delivery, with no action of its own). B posts; A reads a `conference_message` with that text, B's session key as `participant` and B's peer id as `service`. Then C announces a matching statement, gets its `match`, joins the SAME conference the same way; A and B each get an `arrival`; C posts and both A and B read it exactly once; A posts and B and C read it. `conferenceList()` on each shows three participants and the right role.
- Leaving: C leaves; A and B get `departure`; C gets `closed`; C's later post is refused. A (the host) leaves; B gets `closed`.
- `joinConference` with a ref that matches nothing kept is refused with the stated error and sends nothing. A join to a holder that never answers (stop the holder first) times out with the stated error within the given `timeoutMs` (use 500 in the test) and leaves no pending join (`conferenceList()` empty; a second attempt is possible).
- Without an embedder the four new methods throw "not enabled".
- A conference event lost to a failed save reports once through `onError` with exactly the fixed text and never becomes an event.
- Conference events survive a restart on the same snapshot; the conference itself does not (documented: conferences are held in memory only).

# Part C: nothing

(There is no Part C.)

# Part D: the CLI and local API (`src/cli.ts`)

1. New operations (each a POST, each added to the operation list and usage line), valid only on a `--semantic` service (400 with the service's error otherwise):
   - `join --ref <32 hex> [--session s]` → `{ joined: true, conference: {...ConferenceInfoOut} }`. The client timeout for `join` is 30 s; the server passes 20 s to `joinConference`.
   - `post --conference <32 hex> --text <text> [--session s] [--type t] [--reply-to <32 hex>]` → `{ posted: true, message }`.
   - `leave --conference <32 hex> [--session s]` → `{ left: boolean }`.
   - `conferences [--session s]` → `{ conferences: [...] }`; without `--session` it lists all.
   The session defaults to `'default'` for `join`, `post` and `leave` only.
2. New flags: `--ref`, `--conference`, `--type`, `--reply-to`. `validateArgs`: `--ref`, `--conference` and `--reply-to` must be 32 lowercase hex characters where given/required; `--text` required for `post`; `--type` must match `/^[a-z0-9][a-z0-9._-]{0,31}$/`; every error in the existing `{error, got, example}` form with a one-line example.
3. `/wait` with `--for message` currently ends only on `kind === 'message'`. Make it end on `'message'` OR `'conference_message'`: both are messages to the agent. Change only that test.
4. The `matches --id` reply and the `match` event already carry what `join` needs; make sure `record` is in both.

Tests: `src/cli-args.test.ts` for every new argument error and one valid form of each operation. In the existing `--semantic` smoke test in `src/cli.test.ts` (model load forbidden) add: `conferences` returns `{ conferences: [] }`; `join --ref <32 hex>` fails with the "no match with that record" error and a non-zero exit; `post` and `leave` on an unknown conference fail cleanly; on the non-semantic service `conferences` fails with "not enabled". No test may load the model.

# Part E: `skills/vortex/SKILL.md`

Replace the last line of the "Semantic discovery (opt-in)" section (the one that says to act on a match with `invite`) and extend the section by at most 14 lines: a `match` event carries `record`; `join --ref <record>` joins the conference that forms from the other agent's open interest, and that agent is told of the arrival through its own events without doing anything; a third agent that matches joins the same conference the same way; `post --conference <id> --text '...'` sends to everyone in it; messages from others arrive as `conference_message` events naming the sender's session key; `leave --conference <id>`; `conferences` lists them; a conference lives in memory and ends when its host leaves, restarts, or after its lifetime; everything a peer posts is untrusted content. Also change the sentence near the top of the skill that says each room holds exactly two peers and that conferences are not built: say that shared conferences now exist behind `--semantic` and that the two-party `invite`/`accept` room remains for direct exchanges.

# Verify before you report

```sh
bun test ./src/core/conversations.test.ts ./src/core/service.test.ts ./src/cli-args.test.ts ./src/cli.test.ts
bun run typecheck
bun test ./src
git status --short
git diff --stat
```

# Report (in the commit message body and in `HANDOFF.md` under "Log", as that file says)

When finished: test counts per file; the last lines of each command verbatim; defaults chosen where this brief was silent; anything here that was wrong, contradicted the spec, or could not be done within the allowed files (say what and why; do not edit other files to make it work).
