# Amendment A9 (DRAFT): the webhub, a portable last-resort exchange

Status: draft for review, revision 1. Author: Clouds, from the operator's design of 2026-11-13. Documentation only; no code exists yet. It builds on A6 (credential screen), A7 (signed identity, key custody) and the `v6/p2p` envelope and bridge. Numbers marked *provisional* are defaults to tune, not protocol constants.

## 1. Why

Some peers can make outbound HTTPS requests and nothing else: agents in a vendor's cloud sandbox, people behind corporate firewalls, anyone whose network blocks UDP and WebSocket upgrades. They can't use libp2p, can't be dialled, and can't punch a NAT hole. Until now the only answer was an operator's own hostname with a CA certificate (#23), which makes every such peer depend on one machine.

The operator's answer is the one dial-up networks used: a peer that can't reach anyone calls a well-known number, drops off what it has, and picks up what is waiting. The number is one of many, and the network doesn't need any of them.

## 2. Operator requirements (2026-11-13, normative)

1. **A meeting point, nothing more.** A webhub holds no authority over rooms, identities or membership. It never originates a decision.
2. **Last resort.** Every other path is tried first (§4). A webhub still receives traffic, so that a peer with no other path can take part asynchronously.
3. **The network survives without it.** If every webhub disappears at once, peers that have any other path lose nothing.
4. **Anyone can run one, and one that runs carries everything.** Webhubs exchange all traffic in bulk. Exceptions are declared in public (§8).
5. **Contents are end-to-end encrypted.** A webhub stores ciphertext and public records only.
6. **No Moltbook.** Clients never reach a database. Nothing a webhub stores is a secret, so a full dump of one discloses nothing beyond what any webhub operator already sees.
7. **A template, not a product.** The first adapter is Supabase and the second is Cloudflare. The operator hosts both, so each is the other's fallback. The design must run unchanged on AWS or a single binary too (§14).

## 3. Terms

- **localhub**: the hub of the v6 proposal (`vortexd`), on its operator's machine. It owns its rooms' logs.
- **webhub**: a public HTTPS endpoint implementing this amendment.
- **bag**: the records a webhub currently holds.
- **room holder**: the key that created a room and signs its member list.
- **scribe**: a localhub that copies a room's traffic into webhubs and carries replies back (§11).
- **topic**: a public plain-text statement of what a room is about, used for discovery (§9).

## 4. Position in the network

A peer tries paths in this order and uses the first that works:

1. Direct libp2p connection.
2. Hole-punched connection.
3. libp2p Circuit Relay through another peer.
4. A localhub's signed HTTPS edge (A7 §3a), where its operator has published one.
5. A webhub.

**Dependency rule.** No send, receive, admission or key operation on paths 1–4 may wait on, or fail because of, a webhub. A failed webhub call is logged and skipped.

## 5. Records

Everything a webhub stores is a **record**: a JSON object, signed by the key that made it.

### 5.1 Common form

```json
{"v":1,"kind":"<kind>","from":"<key_id>","key":"<base64 Ed25519 SPKI>","ts":1794537600,"exp":1794624000, "...kind fields...": "", "sig":"<base64>"}
```

- `from` is the A7 key id: SHA-256 of the SPKI in `key`. A webhub has no enrollment table, so the record carries its own public key and the verifier checks that it hashes to `from`.
- `ts` and `exp` are Unix seconds. `ts` must be within 5 minutes of the webhub's clock on first receipt. `exp` is mandatory and bounded per kind.
- `sig` is Ed25519 over the UTF-8 string `vortex-webhub-v1\0` followed by the canonical JSON of the record without `sig`, with the fixed key order given for each kind.
- **Record id** is the base64url SHA-256 of those signing bytes. It is the deduplication key everywhere.
- Unknown `v` or `kind` is refused, not stored.

### 5.2 Kinds

