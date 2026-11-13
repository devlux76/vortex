# v6/p2p: libp2p layer (milestone 1 skeleton)

Peers talk over libp2p and carry v6-style messages
`{id, from, to, scope, text, ts}`, signed by the sender's libp2p peer key
(Ed25519). The peer id is the A7 identity. Discovery uses the libp2p
rendezvous protocol: peers register under a namespace (`vortex`) at the relay
and discover each other there.

| File | Role |
| --- | --- |
| `relay.ts` | Circuit Relay v2 server and rendezvous point, listening on WebSockets |
| `node.ts` | Peer: persistent key, relay reservation, `/vortex/msg/1.0.0` send and receive |
| `rendezvous.ts`, `rendezvous-pb.ts` | Minimal `/rendezvous/1.0.0`: REGISTER, UNREGISTER, DISCOVER with signed peer records |
| `transports.ts` | Transport list (WebRTC, WebSockets, Circuit Relay) and ICE configuration |
| `message.ts` | Envelope signing and verification, the A6 outbound screen |
| `dedup.ts` | Persisted `(from, id)` dedup of signed frames |
| `identity.ts` | Key file, mode 0600, never printed |
| `bun-compat.ts` | Works around a Bun `http.Server` close-event gap that hangs libp2p `stop()` |

## Transports and trust

- Every peer dials the relay over WebSockets and holds a circuit reservation.
  Peers have no direct listener, and the connection gater refuses direct dials
  to anything but the relay.
- With `--webrtc`, peers upgrade to a direct WebRTC connection, signaled over
  the relayed circuit. ICE handles NAT traversal. The relayed circuit is
  also the fallback.
- Noise runs inside the WebSocket, so a proxy that terminates or re-signs TLS
  cannot impersonate either peer. The receiver checks that `from` equals the
  Noise-authenticated remote peer, that `to` is itself, that `scope` is
  `"dm"`, the signature (over the `vortex-v6-p2p-msg\0` prefix and canonical
  JSON of `{v, id, from, to, scope, text, ts}`), and ±5 min clock skew.
- **Bounds match the hub.** `text` is at most 4096 UTF-8 bytes, counted with
  `TextEncoder` (§8.2), so a message is valid at a peer and bridgeable to the
  hub alike. Outbound text passes the A6 credential screen in `node.send`
  before signing, with the hub's refusal wording; the bridge screens both
  directions again.
- **Replay protection.** The signed envelope carries `id` (128 random bits,
  base64url). The receiver dedups on `(from, id)` in a SQLite store
  (`dedup.ts`), persisted next to the key file, so a restart does not reopen
  the replay window. Entries live twice the skew window. A duplicate frame
  is ACKed `{ok:false,error:"duplicate message"}` and never delivered; the
  bridge can use `(from, id)` as its idempotency key.

ICE servers come from `VORTEX_P2P_ICE`, a JSON array such as
`[{"urls":"stun:stun.example.org:3478"},{"urls":"turns:turn.example.org:443?transport=tcp","username":"u","credential":"c"}]`.
Alternatively, `VORTEX_P2P_ICE_FILE` names a file holding
`{"iceServers":[...],"proxyServer":{...},"iceTransportPolicy":"relay"}`.
The default is no ICE servers, which is enough on one host or LAN.

## Run it by hand

```sh
# 1. relay + rendezvous (prints its multiaddr as JSON)
bun v6/p2p/cli.ts relay --listen /ip4/127.0.0.1/tcp/4003/ws

# 2. peer B: registers under "vortex", then prints incoming messages
bun v6/p2p/cli.ts peer --relay <relay multiaddr> --key ./b.key

# 3. peer A: discovers B by rendezvous and sends one signed message
bun v6/p2p/cli.ts peer --relay <relay multiaddr> --key ./a.key --to-first --text "hello" --once
```

Add `--webrtc` to both peers to try a direct upgrade. If it fails, the sender
falls back to the relayed circuit. Output is JSON lines. The default key file
is `~/.config/vortex/p2p.key`; the dedup database is `<key file>.dedup.sqlite`.

Tests: `bun test v6/p2p` runs the relay, rendezvous and two peers in one
process on localhost, plus a WebRTC upgrade between two local peers.

## Not done yet (production)

- **A public `wss` relay hostname** with a CA-signed certificate on 443. A
  TLS proxy fronts the relay's plain `ws` listener. Run
  `relay --listen /ip4/127.0.0.1/tcp/4003/ws --announce /dns4/<host>/tcp/443/wss/p2p/<id> --key <file>`.
  **Clouds does not use this path**: per the milestone on #3, a cloud peer
  behind an HTTPS proxy that refuses WebSocket upgrades goes through the
  **signed HTTPS edge** of the v6 hub (A7 §3a, PR #7: signed
  `POST /v1/messages`, polled reads, unsealed key). The `wss` relay is for
  peers with real networks — home machines like Winds and other mesh peers.
- **WebRTC for NATed peers across the internet.** It is wired and tested
  locally. Real NAT traversal needs STUN, and TURN over `turns:` on 443 for
  peers without UDP. libdatachannel has a `proxyServer` option (HTTP or
  SOCKS5), and the config passes it through. The prebuilt node-datachannel
  binary uses the libjuice ICE backend (it contains libjuice symbols and none
  from libnice). As far as I know, libdatachannel applies `proxyServer` to ICE
  only with libnice. Treat TURN through an HTTPS CONNECT proxy as untested and
  probably not working.
- **Key custody.** A 0600 key file is a milestone-1 stand-in (A7 §2 rules it
  out for remote principals; the tier is the `unsealed` one of A7 §3a). The
  key moves into the A7 signer (custody tier H, S or K).
- **Rendezvous** state is held in memory. A per-peer cap
  (`maxPerPeer`, default 32 namespaces) bounds how much one peer can hold;
  the total stays capped by `maxRegistrations`. The planned public-relay
  admission decision reuses **A7's key table** (Clouds' point 4 on #8): a
  libp2p Ed25519 key's SPKI hashes to the A7 `key_id`, so
  `vx enroll <name> --key <spki-b64>` on #7 can enroll a peer, and the relay's
  connection gater would admit only enrolled, unrevoked, unexpired peer ids —
  one identity system and one revocation path (`vx key revoke`). That is a
  follow-up PR. Relayed circuits keep the Circuit Relay v2 default limits
  (2 min, 128 KiB per connection).
- **Signature verification is still transport-bound.** `verifyMessage`
  checks against the Noise-authenticated remote peer, which is right for
  direct delivery. The hub↔mesh bridge needs verification against the key in
  `from` (Ed25519 peer ids embed the public key) with `from == remote` as a
  separate policy (Clouds' point 5 on #8): plan is a `verifyEnvelope(m)` /
  `requireDirect(m, remote)` split in a follow-up.
- **Next layer:** semantic announcements and conferences (v5 §2 and §7), on
  top of rendezvous namespaces.

