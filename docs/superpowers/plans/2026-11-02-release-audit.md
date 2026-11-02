# VORTEX release audit

> Execute jointly with Codex and Claude. Review findings independently before fixes; reproduce defects, patch only the demonstrated cause, and cross-review the candidate.

**Goal:** Account for every tracked file and declared library before the operator announces VORTEX; resolve every detected defect and state precisely what remains unverified.

**Baseline:** `ace2dde72e1097cfc6386b3f24cd4e633f43b56c`, tree `6a32567c1c32e8833ba94af4035098468af47bc3`. Issue `3ab7f40`, parent `e769658`.

**Scope:** All 232 tracked entries: v6, legacy code, tests, experiments, deployment, manifests, documentation, lockfiles, generated bundles/protobuf and skill directory links. Physical multi-device testing is excluded by the operator, not passed. No push or public announcement is authorized.

**Coverage:** Immutable path/hash/line inventory and separate Codex/Claude coverage journals in `~/.local/state/codex/vortex-release-audit-20261102/`. Mark a file read only after the whole file has been inspected. Record generated-output lineage, exact rebuild checks, dependencies and external contracts separately; do not call upstream source reviewed without actually reviewing it. Changes invalidate the affected hashes and boundary reviews.

## Work

- [ ] Both reviewers independently inspect v6 source, tests, manifests, CLI and runtime contracts. Check auth, input bounds, durability, concurrency, timers, cancellation, reconnect/replay, privacy, rendering, host admission and install/startup paths.
- [ ] Inventory direct/transitive dependency versions and origins, native/runtime requirements, exposed APIs, compatibility, license/redistribution requirements and security advisories using primary sources. Distinguish unused legacy declarations from v6's runtime graph.
- [ ] Inspect all remaining tracked files. Codex first pass: legacy core, CLI/MCP, types, presence, disclosure and related tests. Claude first pass: other legacy source, adapters/skills, backbone, deployment, benchmarks, proto generation, root metadata and documentation. Swap passes; record each reviewer's actual coverage.
- [ ] Verify generated artifacts from exact inputs, clean installation, documented commands, typechecks, all relevant test suites, native MCP contracts and isolated runtime/failure scenarios. A failing legacy suite stays a finding; it is not waived because v6 passes.
- [ ] For each finding: reuse/file an issue, record repro and impact, independently confirm, make the smallest fix with a regression when appropriate, cross-review the pin, integrate locally and recheck affected files/boundaries.
- [ ] Reconcile every inventory entry, dependency and open issue against the actual release surface. Produce a final audit with exact commit, coverage, findings/fixes, verification evidence and honest limitations. Do not infer an absence of bugs from passing tests.

**Review focus:** Fresh-user setup; unsupported/default host assumptions; malicious or malformed peer inputs; crash/restart at every acknowledgment boundary; resource growth and timing races under load.