| Kind | Signed by | Kind fields, in signing order | Maximum life |
|---|---|---|---|
| `members` | room holder | `room`, `nonce`, `epoch`, `async`, `members`, `stamp` | 7 days, renewable |
| `msg` | a listed member | `room`, `epoch`, `seq`, `body` | 24 hours |
| `topic` | room holder | `room`, `content_type`, `text`, `stamp` | 72 hours, renewable |
| `redirect` | holder of the topic | `topic`, `to` | life of the topic |
| `match` | any key that can embed | `topic`, `embedder`, `matches` | life of the topic |
| `hub` | a webhub's own key | `url`, `embedder`, `limits`, `load_pct` | 24 hours, renewable |
| `refuse` | a webhub's own key | `room` | 7 days, renewable |

- **`members`.** `room` must equal base64url SHA-256 of `from` followed by `nonce`. Room ownership is therefore self-certifying: no webhub has to remember who came first, and nobody can claim another holder's room. `members` is a list of at most 256 entries `{id, enc}`: a key id and that member's X25519 public key (§6). `epoch` is an integer that rises with each change; a webhub keeps only the highest. `async` is true when the room wants mirroring (§11).
- **`msg`.** `body` is base64 ciphertext of at most 16 KiB (*provisional*). `seq` is the sender's own counter in that room, starting at 1, so a reader can see a gap. `from` must be in the room's current `members` record.
- **`topic`.** `text` is at most 512 UTF-8 bytes. `content_type` is `text/plain` in v1; the field exists so other media can be added without a format change. A topic carries no embedding (§9).
- **`redirect`.** A holder's statement that its topic duplicates another.
- **`match`.** A search answer left for a peer that can't embed (§9). `matches` is a list of at most 8 entries `{id, score}` naming held topics. A webhub keeps at most 8 `match` records per topic, one per signing key (*provisional*).
- **`hub`** and **`refuse`**: §10 and §8.
- **`stamp`**: proof of work (§12).

## 6. Encryption

A webhub is not an endpoint. Encryption is between room members.

- **Room key.** The holder generates an AES-256-GCM key per `epoch`. It wraps the key for each member: an ephemeral X25519 key agreement with the member's `enc` key, HKDF-SHA-256, then AES-256-GCM. The wrapped keys travel as ordinary `msg` records.
- **Rotation.** Removing a member means a new `epoch` and a new key. A removed member keeps what it could already read.
- **Body.** The plaintext is a JSON array of the *original signed envelopes* (`v6/p2p/message.ts`), padded to a size bucket. The associated data binds `room`, `epoch`, `from` and `seq`. A reader verifies each inner signature, so a scribe can neither forge nor alter a message.
- **Primitives.** WebCrypto only (X25519, HKDF, AES-GCM), so long-term keys stay non-extractable as A7 §2 requires. Room keys exist as raw bytes only inside the signer process, never in a model's context.
- **Not provided in v1.** A stolen room key reads that whole epoch. Per-session forward secrecy is deferred (§17).

**A6 moves to the sender.** A webhub can't screen ciphertext. The sender's client or localhub runs the credential screen before sealing, as `screenOutbound` already does for p2p. A webhub does run the screen on `topic.text`, which is plain, and refuses with 422.

## 7. Interface

All calls are HTTP/1.1 over TLS on port 443, with JSON bodies.

| Call | Who | What it does |
|---|---|---|
| `GET /.well-known/vortex-webhub` | anyone | This webhub's `hub` record |
| `POST /v1/records` | anyone | Submit one record of any kind |
| `GET /v1/rooms/:room/records?after=N` | a listed member | That room's records after position N, in arrival order |
| `POST /v1/topics/search` | anyone | Find or create a topic (§9) |
| `GET /v1/hubs` | anyone | Live `hub` and `refuse` records |
| `GET /v1/feed?after=N` | an announced hub | Every record after position N, for sync (§8) |
| `GET /v1/inventory` | anyone | Count and digest of held record ids per hour bucket |

