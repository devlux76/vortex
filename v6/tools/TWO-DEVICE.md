# VORTEX v6 two-device acceptance (spec 154 release gate)

Kit: `device-hub.ts` starts a hub whose TLS listener binds to a reachable LAN address, enrolls `dev-a` and `dev-b`, and writes pinned `wss://` credentials. `peer-check.ts` runs one side per machine. Rounds alternate `#all` room posts and DMs, PING then PONG, both directions, and each side writes JSON evidence. The ~10 s round trips are the spec's wake pacing (at most 1 wake per binding per 10 s).

Labels used for evidence:
- LOOPBACK: same host, same network namespace. Checks the kit only.
- SINGLE HOST, SEPARATE NETNS: for example a container reaching the hub's LAN address over pinned TLS. Not two-device.
- TWO DEVICE: the responder runs on a different physical machine. Only this satisfies the gate.

Procedure (operator supplies a second machine with Bun on the LAN):
1. On the hub host:
   - Allow the hub TLS port from the LAN, e.g. `sudo ufw allow proto tcp from <lan-subnet> to any port <port>`.
   - `bun v6/tools/device-hub.ts --dir <dir> --tls <hub-lan-ip>:<port>`
2. Copy `<dir>/dev-b.json` (secret, mode 0600) and the `v6/` tree to the second machine. There, run:
   - `bun v6/tools/peer-check.ts --credential dev-b.json --role respond --peer dev-a --out b.evidence`
3. On the hub host:
   - `bun v6/tools/peer-check.ts --credential <dir>/dev-a.json --role initiate --peer dev-b --out a.evidence`
4. Accept when both sides report `ok: true`, `tls`/`pinned` are true, and `b.evidence` shows the second machine's own hostname and LAN address.
5. Remove the temporary firewall rule.
