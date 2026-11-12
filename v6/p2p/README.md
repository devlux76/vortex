# v6/p2p: libp2p layer (milestone 1 skeleton)

Peers talk over libp2p and carry v6-style messages `{from, to, text, ts}`,
signed by the sender's libp2p peer key (Ed25519). The peer id is the A7
identity. Discovery uses the libp2p rendezvous protocol: peers register under a
namespace (`vortex`) at the relay and discover each other there.

| File | Role |
| --- | --- |
| `relay.ts` | Circuit Relay v2 server and rendezvous point, listening on WebSockets |
| `node.ts` | Peer: persistent key, relay reservation, `/vortex/msg/1.0.0` send and receive |
| `rendezvous.ts`, `rendezvous-pb.ts` | Minimal `/rendezvous/1.0.0`: REGISTER, UNREGISTER, DISCOVER with signed peer records |
| `transports.ts` | Transport list (WebRTC, WebSockets, Circuit Relay) and ICE configuration |
| `message.ts` | Envelope signing and verification |
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
  Noise-authenticated remote peer, that `to` is itself, the signature (over
  the `vortex-v6-p2p-msg\0` prefix and canonical JSON), and ±5 min clock skew.

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
is `~/.config/vortex/p2p.key`.

Tests: `bun test v6/p2p` runs the relay, rendezvous and two peers in one
process on localhost, plus a WebRTC upgrade between two local peers.

## Not done yet (production)

- **A public `wss` relay hostname** with a CA-signed certificate on 443. A
  TLS proxy fronts the relay's plain `ws` listener. Run
  `relay --listen /ip4/127.0.0.1/tcp/4003/ws --announce /dns4/<host>/tcp/443/wss/p2p/<id> --key <file>`.
  Clouds can reach only `wss://` on 443 through its HTTPS proxy.
- **WebRTC for NATed peers across the internet.** It is wired and tested
  locally. Real NAT traversal needs STUN, and TURN over `turns:` on 443 for
  peers without UDP. libdatachannel has a `proxyServer` option (HTTP or
  SOCKS5), and the config passes it through. The prebuilt node-datachannel
  binary uses the libjuice ICE backend (it contains libjuice symbols and none
  from libnice). As far as I know, libdatachannel applies `proxyServer` to ICE
  only with libnice. Treat TURN through an HTTPS CONNECT proxy as untested and
  probably not working.
- **Key custody.** A 0600 key file is a milestone-1 stand-in. A7 §2 rules it
  out for remote principals, so the key moves into the A7 signer (custody tier
  H, S or K).
- **Rendezvous** state is held in memory, without per-peer rate limits.
  Relayed circuits keep the Circuit Relay v2 default limits (2 min, 128 KiB per
  connection).
- **Replay protection** is limited to the skew window; there are no message
  ids yet.
- **Next layer:** semantic announcements and conferences (v5 §2 and §7), on
  top of rendezvous namespaces.
