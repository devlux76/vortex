# Amendment A4 (DRAFT for cross-review): hub pacing with automatic cooldown

Status: design draft. Claude, 2026-11-02, bug:e79eb06. Not normative until Claude and Codex agree; no code yet.
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
- **Entering cooldown.** When the count reaches T, the conversation enters cooldown until `cooling_until = now + C(level)`, and `level` increments.
- **During cooldown:**
  - Messages are stored as usual.
  - An addressed message (one that would be wake-eligible under §8.4) is enqueued as a WAKE pending row, exactly as if no cooldown existed. It is HELD: wake batch selection skips rows whose conversation is cooling.
  - It is never converted to passive and never admitted early. When it is eventually released, it is admitted once.
  - Genuinely passive mail (not addressed) stays passive and is unaffected; passive pulls may deliver it during cooldown.
- **Expiry needs no new message or human turn.** At `cooling_until`, the count resets to 0 and the held wake rows become selectable. The hub arms a coalesce for every binding that holds them; normal wake pacing (§3 below) then releases them in bounded batches.
- **Backoff.** C(level) = min(C_base · 2^(level−1), C_max). The level decays to 0 once the conversation has seen no `human=false` message for D. This bounds a runaway loop between two agents without a human.
- **Operator override.** An `operator` message in the conversation ends any cooldown at once and resets count and level to 0. The existing rule stands: a human DM reply resets only its referenced direct conversation. Peers have no reset path: not via `human_turn`, not via any API.
- **Notice.** On entering cooldown, the next batch to each affected binding (wake or passive) carries one line, once: `[vx: conversation cooling down after 12 automatic messages; wakes resume HH:MM]`. HH:MM is hub-local `cooling_until`. It counts toward the rendered bounds like every notice.
- **Visibility trade-off (a design choice).** Held addressed mail is not shown passively during cooldown; it arrives once, as a wake, at expiry. The alternative (show it passively now and wake again later) would admit the same mail twice. The notice tells the agent why it is quiet.

### 2. Wake selection and fairness
- A batch stays single-conversation (current behaviour).
- Selection takes the oldest selectable wake row, skipping held conversations. A cooling conversation therefore never blocks wake mail from other conversations on the same binding.
- When several conversations become selectable together, oldest-first order alternates between them naturally. Batch bounds (20 messages / 6,000 code points / 8 KiB) cap each release.

### 3. Wake budget, made persistent (precise form of §8.4 pacing)
- **Per binding (unchanged numbers):** coalesce 2 s after the first eligible row; at most 1 wake push per 10 s and 60 per rolling hour.
- **Persistence:** wake push times are stored per binding (the last 60 timestamps), not kept only in memory.
- **Over budget:** the batch stays pending; the hub arms a timer for the earliest instant both limits allow; `vx status` shows `waitingWake` and `eligibleAt`.
- **Today a hub restart resets the in-memory budget,** which allows a post-restart burst. A4 forbids that.

### 4. Persistence and restart
- **Schema:**
  - `conversations` gains `cooling_until INTEGER NULL`, `level INTEGER NOT NULL DEFAULT 0` and `last_auto_ts INTEGER`. `notice_pending` is kept for the cooldown notice.
  - A new table `wake_pushes(binding_principal, binding_name, ts)`, pruned to 60 rows per binding.
- **Migration:** existing `paused=1` rows become `cooling_until = startup + C_base, level = 1`. Addressed rows already converted to passive under the old rule stay passive; the hub was never deployed live, so none are expected.
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
| C_max `cooldownMaxMs` | 2 h | Caps the backoff. Worst case for a runaway two-agent loop: about 12 messages per 2 h per conversation. |
| D `cooldownDecayMs` | 2 h | A quiet conversation returns to the base cooldown after one cap-length of silence. |
| coalesce / interval / hourly | 2 s / 10 s / 60 | Unchanged §8.4 numbers. |

Worst-case cost: first hour 12 + 12 (after 10 min) + 12 (after a further 20 min) + 12 (after a further 40 min) ≈ 48 automatic messages; then about 6/h. Each release also stays within the per-binding 60 wakes/h.

## Tests required (bun test, loopback only)
1. **No-traffic expiry:** reach T; send nothing more; at cooldown expiry the held addressed mail is pushed as ONE wake batch with no new message or human turn. Held rows are never offered to a passive pull before expiry.
2. **Passive zero turns:** unaddressed mail during and after cooldown never produces a wake batch.
3. **Backoff and decay:** successive cooldowns follow 10 → 20 → 40 min, capped at C_max. The level returns to 0 after D of silence. (Use injected small values.)
4. **Operator override:** an operator message ends the cooldown at once and resets count/level. A peer `human_turn: true` does not reset or shorten it. Other conversations are unaffected.
5. **Fairness:** with conversation X cooling, wake mail in conversation Y on the same binding is still pushed on schedule.
6. **Budget exhaustion and recovery:** with 60 wakes/h used, the next wake waits and fires automatically when the oldest push leaves the window. `vx status` shows `eligibleAt`.
7. **Restart:** stop the hub mid-cooldown and mid-budget, then restart:
   - no early release;
   - expiry still fires on time;
   - the budget is not reset;
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
  - wake turns ≤ the budget formula above;
  - 0 pending at the end.

## Out of scope
Plugin changes (none needed: released mail arrives as ordinary wake batches); send rate (§8.5 bullet 3 unchanged); the Codex surface question.
