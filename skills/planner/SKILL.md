---
name: planner
description: Plan and track local AI work with the planner command over git-bug. Use for task selection, kanban status, claims, checkpoints, blockers, and resuming after compaction.
---

# Planner

Use `planner` from any directory. It returns compact JSON, calls no model, and uses the repositories listed in `~/.config/bug-watch/repos`. References are `vortex:6ee260f`, `opencode:b7fe55b`, or `shared:40dbd63`. Use a stable actor name (`glm`, `codex`, `trailblazer`), never a session ID.

```sh
planner --actor glm resume
planner board --repo vortex --column todo --limit 8
planner show vortex:6ee260f
planner --actor glm start vortex:6ee260f --plan 'Shorten wake envelopes; verify room and sender boundaries; measure size.'
planner --actor glm note vortex:6ee260f 'Intent: change the notice text; no mail or service state changes.'
planner --actor glm note vortex:6ee260f 'Result: focused tests passed; next: size comparison.'
planner --actor glm block vortex:6ee260f 'Provider quota exhausted; no retries until operator resumes.'
planner --actor glm start vortex:6ee260f --plan 'Resume from the recorded checkpoint.'
planner --actor glm done vortex:6ee260f --evidence 'Actual commands, results, commit, and remaining limits.'
planner --actor glm release vortex:6ee260f 'Explicit handoff reason; next action.'
planner add vortex --title 'Concrete task title' --plan 'Outcome and acceptance check' --priority p2
```

Start with `resume` after compaction. Read one card before acting. Use `git -C <repo> bug bug show <id>` if the bounded card omits needed detail. Work on one active card per actor; block or release it before taking another. A blocker retains task ownership but frees the actor for other work. Select ready work within the operator's authorized scope; priority alone is not permission to revive parked work.

Record intent before consequential effects and the observed result afterwards. Include what remains so another session can continue. `done` records verified work; it does **not** close the issue or grant permission to merge, deploy or spend money. Review/closure is separate and need not wait for an unavailable frontier agent.

Git-bug is the durable plan and progress record. Local SQLite claims serialize workers using this helper and survive compaction. Other tools can edit labels, so claims do not enforce all external workers. Claims never expire or automatically transfer. A stale owner requires explicit reconciliation; use its stable actor to release only after confirming it stopped. This helper is not the full lease/generation/reconciliation system tracked by `shared:40dbd63`.

On a write error, inspect `resume` and the issue before repeating a side effect. `planner --actor glm sync <ref>` repairs an interrupted issue mirror without changing the claim or duplicating its comment. Never infer completion from a mail acknowledgement. Keep session IDs, credentials and private runtime paths out of issue text. Check the board on task boundaries or actual notices; do not run a model polling loop. Automatic VORTEX wakes remain quota-held until the operator resumes them.
