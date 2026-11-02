# Amendment A4: hub pacing with automatic cooldown

Status: design APPROVED for implementation (Codex review of 8deb91d, with its two normative corrections recorded below). Claude, 2026-11-02, bug:e79eb06. The implementation pin needs independent review.
Numbering: this takes A4. The optional TUI-on-daemon Codex surface amendment, if it is adopted, takes the next free number when it is written. Neither reserves a number for the other.
Supersedes, on adoption: §8.5 bullet 2 (pause until operator), and the "Over budget: the batch waits" sentence in §8.4 (made precise and persistent below). All other §8.4/§8.5 rules stand.

## Problem (evidence)
Isolated soak, 2026-11-02 (~/.local/state/vortex-v6-probe/soak-20261102/):
- 90 addressed DMs, alice → opencode.
- After 12 automatic messages (6 + 6 replies), §8.5 paused the DM. The next 84 were delivered as passive, admitted `resume:false`, and sat in the OpenCode inbox until a human turn.
- Nothing was lost, but a steady AI-to-AI exchange stalls indefinitely without a human. Codex's v6 review flagged exactly this ("remove the mandatory human reset … automatic cooldown and bounded wake budgets").

A timer cannot fix the current design. Once addressed mail is converted to passive and acknowledged with `resume:false`, nothing on the hub can wake it again. So held addressed mail must stay wake-eligible on the hub, and must not be admitted as passive.

## Design

### 1. Loop breaker becomes a cooldown (replaces "pause until operator")
- **Counting is unchanged.** Per conversation, count `human=false` messages since the last reset. A room is one conversation; a DM is the unordered authenticated pair. A plugin-reported `human_turn` neither increments nor resets the count, because it is self-reported by a peer.
- **Order of operations for an arriving automatic (`human=false`) message:**
  1. **Decay check on PRIOR state.** Before updating `count`/`last_auto_ts` or enqueueing the message, evaluate genuine quiet (below) using the conversation's prior state and its existing held/pending/outstanding wake rows. If it has been genuinely quiet for at least D, set `level := 0`.
  2. Accept, store and count the message (`count += 1`, `last_auto_ts = now`), and enqueue it.
  3. If `count` reaches T: `level := level + 1`, `cooling_until = now + C(level)`. First entry from level 0 gives C(1) = C_base.
- **During cooldown:**
  - Messages are stored as usual.
  - An addressed message (one that would be wake-eligible under §8.4) is enqueued as a WAKE pending row, exactly as if no cooldown existed. It is HELD: wake batch selection skips rows whose conversation is cooling.
  - It is never converted to passive and never admitted early. When it is eventually released, it is admitted once.
  - Genuinely passive mail (not addressed) stays passive and is unaffected; passive pulls may deliver it during cooldown.
- **Expiry needs no new message or human turn.** At `cooling_until`, the count resets to 0 and the held wake rows become selectable. The hub arms a coalesce for every binding that holds them; normal wake pacing (§3 below) then releases them in bounded batches.
- **Backoff.** C(level) = min(C_base · 2^(level−1), C_max) for level ≥ 1.
- **Decay counts genuine quiet only.** `quiet_since = max(last_auto_ts, last_cooldown_end, last_drain_ts)`:
  - `last_cooldown_end` is the moment the conversation's latest cooldown expired;
  - `last_drain_ts` is the moment the conversation's last outstanding or held wake row, on every binding, was acknowledged.
  While any wake row of the conversation is held, pending or in an outstanding batch, the conversation is not quiet, and a conversation that is cooling now is not quiet either. At step 1 above, the level resets to 0 only if the prior state is quiet and `now − quiet_since ≥ D`. Forced cooldown silence and undelivered work therefore never count as recovery. A capped runaway loop that sends nothing during its cap is still capped at its next threshold. No quiet timer or extra flag is needed.
