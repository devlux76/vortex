# VORTEX v6 netlab: an emulated multi-hop WAN on one host

**Label for anything measured here: MULTI-VM EMULATED WAN, SINGLE PHYSICAL HOST.** It is much stronger than loopback or containers: separate kernels, network stacks, routing and real TLS over multi-hop routed paths. It is still not a second physical device.

## Topology (8 QEMU/KVM VMs, Debian 12 cloud image)
```
peer-a ─lan-a─ r-a ═a-c1═ core1 ═h-c1═ r-h ─lan-h─ hub
                 ╚═a-c2═ core2 ═h-c2═╝
peer-b ─lan-b─ r-b ═b-c1═ core1   core1 ═c1-c2═ core2
                 ╚═b-c2═ core2
```
- **Links:** point-to-point UDP tunnels between QEMU processes (`-netdev dgram` on loopback). Nothing is created on the host network: no bridges, taps, namespaces or firewall rules, and no root.
- **Management:** each VM also has a private user-mode management NIC (SSH via a loopback hostfwd). Test prefixes (10.10/16 sites, 10.255/16 core) route only over the data links.
- **Routing:** FRR OSPF (hello 1 s, dead 4 s, SPF throttle 50 ms). Each site has two equal-cost paths. Peer→hub is 3 router hops.

## Failure model
- `impair wan`, per core hop and per direction, on all 7 core links (14 interfaces): `delay 15ms 5ms normal, loss random 1%, duplicate 0.2%, reorder 0.5%`.
  - Measured peer→hub: 3.7% round-trip loss (model 3.9%); RTT avg 62 ms, mdev 10 ms; ~0.9% duplicates.
- `impair lossy`: bursty Gilbert-Elliott loss, 40±15 ms per hop.
- `chaos --mode carrier|blackhole|mixed`: random core link failures.
  - carrier (interface down at both ends): reroute < 0.1 s.
  - blackhole (interface up, 100% loss): OSPF notices after its dead interval, measured ~3.5 s outage, then reroute.
  - Heals restore the recorded profile; chaos refuses to run without one.
- Kernel caveats (6.1 cloud kernel):
  - correlated netem loss (`loss P CORR`) drops almost nothing, so the profiles use `loss random`;
  - `tc qdisc replace` keeps netem parameters you don't restate, so `impair` deletes and re-adds.

## Use
```
python3 netlab.py build-base                 # once: base image with FRR, netem check (~2 min)
python3 netlab.py up                         # 8 VMs, OSPF converges (~1 min)
python3 netlab.py status                     # OSPF neighbours, traceroutes, ECMP routes
python3 netlab.py impair wan                 # or lossy | clear
python3 netlab.py deploy-vortex <repo> [--loop-limit N]   # hub in 'hub' VM, pinned creds to peers
python3 netlab.py peer-check --rounds 30     # tools/peer-check.ts between peer-a and peer-b
python3 netlab.py chaos --duration 300 --every 30 --down 12 --mode mixed
python3 netlab.py down
```
- Runtime state lives in `$NETLAB_DIR` (default `~/.cache/vortex-netlab`).
- The cloud image path is `$NETLAB_IMAGE` (default `~/.cache/vortex-v6-vm/debian-12-genericcloud-amd64.qcow2`, from cloud.debian.org; verify its SHA512).
- `--loop-limit N` and `--wake-hourly-limit N` raise the hub's §8.5/A4 loop breaker and its per-binding hourly wake budget for transport-only runs, so pacing behaviour doesn't mask network behaviour.
  - Without them, a long run correctly stalls once a binding uses its 60 wake permits per rolling hour, which persist across runs and hub restarts.
  - That stall was observed once: mail stayed pending at the hub, nothing was lost.

## Results (2026-11-02)
- Run 4: fresh hub, `wan` impairment. Its 10 core-link failures (3 silent blackholes, 7 carrier losses, 6 of them on peer-a's own uplinks) come from the pre-fix chaos log: those mutations were unchecked (`check=False`), so the count is NOT observed evidence. The message exchange itself is valid.
  - `peer-check` completed 30/30 rounds on both sides; every PONG was validated (reply_to, scope, addressee).
  - Impairment audit 14/14 before and after.
  - Round trip min/median/max 4.7/10.0/13.0 s; 10 s is the hub's wake pacing.
- Earlier runs found three tooling bugs and confirmed one hub behaviour:
  - a heal step that dropped impairment (fixed);
  - a self-matching `pkill` that skipped the hub wipe (fixed);
  - stale replayed mail fooling the kit (fixed, with a regression test);
  - the persistent 60/h wake budget correctly holding mail (confirmed).
- Harness hardening after Codex review:
  - every fault transition is a checked mutation, OBSERVED at both ends (`ip -br link` / `tc qdisc show`) and persisted to `chaos.jsonl`;
  - chaos heals the active fault on any error, SIGINT or SIGTERM and exits nonzero;
  - `peer-check` uses run-specific remote paths, propagates both peers' exit codes, and validates the paired artifacts before success: fresh (UTC), ok, exact round count and unique nonces on both sides, one run id, and per nonce the PING/PONG ids cross-matched (a.sentId = b.replyId, a.replyId = b.sentId) with the same requested, seen and reply scope. It writes `<run>-verdict.json`.
  - `test_netlab.py` holds offline regressions (RED on the old harness).
- Focused proof: 3 faults (2 blackhole, 1 carrier), each fail and heal observed at both ends; `peer-check` verdict ok with 6/6 paired rounds on a fresh hub.