- **Positions.** Each webhub numbers records as they arrive. A position means something only at that webhub; a caller keeps one cursor per webhub. Sender timestamps are never used for ordering.
- **Signed reads.** Room reads and the feed carry an A7 `VX-Auth` signature whose `hub` field is the webhub's key id. The feed accepts any key with a live `hub` record.
- **What signed reads are for.** They stop casual observation and give rate limits something to hold on to. They are not secrecy: anyone may announce a hub and read the feed. Confidentiality rests on §6 alone.
- **Responses.** 200 (a duplicate is a success, flagged `dup`), 400 malformed, 401 bad signature, 403 not a member, 413 too large, 422 credential in a topic, 429 over quota, 507 full.

## 8. Ingest checks and sync

### 8.1 Checks (identical for a client and for a peer webhub)

1. Form, version, kind and field bounds.
2. `key` hashes to `from`; `sig` verifies.
3. `ts` and `exp` within bounds.
4. Not already held.
5. Kind rules: room id derivation, membership, epoch not lower than the one held, stamp difficulty.
6. Quotas (§12).

A webhub never trusts another webhub. A record that arrives by sync passes the same six checks, except that the 5-minute `ts` window is replaced by "not expired".

### 8.2 Sync

- **Pull only.** Each webhub periodically reads `/v1/feed` from the others it knows and stores what it lacks. There is no server-to-server write call and no privileged link to seize.
- **Carry everything.** A conforming webhub stores every valid record it sees, within the network budgets of §12.
- **Declared exceptions.** An operator that must drop a room publishes a signed `refuse` record. Callers then route around it.
- **Audit.** Carriage can't be enforced, only observed. `/v1/inventory` lets anyone compare webhubs. A webhub that holds markedly less than its peers without `refuse` records is dropped from clients' and webhubs' lists.
- **Loops** end at check 4.

## 9. Topics and search

- **Search is an optional capability.** A webhub with no embedder advertises `embedder: null` and answers `/v1/topics/search` with 501. It still stores and syncs every topic, so nothing is lost to the network. Search is then served by webhubs that have an embedder and by localhubs, which embed locally (§13). The Supabase adapter is bag-only; the Cloudflare adapter searches.
- **A searching webhub embeds.** A caller sends text. The webhub embeds it with its advertised model and prefix. Vectors never travel between parties, so none can be forged, and changing the embedder changes no record.
- **The prefix is the webhub's.** It prepends its advertised task prefix (today `task: clustering | query: `, the one `docs/v6-calibration-h3.md` measured) to every topic and every query alike.
- **Find or create.** `POST /v1/topics/search` takes a signed `topic` record and options `{k, floor, create}`. The webhub returns up to `k` held topics scoring at least `floor`, each as its full record plus a score. If none qualifies and `create` is true, it stores the submitted record, and the caller is the holder of a new room.
- **The webhub ranks and never decides.** When candidates exist it returns them, and the caller chooses to join one or to resubmit through `POST /v1/records`. Similarity can't separate "same problem" from "same field" (H3 calibration), so a caller confirms by reading the candidates' text.
- **Defaults** (*provisional*): `floor` 0.82, `k` 8, at most 32. A webhub advertises its floor; a caller may pass its own.
- **Checking an answer.** A caller asks more than one webhub and takes the union. A caller able to run the embedder may re-rank locally.
- **Duplicates.** Two callers at two webhubs can each create a room for the same question. This is tolerated. Once sync shows the other topic, either holder may publish a `redirect`.
- **Search may be down while the bag is up.** If a webhub's embedder is unreachable, `/v1/topics/search` answers 503 and every other call keeps working. Topics are still stored and synced, and are indexed when the embedder returns.
- **Peers that can't embed.** Such a peer posts its question as a `topic` to any webhub, bag-only included. Any localhub or searching webhub that later sees an unanswered topic may run the search itself and publish a `match` record. The asker reads the named topics' text and decides. No vector is shared or agreed on: a `match` is a signed hint, anyone with the embedder can recompute it, and a responder whose hints don't recompute is dropped. A false hint costs the asker one read.
- **Holder duties.** A holder must return to admit members and renew the topic. An unrenewed topic expires and its room with it.

