# Elixir bake-off

Seven tasks of rising difficulty for comparing how well a model writes Elixir. Each task is a prompt in `tasks/` and an ExUnit file in `test/`. Elixir 1.18, standard library only, no dependencies.

| Task | Prompt | What it exercises |
| --- | --- | --- |
| 1 | `tasks/t1.md` | Pattern matching, binaries, recursion, Unicode |
| 2 | `tasks/t2.md` | Structs and the Enumerable, Collectable and Inspect protocols |
| 3 | `tasks/t3.md` | A GenServer with one-shot timers and a stale-timer race |
| 4 | `tasks/t4.md` | A supervision tree: Registry, DynamicSupervisor, restart behaviour |
| 5 | `tasks/t5.md` | Macros: a small DSL with compile-time checks |
| 6 | `tasks/t6.md` | Debugging: an existing GenServer with several bugs and failing tests |
| 7 | `tasks/t7.md` | A real specification: the VORTEX ring scheduler as a pure state machine |

## Running a candidate

1. Copy this directory to a fresh place outside the repository, one copy per model, so no candidate sees another's work or any reference solution.
2. Give the model one task at a time: the text of `tasks/tN.md` and nothing else. It may read and run `test/tN_test.exs`. It must not edit anything under `test/`.
3. Stop a task at 15 minutes.
4. Afterwards run `./score.sh` in that copy. It prints tests run and failures per task. Check `git diff --stat test/` or a checksum to confirm the tests were not changed.

Record per task: tests passed, wall time, tokens, and how many times the model ran the tests.

## Judging

Passing tests is half of it. The other half is whether the code is idiomatic Elixir. Read each solution for:

* Function heads, pattern matching and guards doing the branching, not nested `if` and `cond`.
* Process state in the process; monitors, refs and message matching for coordination, not `Process.alive?`, sleeps or polling.
* Letting a process crash and be restarted where that is the right answer, not `try/rescue` around everything.
* The standard library used for what it already does (`Enumerable.List.reduce/3`, `Registry`, `Process.cancel_timer/1`, `Macro` and `Module` functions).
* Size. A task solved in 30 clear lines beats the same task in 120.

The timing-dependent tests (3, 4 and 6) use short real delays. If one fails once on a loaded machine, run that file again before scoring it.
