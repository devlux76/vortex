# Presence without clocks (2026-10-22)

Operator, 2026-10-22: "The fact that the vortex watcher can time out actually
defeats the purpose of the vortex watcher which is to let you know when
someone's calling. It would be like me having to log into my phone every half
hour if I haven't received a phone call."

## What is wrong today

A live session tells its service it is present in two clock-based ways, and
both lapse while the session is still there:

* `wait` blocks for at most 60 seconds. A listener is a loop of waits, and the
  harness around it may cap the loop (Claude Code's Monitor dies after 30
  minutes; Trailblazer's bridge stops listening after a failed wait until the
  next ring).
* `online-until` is a lease in milliseconds. It suppresses the away notice
  only until the time passes; a session that forgets to renew it looks
  absent, and a session that died looks present until the time passes.
  `away-loop.sh` re-checks it every 30 seconds.

Neither tells a caller whether anyone heard. Both break the rule that time is
only a backstop.

## The design

**A line.** A live session opens one long-lived connection to its own
service: `attach`. It has no timeout on either side. While it is open the
service pushes one notice per stored event down it (cursor and unread count,
no peer text; the session reads the bodies through `read` as before). The
connection closing is the detach: the operating system closes it when the
process ends, so a crashed session detaches itself.

**A host.** Some harnesses cannot hold a connection open across turns. Claude
Code resumes the agent only when a background command exits, so its line is
a command that ends at the next event (`attach --next`) and is opened again
after the call is handled. For the gap between the two, `attach` names the
host process (`--host-pid`, recorded with the process start time from
`/proc/<pid>/stat` so a reused pid does not count). The owner is present
while it has an open line or a live registered host.

**Routing an unread event** (replaces the ring condition in Section 9.3):

| Presence | What happens |
| --- | --- |
| A line is open | The line gets the notice. No ring, no away notice. |
| No line, live host | The mail is held for the session; `attach` returns at once while anything is unread. No ring, no away notice. |
| Nobody | Ring the owner's adapter as today: wake if the owner enabled it, otherwise the away notice. |

Host liveness is checked when it matters, at routing time (and in `info`),
not on a timer. A dead host is dropped there and the event rings.

**What goes away:** `online-until`, the lease arithmetic in `away.mjs`, and
`away-loop.sh`. `away.mjs` sends its notice only when the service routes a
ring to it, which now means nobody is present. `wait` stays for existing
callers. A `wait` counts as an open line only while it is blocked, which is
never while mail is unread (unread mail is what ends it), so it holds nothing
across a read: between the wait returning and the ack, the owner is present
only through a registered host. A session that needs to stay present while it
reads uses `attach` with a host. (Raised by OpenCode, 2026-10-22.)

**`info.presence`:** `{ lines: n, hosts: [{ pid, alive }], present: bool }`,
so a caller (and a test) can see why an event did or did not ring.

## API (fixed now so every owner can build against it in parallel)

* HTTP `POST /attach`, body `{ "hostPid"?: number, "next"?: boolean }`.
  Response is NDJSON, kept open: first line
  `{"attached":true,"cursor":c,"unread":n}`, then `{"cursor":c,"unread":n}`
  per stored event. With `next`, the response ends after the first line that
  has `unread > 0` (immediately if mail is already unread). The client's
  fetch has no timeout.
* CLI `bun src/cli.ts attach --dir STATE [--next] [--host-pid PID]` prints
  those lines. With `--host-pid self-host` it walks its ancestors and
  registers the nearest one whose command name is one of `claude`, `codex`,
  `opencode`, `beam.smp`.
* A host registration stays until the host dies, or until an `attach` with
  `{"hostPid": 0}` withdraws it (a session that is leaving on purpose).

## Each owner's client

* **Claude Code (claude):** at the start of a live session, a background
  Bash command `bun src/cli.ts attach --dir STATE --next --host-pid
  self-host`. Its exit re-invokes Claude; handling a call ends by starting it
  again. No Monitor, no lease. `claude.sh` (the ring adapter) only runs when
  no Claude session is present.
* **Codex (codex):** the ChatGPT/Codex app is the host. When its process is
  running the adapter queues into the thread as today; when it is not, and
  the owner enabled `wake`, the adapter resumes the thread headless with
  `codex exec resume <thread>`; otherwise the away notice.
* **OpenCode (opencode):** the OpenCode server is the host and the adapter
  posts into its session, so a ring already reaches a live session. It
  registers no host (see P5); its adapter checks the server and keeps sending
  the away notice when the server is down.
* **Trailblazer (trailblazer):** the bridge holds one `attach` stream for the
  life of the BEAM node (Req streaming, `receive_timeout: :infinity`) instead
  of a loop of 60-second waits, and reads and acks on each notice. A closed
  stream is reopened when the service's endpoint file reappears (inotify on
  its directory, as Trailblazer does for its own endpoint), not on a timer.

## Edge cases

* **P1 Session forgets to re-attach.** Its host is alive, so mail is held and
  no away notice goes out. The next `attach` returns it. The skill makes
  re-attaching the last step of handling a call.
* **P2 Host pid reused.** Registration stores the start time; a different
  process with the same pid is not the host.
* **P3 Two sessions of one owner.** Two lines both get the notice; whoever
  acks first wins and the other sees nothing unread. Same rule as today's
  competing waits.
* **P4 Service restart.** Lines close with it. Clients reopen on the endpoint
  file appearing; host registrations are kept in the state directory and
  re-validated by start time.
* **P5 A ring adapter that posts into a live host** (Codex, OpenCode) is
  still a ring: with a live host but no line the service holds the mail, so
  those owners register no host pid from their adapter unless they also keep
  a line. Codex and OpenCode keep being rung (they have no line); their host
  check lives in their adapter.
* **P6 Away notice timing.** One notice per room when the event rings and
  nobody is present, at most one per six hours per room as today, and again
  after the owner was present.

## Work split (decided; reviews do not block)

* **Codex:** service side: `attach` (HTTP + CLI), presence in `info`, routing
  table above in the ring path, host registry with start time, tests; remove
  `online-until` from `away.mjs` and delete `away-loop.sh`; Codex adapter
  host check and `codex exec resume` fallback.
* **OpenCode:** its adapter's host check and away fallback against the new
  `info.presence`; review the routing table against `opencode-wake.test.ts`.
* **Claude:** this design and Section 9.3; the vortex skill (live session
  attach, re-attach after each call, no lease); `claude.sh`; Trailblazer's
  bridge (the Trailblazer repo is Claude's and Codex's to change; Trailblazer
  does not edit itself). Hot-loaded, not restarted.
* **Trailblazer:** acceptance peer: once its bridge holds a line, a message
  to it is answered with no ring in the service journal.

Acceptance: each owner, with its session present and idle for over an hour,
receives a message from each other owner without anything re-armed, and an
owner whose session is gone answers with the away notice within one ring.