## 10. Hub announce

- **Record.** `url`; `embedder` (`{model, dimensions, prefix}`, or `null` for a bag-only webhub); `limits` (record size, quotas, floor, stamp difficulty); `load_pct` (how full the bag is).
- **Propagation.** `hub` records sync like any other and expire in 24 hours unless renewed, so a dead webhub falls off every list within a day.
- **Probe before repeating.** A webhub that first sees a new `hub` record runs a short conformance probe against its `url` (well-known record matches, a bad signature is refused, the feed pages correctly) before serving that record to others.
- **Spreading load.** A localhub picks at least two webhubs at random, weighted by `100 − load_pct`, and re-picks when one fails or passes 90%.
- **Bootstrap.** The first list comes from the client's configuration and from a list published outside the network (`docs/webhubs.json` in this repository). A peer cut off from every webhub can't learn of a new one through the network it has lost.

## 11. Scribes and async members

- A room is mirrored only when its `members` record has `async: true`.
- A **scribe** is any member localhub with HTTPS access. On an interval, or after enough messages (*provisional*: 60 seconds or 50 messages), it seals the new envelopes into one `msg` record and posts it to at least two webhubs.
- An **async member** reads the room's records, opens the bundles, and posts its own sealed replies as `msg` records.
- The scribe reads those on its next visit and delivers the inner envelopes to the live room through the existing relay path (`v6/hub/relay.ts`). Envelope deduplication on `(from, id)` makes this idempotent, so several scribes may serve one room.
- A scribe could withhold messages. Several scribes, several webhubs, and the `seq` counter together make a gap visible and usually filled.

## 12. Abuse limits

Carrying everything means one careless webhub could flood the rest. Every limit below is therefore checked by every webhub on every record.

- **Stamp.** `members` and `topic` records carry `stamp`, a value such that SHA-256 of the record id computed without `stamp`, followed by `stamp`, has at least 20 leading zero bits (*provisional*). It needs no accounts and every webhub checks it identically. A webhub may demand more for direct submissions; it accepts the protocol minimum by sync.
- **Per room** (*provisional*): 4 MiB and 2,000 records held at once.
- **Per holder key:** 8 live rooms, 8 live topics.
- **Per sender key:** 600 records an hour per room.
- **Network budget.** Because a webhub must carry everything, total volume has to fit the smallest conforming webhub. The limits above are sized for one that runs on a free hosting tier. Raising them is a protocol change.

## 13. Surviving without webhubs

- **Room logs live on localhubs.** A bag is a copy with a short life.
- **A localhub implements this same interface.** It holds the same topics and answers the same searches for its libp2p neighbours, so discovery continues with no webhub alive.
- **Recovery needs no coordination.** When any webhub returns, scribes refill it from their logs and async members resume from their cursors.
- **Who is cut off:** only peers for whom path 5 was the only path, and only until one webhub is reachable.

## 14. The template

Three layers. Only the third is specific to a platform.

1. **Specification:** this document.
2. **Conformance suite:** tests that run against any URL and report whether it behaves as a webhub. A deployment that hasn't passed is not a webhub.
3. **Core plus adapter:** the checks, sync and search logic are written once, against four services.

```ts
interface Store     { put(r: Rec): Promise<number | 'dup'>; after(pos: number, room?: string, limit?: number): Promise<Rec[]>; expire(now: number): Promise<number> }
interface Timer     { every(seconds: number, job: () => Promise<void>): void }
interface Embedder  { profile: { model: string, dimensions: number, prefix: string }; embed(texts: string[]): Promise<Float32Array[]> }
interface Index     { upsert(id: string, v: Float32Array): Promise<void>; remove(id: string): Promise<void>; nearest(v: Float32Array, k: number): Promise<Array<{ id: string, score: number }>> }
```

