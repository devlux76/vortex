# Presence service and Codex adapter implementation

Spec: docs/2026-10-22-presence-design.md at9bbc1a9. Operator delegated implementation/integration decisions; Claude owns rollout, no installed unit restart. Worktree codex/presence, main9bbc1a9 baseline. No new agents.

1. Test persistent host registry (live/start-time mismatch/withdraw/restart), metadata-only attach lines, competing sessions. Implement Node-only presence module, CLI NDJSON stream and ancestor detection. Preserve wait compatibility and authentication. No lease/polling.
2. Test routing rows and stale router-ring race. Presence suppresses router state via effective waiter count; check presence again on dispatch. Notify lines only after durable event, stop streams cleanly. Persist registrations across service restart; hostPid0 clears this owner's registrations. Arrival/attach marks owner return for away-notice epoch.
3. Test away adapter ignores obsolete leases, rate-limits per room and resets after actual presence. Delete away-loop and only its skill paragraph (Claude editing live-session text).
4. Test Codex host process recognition, existing queue path, headless opt-in read-only resume and away default. Never infer a live host from stale SQLite files or from an arbitrary codex CLI process. Fixed prompts only; preserve acknowledgment/exit semantics and no overlapping executors.
5. Run bun test ./src and typecheck, self-review lifecycle/races, rebase concurrent owner changes, fast-forward main locally. Send Claude summary/commit and document actual acceptance limits (no installed service rollout or hour-idle live proof yet).

Implementation decisions:

- `hostPid:0` clears this owner's registered hosts; it does not detach other open lines. Metadata lines use Node HTTP without a fetch deadline. Slow stream consumers are disconnected rather than accumulating unbounded output.
- Presence uses the existing router's effective waiter count and rechecks on ring dispatch. The OTP routing API needs no change. A delivered one-shot attachment retains the existing brief owner quiet period.
- A random `presence-epoch` resets the six-hour away throttle on attachment, legacy wait or successful acknowledgment, including app-host sessions that queue without registering a host. Old numeric away stamps retain their throttle until an actual return.
- Codex recognizes same-user ChatGPT/Codex app processes or `codex app-server`, never arbitrary headless `codex exec`. An optional owner-selected `VORTEX_CODEX_HOST_PID` selects a specific live host process. No process is registered with VORTEX from the ring adapter.
- An absent host plus `wake` resumes the configured thread with shell execution, subagents, hooks, plugins, connected apps and web search disabled, user config/rules ignored, and a read-only sandbox. A small stdio MCP bridge provides only authenticated owner `read`, `send` and `ack`; this avoids giving a sandboxed shell general network access just to reach localhost. The unattended turn handles mail and queues proposed changes for the operator. Its ten-minute deadline is an execution backstop, not a presence lease.
- Verification uses isolated fixtures and stand-in model executors. Installed owner units are untouched. Real headless model execution and the design's hour-idle, four-owner acceptance remain rollout checks owned by Claude.

Verification on the integrated tree: `bun test ./src`: 461 passed, zero failed (32 files); `bun run typecheck`: passed. OpenCode's real-router presence test is required, not skipped. The five standalone away-adapter tests also passed. The CLI held an idle stream beyond the server's ten-second request backstop, then received its next notice. Installed units were not restarted.
