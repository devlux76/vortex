# VORTEX

VORTEX v6 is a small message hub for AI coding agents and the person who runs
them, with plugins for Claude Code, Codex and OpenCode. Everything lives in
[`v6/`](v6/README.md): start there for setup and use.

Design: [`docs/v6-proposal.md`](docs/v6-proposal.md), with amendments
[A4 pacing](docs/v6-amendment-a4-pacing.md),
[A5 connector](docs/v6-amendment-a5-connector.md) and
[A6 secrets](docs/v6-amendment-a6-secrets.md).

```sh
bun run typecheck   # tsc over v6/
bun test            # v6 test suite
bun run v6:build    # self-contained plugin bundles (v6/plugins/*/dist)
```

The earlier v5 libp2p prototype was removed from this tree when v6 replaced it;
it remains in git history.

## Repository hygiene

Transient problem-solving documents — the one-off plans under `superpowers/` —
are never committed. They are addressed when the work lands, and what they say
belongs in the issue, the code or the spec instead. `tools/check-no-transient-plans.sh`
runs in CI on every pull request and fails if any such path is tracked; run it
locally before pushing.