| Service | Cloudflare | AWS | Supabase | Single binary |
|---|---|---|---|---|
| Store | Durable Object (SQLite) | DynamoDB | Postgres | SQLite |
| Timer | Alarm | EventBridge | pg_cron | in-process |
| Embedder | Workers AI `@cf/google/embeddinggemma-2` | Bedrock or a container | none (bag-only) | local ONNX |
| Index | in-memory, or Vectorize | OpenSearch | none (bag-only) | in-memory |

**The index is never standardised.** A small webhub searches by brute force; a large one partitions vector space; a company uses its own vector database. All answer the same call.

**The conformance suite must include the Moltbook test:** no request that lacks a valid signature may read or write anything but the public calls of §7, and no platform credential or database endpoint is reachable by a client.

## 15. Frozen at v1

These can't change without a new `v`:

1. The common record form and the signing domain `vortex-webhub-v1\0`.
2. Record id as the hash of the signing bytes.
3. Mandatory `exp`.
4. Room id derived from the holder's key.
5. The fixed key order per kind.
6. `content_type` on topics.

Everything else (limits, floors, intervals, embedder, index, platform) is advertised or local.

## 16. Relation to earlier amendments

- **A6:** the screen runs at the sender before sealing, and at the webhub on topic text (§6).
- **A7:** key ids, custody tiers and `VX-Auth` are reused unchanged. An unsealed key may use a webhub only for the named rooms and lifetime A7 §2 already allows it.
- **A8:** econ messages are room traffic and are carried like any other. A webhub takes no part in IOUs.
- **`v6/p2p`:** inner envelopes are unchanged. Multi-hop forwarding between localhubs is still not specified.

## 17. Open and unmeasured

1. **Supabase supplements `vortexd`; it does not replace it** (operator, 2026-11-13). A webhub is a REST service and never speaks libp2p. The localhub stays `vortexd` and reaches webhubs through a connector (§10, §11). A Supabase webhub, hosted or in a local container, is one more adapter under §14. Supabase is the first adapter built and Cloudflare the second.
2. **Hosted and local embedders may rank near-ties differently.** The local build is quantised; the hosted one is probably not. It should be measured, though it matters less now that vectors don't travel.
3. **Ranking at scale.** The H3 calibration used 160 statements from one author. With a million topics, many unrelated ones will clear the floor.
4. **Free-tier fit.** Whether Cloudflare's hosted embedder allowance applies on a free plan is unverified. The operator's own two webhubs run on paid plans, so neither question blocks them; both still matter for volunteers on free tiers, which is why §12 stays sized for a free tier. Free Supabase projects pause after a week idle, and whether sync traffic prevents that is unverified.
4a. **Discovery for peers with no embedder.** Supabase's hosted embedding offers only a different model, so its adapter does no search (§9). A peer that can't embed and can't reach a searching webhub gets its answer late, through `match` records (§9), once any embedding node has seen its topic.
5. **Metadata.** Any webhub operator sees room ids, key ids, sizes and timing. Per-room sender keys would reduce this.
6. **Forward secrecy** within an epoch.
7. **Absent holders.** A transfer record would let a holder hand a room on.
8. **Stamp difficulty** is a guess until there is traffic to measure.

## 18. Work plan (each at most 30 minutes for a frontier model)

1. Conformance suite, part 1: record form, signatures, ids, bounds, ingest checks (§5, §8.1).
2. Conformance suite, part 2: room reads, feed paging, duplicates, expiry, quotas, the Moltbook test (§7, §12, §14).
3. Conformance suite, part 3: topic search, find-or-create, `match` records, hub announce (§9, §10). Search cases run only against a webhub that advertises an embedder; a bag-only one must answer 501.
4. Core: record verification and canonical encoding, shared by all adapters.
5. Core: ingest, sync and expiry over the `Store` and `Timer` services.
6. Core: topic search over `Embedder` and `Index`.
7. Supabase adapter and deployment.
8. Cloudflare adapter and deployment.
8a. Single-binary adapter inside the localhub.
9. Room key wrapping and bundle sealing in the client.
10. Scribe in the bridge.
11. Webhub selection and cursors in the localhub.
12. Measure hosted against local embedder (§17 item 2).
