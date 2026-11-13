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

Not here yet (later sub-issues of #3): #20 (mesh→hub delivery). #11
(hub→mesh) is implemented on a stacked branch: see `delivery.ts`.

## Room delivery, hub → mesh (#11)

`startRoomDelivery(bridge, room)`:

- The bridge publishes itself under the room's rendezvous namespace, joins
  the hub room by posting one signed presence line (hub room reads need
  membership; enrollment does not grant it), then polls the room log with a
  persisted cursor (`<keyFile>.delivery.json`).
- Each hub message is forwarded to the room's mesh members — the peers
  registered under that namespace — as a signed envelope with
  `scope:"room"` and a signed `room` field. `to` is signed per recipient.
- The envelope `id` is derived deterministically from the hub message id
  (`forwardIdOf`), so a replayed batch — a crash between send and
  cursor-write — is refused by the receiver's persisted `(from, id)` dedup
  instead of delivered twice.
- The A6 screen runs in the bridge before anything is signed (hub wording);
  a refused message is not forwarded and is counted.
- The bridge's own room lines are not forwarded. A message undelivered for
  some member is retried on later polls (bounded attempts, then dropped and
  counted in `stats`).
- The bridge's hub key is its own libp2p key (`identity.ts`): as SPKI,
  sha256 binds the peer id to the enrolled principal (`principal_keys`), so
  one key signs both halves.