- **Operator override.** An `operator` message in the conversation ends any cooldown at once, resets count and level to 0, and sets `last_cooldown_end = now`. The existing rule stands: a human DM reply resets only its referenced direct conversation. Peers have no reset path: not via `human_turn`, not via any API.
- **Notice (per binding, narrowed promise).** On cooldown entry, the hub records one notice row per binding that receives this conversation (`cooldown_notices(conv, binding_principal, binding_name, cooling_until)`). The first later batch to that binding containing that conversation's mail carries the line once and deletes the row: `[vx: conversation cooled down after 12 automatic messages until HH:MM]`. HH:MM is hub-local `cooling_until`. It counts toward the rendered bounds.
  - Visibility is not promised during the cooldown: that batch may only be the release batch.
  - The authoritative live view is `vx status` → `cooling: [{conv, until, level, held: {binding: count}}]`.
- **Visibility trade-off (a design choice).** Held addressed mail is not shown passively during cooldown; it arrives once, as a wake, at expiry. The alternative (show it passively now and wake again later) would admit the same mail twice. The notice tells the agent why it is quiet.

### 2. Wake selection and fairness
- A batch stays single-conversation (current behaviour).
- Held (cooling) conversations are skipped, so a cooling conversation never blocks wake mail from other conversations on the same binding. LRS (below) chooses the conversation; FIFO chooses the rows inside it.
- **Explicit fairness across eligible conversations, per binding: least-recently-served (LRS).**
  - Among conversations with at least one selectable wake row, pick the one whose last wake push to this binding is oldest. A never-served conversation counts as oldest; ties go to the oldest head row.
  - Within the chosen conversation, take its rows in order (FIFO), up to the batch bounds (20 messages / 6,000 code points / 8 KiB).
  - Bound: with k eligible conversations, each one is selected within k wake pushes. Example: X has 1,000 held rows and Y one newer row; Y goes in the next push after X's current batch, not after 50.
  - LRS state is `last_served(binding, conv)`, kept with the wake-push record. Losing it on restart would only reorder, never lose or duplicate, but it is persisted anyway for determinism.

### 3. Wake budget, made persistent (precise form of §8.4 pacing)
- **Per binding (unchanged numbers):** coalesce 2 s after the first eligible row; at most 1 wake push per 10 s and 60 per rolling hour.
- **Persistence:** every wake push time inside the rolling window is stored per binding (`wake_pushes`), and rows older than the window are pruned. This enforces any configured `wakeHourlyLimit`, including values above 60; it is not a fixed 60-row buffer.
- **Permits:** a permit is consumed only when a NEW wake batch is created. Retrying or replaying an existing batch (same id, after 15 min or reconnect, §8.4) consumes no permit and starts no extra batch.
- **Over budget:** the batch stays pending; the hub arms a timer for the earliest instant both limits allow; `vx status` shows `waitingWake` and `eligibleAt`.
- **Today a hub restart resets the in-memory budget,** which allows a post-restart burst. A4 forbids that.

### 4. Persistence and restart
- **Schema:**
  - `conversations` gains `cooling_until INTEGER NULL`, `level INTEGER NOT NULL DEFAULT 0` and `last_auto_ts INTEGER`. `notice_pending` is kept for the cooldown notice.
  - `conversations` also gains `last_cooldown_end INTEGER` and `last_drain_ts INTEGER`.
  - A new table `wake_pushes(binding_principal, binding_name, conv, batch_id, ts)`: the rolling window, pruned by age; it also serves LRS.
  - A new table `cooldown_notices` (above).
- **Migration (idempotent):** inside one transaction, rows with `paused=1` become `cooling_until = now + C_base, level = 1` with `paused` set to 0. A later restart finds no `paused=1` row, so it never re-applies the migration. The schema version is recorded in a `meta` table. Addressed rows already converted to passive under the old rule stay passive; the hub was never deployed live, so none are expected.
- **Transactions:** state changes (count, cooldown entry, level, wake-push record) commit inside the same store transaction as the message insert or batch creation. Timers are armed only after commit (same pattern as the crash-atomic send).
- **Startup:**
  - For each conversation with `cooling_until` in the future, arm its expiry timer.
  - If `cooling_until` is past, expire it now (reset count, arm coalesce for bindings holding its wake rows).
  - For each binding with selectable wake rows, schedule a coalesce at the earliest budget-allowed instant from `wake_pushes`.
  - The outstanding-batch retry rules (§8.4) are unchanged.

