# v6/bridge: the hub↔mesh bridge

One process holding two halves:

- **Hub half** — the A7 §3a edge client (`v6/client/edge.ts`): every request
  signed, bound to one hub id (the TLS certificate fingerprint). At startup
  the bridge proves its identity with one signed `GET /v1/recent` (room
  independent) **before** the mesh half comes up, so a bridge with a wrong
  identity never starts at all.
- **Mesh half** — the libp2p peer of `v6/p2p/node.ts` (#8): persistent key,
  relay reservation, signed messages, rendezvous.

`startBridge` returns `{ peer, edge, stop }`; `stop` is idempotent.

The bridge's hub key is `unsealed` custody for now: the hub caps it to named
rooms, and the key file is the A7 §2 stand-in (sealed tiers come with the A7
signers).

Not here yet (later sub-issues of #3): delivery both ways — #11 (hub→mesh
signed room delivery, dedupe on `(from, id)`, A6 both directions, peer id →
principal through `principal_keys`) and #20 (mesh→hub).