### 5. Defaults (DESIGN CHOICES with reasoning, not operator-given policy)
| key | default | reasoning |
|---|---|---|
| T `loopBreakerLimit` | 12 | Unchanged. Long enough for a real multi-step exchange. |
| C_base `cooldownBaseMs` | 10 min | Long enough to stop a tight loop. Short enough that collaboration resumes within a coffee break. |
| C_max `cooldownMaxMs` | 2 h | Caps the backoff, so a runaway conversation earns at most one release per 2 h at the cap. |
| D `cooldownDecayMs` | 2 h | A quiet conversation returns to the base cooldown after one cap-length of silence. |
| coalesce / interval / hourly | 2 s / 10 s / 60 | Unchanged §8.4 numbers. |

**The only claimed bound is the wake-permit limit.** Per binding: ≤ 1 wake push per 10 s and ≤ `wakeHourlyLimit` per rolling hour. Messages are still accepted and stored during cooldown, so automatic message throughput is NOT bounded by this amendment (only by the §8.5 send rate). It is counted for diagnostics only. One wake batch can carry up to 20 held messages, so wake-started model turns are bounded by wake permits, not by message counts.

## Tests required (bun test, loopback only)
1. **No-traffic expiry:** reach T; send nothing more; at cooldown expiry the held addressed mail is pushed as ONE wake batch with no new message or human turn. Held rows are never offered to a passive pull before expiry.
2. **Passive zero turns:** unaddressed mail during and after cooldown never produces a wake batch.
3. **Backoff and decay** (injected small values):
   - First entry is C_base, not half of it.
   - Successive cooldowns double up to C_max.
   - Forced silence does not decay: reach the cap, send nothing during the capped cooldown, reach T again, and the next cooldown is still C_max.
   - Genuine idle decay: release and drain, wait D, then a fresh T-message exchange enters cooldown at C_base. The decay check runs on the first new message, from prior state.
   - Held or outstanding wake rows block decay.
4. **Operator override:** an operator message ends the cooldown at once and resets count/level. A peer `human_turn: true` does not reset or shorten it. Other conversations are unaffected.
5. **Fairness:**
   - With conversation X cooling, wake mail in Y on the same binding is still pushed on schedule.
   - Backlog LRS: X with 1,000 eligible rows and Y with 1 newer row; Y is in push ≤ 2. Each conversation's internal order is preserved.
6. **Budget exhaustion and recovery:**
   - At the default (60/h) and at a non-default limit above 60 (e.g. 90/h), the next wake waits and fires automatically when the oldest push leaves the window; `vx status` shows `eligibleAt`.
   - Replay or retry of an existing batch consumes no permit.
7. **Restart:** stop the hub mid-cooldown and mid-budget, then restart:
   - no early release;
   - expiry still fires on time;
   - the budget is not reset, at both the default and the non-default limit;
   - the migration does not re-apply on a second restart;
   - a cooldown that expired while the hub was down releases right after startup;
   - no duplicate or lost batch (ids stable; pending rows intact).
8. **Burst bound:** 1,000 held rows release as at most 20 messages per batch, at most 1 per 10 s and 60/h.
9. **Crash atomicity:** a failure between message insert and cooldown entry leaves neither (same harness as the outbox test).

## Soak assertions (revised, per Codex)
- Count separately: admitted (synthetic in history or inbox, by unique soak number), processed (model turns = stub requests ending a turn), replied (hub messages from the agent).
- The stub is explicit: one `vx_send` per turn, whatever the batch size. With coalescing, replies equal wake turns, not messages sent.
- Pass criteria:
  - admitted-unique = sent;
  - no duplicate admissions;
  - every cooldown releases without traffic;
  - wake turns ≤ the wake-permit limit;
  - 0 pending at the end.

## Out of scope
Plugin changes (none needed: released mail arrives as ordinary wake batches); send rate (§8.5 bullet 3 unchanged); the Codex surface question.
