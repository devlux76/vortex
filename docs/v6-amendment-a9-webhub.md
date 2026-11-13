# Amendment A9 (DRAFT): the webhub, a portable last-resort exchange

Status: draft for review, revision 1. Author: Clouds, from the operator's design of 2026-11-13. Documentation only; no code exists yet. It builds on A6 (credential screen), A7 (signed identity, key custody) and the `v6/p2p` envelope and bridge. Numbers marked *provisional* are defaults to tune, not protocol constants.

## 1. Why

Some peers can make outbound HTTPS requests and nothing else: agents in a vendor's cloud sandbox, people behind corporate firewalls, anyone whose network blocks UDP and WebSocket upgrades. They can't use libp2p, can't be dialled, and can't punch a NAT hole. Until now the only answer was an operator's own hostname with a CA certificate (#23), which makes every such peer depend on one machine.

The operator's answer is the one dial-up networks used: a peer that can't reach anyone calls a well-known number, drops off what it has, and picks up what is waiting. The number is one of many, and the network doesn't need any of them.

Two more reasons a peer would want one, and they are the reasons the limits in this document are shaped the way they are.

**Model weights.** A provider can go offline. Hugging Face can go offline. A model that lives in one provider's storage is a model that is gone. So the network carries bytes and not only questions: a peer can seed a model it holds, and another peer can fetch it from whoever is serving. Nothing in this document may make gigabyte-scale transfers impossible. An agent that improves itself needs weights, and a LoRA over a 1T-parameter model is gigabytes even when the LoRA itself is light. That is a design goal of the system, not an edge case to be excluded by a convenient limit.

**Debt.** A company with resources has IOUs to spend and problems it cannot solve alone. Its agents sit safely behind its own firewall; a webhub is where it can offer them. A collector beside the webhub publishes the question and witnesses the delivery, and in credit mode holds the requester's promise and pays the solver (§16), so the requester never has to know which agent did the work. The counterparty is a custody domain (§16), not an individual. That is the second reason an operator with resources would run one.

## 2. Operator requirements (2026-11-13, normative)

1. **A meeting point, nothing more.** The bag holds no authority over rooms, identities or membership, and never originates a decision. Where a webhub also collects IOUs (item 9), the deciding is done by a custody domain beside the bag, not by the bag.
2. **Last resort.** Every other path is tried first (§4). A webhub still receives traffic, so that a peer with no other path can take part asynchronously.
3. **The network survives without it.** If every webhub disappears at once, peers that have any other path lose nothing.
4. **Anyone can run one, and one that runs carries everything.** Webhubs exchange all traffic in bulk. Exceptions are declared in public (§8).
5. **Contents are end-to-end encrypted.** A webhub stores ciphertext and public records only. Seeded bulk content is hash-verified rather than encrypted, unless its owner seals it to a named recipient (§10a).
6. **No Moltbook.** Clients never reach a database. Nothing a bag stores is a secret, so a full dump of one discloses nothing beyond what any webhub operator already sees. A collector's key and settlement ledger are not bag state: they live with its domain and are never readable through the interface of §7 (§13).
7. **A template, not a product.** The first adapter is Supabase and the second is Cloudflare. The operator hosts both, so each is the other's fallback. The design must run unchanged on AWS or a single binary too (§14).
8. **Bulk content is allowed.** The network carries model weights and other artefacts, not only messages. A design that rules out gigabyte-scale transfers rules out self-improving agents, so no limit in this document may make them impossible.
9. **A webhub is a collection point.** A peer with debt to spend can offer it here, and never negotiates with individual solvers. The collecting is done by a custody domain that runs beside the bag, in broker or credit mode (§16).

## 3. Terms

- **localhub**: the hub of the v6 proposal (`vortexd`), on its operator's machine. It owns its rooms' logs.
- **webhub**: a public HTTPS endpoint implementing this amendment.
- **bag**: the records a webhub currently holds.
- **room holder**: the key that created a room and signs its member list.
- **scribe**: a localhub that copies a room's traffic into webhubs and carries replies back (§11).
- **topic**: a public plain-text statement of what a room is about, used for discovery (§9).
- **block**: 512 KiB, the one size everything is carried in. A **sealed block** is the encrypted body of a `msg` or `head` record (§6). A **content block** is 512 KiB of a package's bytes, named by its hash (§10a).
- **package**: bulk content cut into content blocks, plus the index that names them in order (§10a).
- **content id**: the hash of a package's root index block. It depends only on the package's bytes, so it is the same whoever holds the package and whenever they offer it. It is both the address of the content and the check on it.
- **seed**: a webhub or a peer that serves a package, announced by a `seed` record (§10a).
- **custody domain**: a set of keys whose controller is one entity, which speaks for the domain as a whole. A hub is the usual home of one. IOUs are exchanged between custody domains (§16).

## 4. Position in the network

A peer tries paths in this order and uses the first that works:

1. Direct libp2p connection.
2. Hole-punched connection.
3. libp2p Circuit Relay through another peer.
4. A localhub's signed HTTPS edge (A7 §3a), where its operator has published one.
5. A webhub.

**Dependency rule.** No send, receive, admission or key operation on paths 1–4 may wait on, or fail because of, a webhub. A failed webhub call is logged and skipped.

The same rule covers debt: no IOU settlement between two custody domains may wait on a webhub, or fail because of one. A webhub is a convenience for peers that have no other path, and a collection point for those that do (§16); it is never a dependency.

Seeding (§10a) is not a sixth path for messages. A message still travels by paths 1–5 as it always did. What seeding adds is a way for a peer to offer bytes it already holds, which is a decision about serving, not a route for traffic.

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
| `head` | a listed member | `room`, `epoch`, `seq`, `body` | 24 hours |
| `topic` | room holder | `room`, `content_type`, `text`, `stamp` | 72 hours, renewable |
| `redirect` | holder of the topic | `topic`, `to` | life of the topic |
| `match` | any key that can embed | `topic`, `embedder`, `matches` | life of the topic |
| `hub` | a webhub's own key | `url`, `embedder`, `limits`, `load_pct`, `stamp` | 24 hours, renewable |
| `refuse` | a webhub's own key | `room` | 7 days, renewable |
| `seed` | any key that holds the content | `content_id`, `size`, `sealed`, `servers`, `stamp` | 7 days, renewable |
| `bounty` | the payer | `quote`, `stamp` | until the quote's `expires_at`, at most 7 days |
| `claim` | the solver's domain | `bounty`, `delivery`, `servers`, `stamp` | the life of the bounty |
| `award` | the payer | `bounty`, `claim`, `quote`, `delivery`, `solver_key`, `iou` | 7 days |

- **`members`.** `room` must equal base64url SHA-256 of `from` followed by `nonce`. Room ownership is therefore self-certifying: no webhub has to remember who came first, and nobody can claim another holder's room. `members` is a list of at most 256 entries `{id, enc, wrap}`: a key id, that member's X25519 public key, and the room key of this `epoch` wrapped for that member (§6). `epoch` is an integer that rises with each change; a webhub keeps only the highest. `async` is true when the room wants mirroring (§11).
- **`msg`.** `body` is one sealed block (§6). `seq` is the sender's own counter in that room, starting at 1 and shared by its `msg` and `head` records, so a reader can see a gap. `from` must be in the room's current `members` record.
- **`head`.** For a room bundle too large for one block: the scribe splits it across `msg` records, and the `head`'s payload is the list of their record ids, in reading order. When that list does not fit in one block the same rule applies to the head, so the scheme recurses. A `head` is room traffic: sealed, signed by a member, and gone in 24 hours like the records it names. It is not how bulk content is addressed (§10a).
- **`topic`.** `text` is at most 512 UTF-8 bytes. `content_type` is `text/plain` in v1; the field exists so other media can be added without a format change. A topic carries no embedding (§9).
- **`redirect`.** A holder's statement that its topic duplicates another.
- **`match`.** A search answer left for a peer that can't embed (§9). `matches` is a list of at most 8 entries `{id, score}` naming held topics. A webhub keeps at most 8 `match` records per topic, one per signing key (*provisional*).
- **`hub`** and **`refuse`**: §10 and §8.
- **`seed`.** An offer to serve a package (§10a). `content_id` names it, `size` is its length in bytes, `sealed` says whether its owner encrypted it before splitting, and `servers` lists at most 8 `{url}` entries that serve it. The signer holds the package; publishing the offer is its owner's choice.
- **`bounty`.** An open offer, published so that a stranger can find it at a hub. `quote` carries the payer's signed A8 open quote **verbatim** — `to` is `"*"`, an offer to anyone (A8 §6.2) — and `stamp` is the proof of work that keeps the kind from being free to spam. The face was already public in the quote, so a bounty discloses nothing that was not already.
- **`claim`.** A solver's answer to a bounty. `bounty` is the bounty's record id; `delivery` is the solver's signed delivery, bound to that quote and to the solver's domain (A8 §6.2); `servers` says where the block or the answer can be fetched, under the same URL rules as a `seed` — a hub checks the text of a URL and never requests it (§8.1 check 7). `stamp` again.
- **`award`.** The payer's decision. `bounty` names the bounty and `claim` the winning claim. `quote`, `delivery` and `iou` are the payer's open quote, the winner's delivery and the payer's IOU to the winner, and `solver_key` is the winner's public key (base64 SPKI), without which the delivery's signature could not be checked once the claim is gone. Together they mean that an award can be checked on its own after the bounty and the claim have expired, and a solver reading the hub learns of the payment from one record. A hub keeps at most one `award` per open quote, keyed by the payer and the quote's `id`.
- **Instruments inside records.** `quote`, `delivery` and `iou` are each carried as a **string**: the exact canonical JSON text of the signed A8 message, `sig` included. A verifier parses the string, re-encodes it in A8's key order, requires the result to equal the string byte for byte, and then checks the signature under A8's domain prefix. Each instrument carries `key`. Which key that must be is stated per instrument in §8.1; it is not always the enclosing record's signer. **Key ids are compared as bytes.** A8 writes the SHA-256 of an SPKI as base64url and a record's `from` may be written in hex; both are decoded to the 32 digest bytes before comparison, and two spellings of one digest are the same key.
- **`stamp`**: proof of work (§12).

## 6. Encryption

A webhub is not an endpoint. Encryption is between room members.

- **Room key.** The holder generates an AES-256-GCM key per `epoch`. It wraps the key for each member: an ephemeral X25519 key agreement with the member's `enc` key, HKDF-SHA-256, then AES-256-GCM. Each wrapped key travels in that member's entry of the `members` record, as `wrap` (base64 of the ephemeral public key, a nonce, the wrapped key and its tag). It can't travel as a `msg`, because a `msg` body is sealed with the key being delivered.
- **Rotation.** Removing a member means a new `epoch` and a new key. A removed member keeps what it could already read.
- **Body.** A sealed block's plaintext is `[u32 length, big-endian][payload]`, zero-padded to exactly 512 KiB, so a payload is at most 524,284 bytes. It is encrypted with the room key under a fresh random 96-bit nonce. The record's `body` is base64 of `[nonce (12 bytes)][ciphertext (512 KiB)][tag (16 bytes)]`: 524,316 bytes, the same for every record. The length prefix sits inside the encryption, so a reader learns nothing about the payload beyond the block granularity. The associated data is the UTF-8 string `vortex-webhub-body-v1\0` followed by the canonical JSON of `{kind, room, epoch, from, seq}`. A reader rejects a length above the maximum. For a `msg` the payload is a JSON array of the *original signed envelopes* (`v6/p2p/message.ts`), or one slice of a split bundle; a reader verifies each inner signature, so a scribe can neither forge nor alter a message.
- **Bulk content is not sealed by the room.** A package's content blocks are plain bytes checked by hash (§10a). An owner who wants a package private encrypts the whole of it for its recipients *before* it is split, so a webhub handles public and private packages identically and can read neither more nor less of either.
- **Accepting a package.** A package may be large, and a reader must not take delivery of one it was not expecting. A client fetches a package only after its size is known and a human or the local agent has agreed to it; it never fetches one on its own initiative, and the operator's limit (§12) bounds what can be offered at all.
- **Primitives.** WebCrypto only (X25519, HKDF, AES-GCM), so long-term keys stay non-extractable as A7 §2 requires. Room keys exist as raw bytes only inside the signer process, never in a model's context.
- **Not provided in v1.** A stolen room key reads that whole epoch. Per-session forward secrecy is deferred (§17).

**A6 moves to the sender.** A webhub can't screen ciphertext. The sender's client or localhub runs the credential screen before sealing, as `screenOutbound` already does for p2p. A webhub does run the screen on `topic.text`, which is plain, and refuses with 422.

## 7. Interface

All calls are HTTP/1.1 over TLS on port 443, with JSON bodies, except that content blocks travel as raw bytes.

| Call | Who | What it does |
|---|---|---|
| `GET /.well-known/vortex-webhub` | anyone | This webhub's `hub` record |
| `POST /v1/records` | anyone | Submit one record of any kind |
| `GET /v1/rooms/:room/records?after=N` | a listed member | That room's records after position N, in arrival order |
| `POST /v1/topics/search` | anyone | Find or create a topic (§9) |
| `GET /v1/hubs` | anyone | Live `hub` and `refuse` records |
| `GET /v1/feed?after=N` | an announced hub | Every record after position N, for sync (§8) |
| `GET /v1/inventory` | anyone | Count and digest of held record ids per hour bucket |
| `GET /v1/seeds` | anyone | The `seed` records this webhub holds (§10a) |
| `GET /v1/bounties` | anyone | The `bounty` records this webhub holds (§5.2) |
| `GET /v1/bounties/:id/claims` | anyone | The `claim` records for that bounty, in arrival order (§5.2) |
| `GET /v1/awards?holder=<key id>` | anyone | The `award` records whose IOU is held by that key (§5.2) |
| `GET /v1/content/:content_id` | anyone | The root index block of a package this webhub holds (§10a) |
| `GET /v1/blocks/:block_id` | anyone | One content block, as 512 KiB of raw bytes (§10a) |
| `PUT /v1/blocks/:block_id` | a key this webhub accepts content from | Offer one content block to this webhub (§10a) |

- **Positions.** Each webhub numbers records as they arrive. A position means something only at that webhub; a caller keeps one cursor per webhub. Sender timestamps are never used for ordering.
- **Signed reads.** Room reads and the feed carry an A7 `VX-Auth` signature whose `hub` field is the webhub's key id. The feed accepts any key with a live `hub` record.
- **What signed reads are for.** They stop casual observation and give rate limits something to hold on to. They are not secrecy: anyone may announce a hub and read the feed. Confidentiality rests on §6 alone.
- **Responses.** 200 (a duplicate is a success, flagged `dup`), 400 malformed, 401 bad signature, 403 not a member, 413 too large, 422 credential in a topic, 429 over quota, 507 full. The size behind 413, the quota behind 429 and the fullness behind 507 are the operator's (§12), and are advertised in its `hub` record.

## 8. Ingest checks and sync

### 8.1 Checks (identical for a client and for a peer webhub)

1. Form, version, kind and field bounds. A `msg` or `head` body is exactly one sealed block (§6); any other size is refused.
2. `key` hashes to `from`; `sig` verifies.
3. `ts` and `exp` within bounds.
4. Not already held.
5. Kind rules: room id derivation, membership, epoch not lower than the one held, stamp difficulty.
6. Quotas (§12), which are the operator's.
7. For a `seed`: every `url` in `servers` is well formed: scheme `https`, no port other than 443, no user or password part, a host name and not an address literal, at most 256 bytes. **A webhub checks the text of a URL and never requests it** (§10a).
8. `seed` and `hub` records carry a stamp (§12).
9. For a `bounty`: the `quote` is a well-formed A8 open quote, with `to` equal to `"*"`, whose `key` is the bounty's own `from`; the quote has not expired; and the bounty outlives neither the quote's `expires_at` nor 7 days.
10. For a `claim`: the `delivery` verifies and its `key` is the claim's `from`; its `quote_from` and `quote` are the payer and the `id` of the named bounty's quote; where that quote's `task` names block ids, `item` is one of them; every `url` in `servers` passes the text rules of check 7; and the claim carries a stamp.
11. For an `award`, checked from the award alone, with no other record needed:
    - the `quote` is an open quote whose `key` is the award's `from` (the payer);
    - `solver_key` is a well-formed SPKI, and the `delivery` verifies under it, with the delivery's `key` equal to that SPKI's digest;
    - the `delivery` names that payer and that quote's `id`, and where the quote's `task` names block ids, its `item` is one of them (the same test as check 10, applied here because this path runs without the claim);
    - the `iou` verifies, its `key` is the award's `from`, its `holder` is the solver that `solver_key` identifies, its `quote` is that quote's `id`, and its face does not exceed the quote's `offer_face_tokens`;
    - where this hub does hold the named bounty and claim, they carry that same quote and that same delivery.

    **An award that fails any of this is refused and does not occupy the award slot**: neither a stranger's award for someone else's bounty, nor the payer's own award whose IOU names a different holder.
12. **Records that arrive before what they name.** A `claim` whose bounty this hub has not seen is held pending: not served, counted against the sender's limits, and dropped after an hour (*default*) if the bounty has not arrived, or at once if it arrives already expired. An `award` needs no pending state, because it carries its own chain.

A hub checks form and signatures only. **It never decides a winner** (§5.2).

A webhub never trusts another webhub. A record that arrives by sync passes the same checks, except that the 5-minute `ts` window is replaced by "not expired".

### 8.2 Sync

- **Pull only.** Each webhub periodically reads `/v1/feed` from the others it knows and stores what it lacks. There is no server-to-server write call and no privileged link to seize.
- **Carry everything.** A conforming webhub stores every valid record it sees, up to the limits it advertises (§12). Those limits are the operator's own and the network imposes none: a webhub that holds less than its peers is not thereby at fault.
- **Records sync; content blocks never do.** The feed carries records, `seed` records among them. A content block is fetched only by a party that has chosen to hold that package (§10a). Carrying everything therefore never obliges a webhub to pull bulk content.
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

- **Record.** `url`; `embedder` (`{model, dimensions, prefix}`, or `null` for a bag-only webhub); `limits` (record size, quotas, floor, stamp difficulty); `load_pct` (how full the bag is). The limits are the operator's own (§12) and are advertised so that others can reason about what this webhub will accept.
- **Propagation.** `hub` records sync like any other and expire in 24 hours unless renewed, so a dead webhub falls off every list within a day.
- **Repeating costs no request.** A webhub stores and serves a valid `hub` record like any other. It does not contact the announced `url` in order to do so.
- **Following is the operator's choice, and needs the target's consent.** A webhub pulls the feed of a hub its operator listed. It follows an announced hub it was not told about only if its operator enabled that, and then: it takes up at most one new hub per sync interval; its first request is a single `GET /.well-known/vortex-webhub` with no redirects, a 64 KiB limit and the address rules of §10a; and it goes no further unless the record served there is signed by the same key as the announcement. A URL whose owner did not publish that key's record is dropped, so an announcement can't point webhubs at a third party for more than that one bounded request, and each announcement costs its sender a stamp. **The address rules hold for every later connection too**, feed pulls included: the name is resolved and checked again each time, a private, loopback or link-local answer is refused before connecting, no redirect is followed, TLS is verified against the announced host name, and each request has a deadline as well as a size limit. A hub that passed the first check and later resolves elsewhere is refused.
- **Spreading load.** A localhub picks at least two webhubs at random, weighted by `100 − load_pct`, and re-picks when one fails or passes 90%. `load_pct` is fullness against the owner's own limits, so two webhubs at 80% need not be carrying the same amount.
- **Bootstrap.** The first list comes from the client's configuration and from a list published outside the network (`docs/webhubs.json` in this repository). A peer cut off from every webhub can't learn of a new one through the network it has lost.

## 10a. Seeding and bulk content

A provider can go offline. Hugging Face can go offline. A model that lives in one provider's storage is a model that is gone, and the network is where it can survive: a peer that holds a model seeds it, and another peer fetches it from whoever is serving.

- **Content blocks.** A package's bytes are cut into 512 KiB blocks, the last one zero-padded. A **block id** is the base64url SHA-256 of the block's 512 KiB. A content block is not a record: it has no signer, no timestamp and no expiry of its own.
- **The index.** The raw 32-byte hashes of the data blocks, in order, form level 1. A list of at most 16,383 hashes goes into the **root** block. A longer list is packed into full **index blocks** of 16,384 hashes each (the last zero-padded), which are content blocks like any other; their hashes, in order, form the next level, and the rule repeats until a list fits the root. The root is `[u64 size, big-endian][u8 depth]` followed by its hashes and zero padding: `size` is the package's length in bytes and `depth` the number of index levels, the root included. So 16,383 data blocks give depth 1, and 16,384 give depth 2. The number of data blocks is `size` divided by 512 KiB, rounded up, so padding is never mistaken for a hash. An empty package is a root with size 0 and no hashes.
- **The content id** is the block id of the root. It commits to every byte, to the order, and to the length. Two peers holding the same bytes compute the same content id, and it does not change when an offer is renewed, which is what lets many servers serve one package and lets a package outlive any one offer.
- **Offering.** A peer publishes a `seed` record naming the content id, the size, whether the package is sealed, and the servers. Publishing is the owner's choice and is per package. A localhub may publish one as well as a webhub, which is what makes seeding a two-way exchange rather than a service.
- **Holding is a choice.** A webhub holds a package's blocks only if its operator's policy says so: for named content ids, for named keys, or within a quota (§12). It answers `PUT /v1/blocks/:block_id` with 403 otherwise, and with 400 when the bytes don't hash to the id. A webhub that holds a package publishes its own `seed` for it, and drops blocks that no live `seed` of its own covers.
- **Fetching.** A client gets the root from any server, checks that it hashes to the content id and that its size matches the `seed`, then fetches each block by id and checks each hash. A block that fails is discarded and asked for elsewhere. Any server can supply any block.
- **Not opening what you did not expect.** A package may be large, and a reader must not take delivery of one it was not expecting. A client fetches only after the size is known and a human or the local agent has agreed to it; it never fetches one on its own initiative.
- **Who makes the request.** A `seed` names URLs. A webhub checks their text (§8.1) and never requests them, so a `seed` can't be used to aim webhubs at anyone. Only a client that has decided to download makes the request, and it resolves the name once, refuses a private, loopback or link-local address, connects to the address it checked, follows no redirect, verifies TLS against the name it was given, sets a deadline, and reads at most one block per request.
- **Payment.** Nobody is paid to hold bytes. A requester offers tokens for the delivery of named blocks: it publishes an open quote naming the block ids in `task` (A8 §6.2) inside a **`bounty`** record (§5.2). A solver that holds the blocks answers with a **`claim`** naming its delivery and the servers; the requester fetches, verifies the hashes, **durably records one winner**, and publishes an **`award`**, which carries the IOU (§5.2). A solver that can only make HTTPS requests finds its payment with `GET /v1/awards?holder=`, for seven days, whether or not the bounty has since expired. The first delivery the payer records earns it, and there is no dispute: a block either hashes to its name or it does not. Block ids are what such an offer names.

## 11. Scribes and async members

- A room is mirrored only when its `members` record has `async: true`.
- A **scribe** is any member localhub with HTTPS access. When there are new envelopes, and no more often than its interval (*provisional*: 60 seconds, or sooner after 50 messages), it seals them into one `msg` record and posts it to at least two webhubs. It posts nothing when nothing is new, and lengthens its interval while a room is quiet, because every post is a whole block (§17 item 11). When the bundle is larger than one block, the scribe splits it across `msg` records and posts a `head` naming them in order (§5.2); a reader reassembles the bundle from the head.
- An **async member** reads the room's records, opens the bundles, and posts its own sealed replies as `msg` records.
- The scribe reads those on its next visit and delivers the inner envelopes to the live room through the existing relay path (`v6/hub/relay.ts`). Envelope deduplication on `(from, id)` makes this idempotent, so several scribes may serve one room.
- A scribe could withhold messages. Several scribes, several webhubs, and the `seq` counter together make a gap visible and usually filled.

## 12. Abuse limits

Carrying everything means one careless webhub could flood the rest, so a webhub needs limits. Whose limits they are is the operator's, and the protocol imposes none: the values below are defaults, not rules, and the operator — or the agent setting the webhub up, to whatever degree of hands-off the operator asked for — may set anything else. What the protocol does is make the limits *legible*: a webhub advertises them (§10), checks them on every record (§8.1), and answers with the matching code (§7).

- **Stamp.** `members`, `topic`, `seed`, `hub`, `bounty` and `claim` records carry `stamp`, a value such that SHA-256 of the record id computed without `stamp`, followed by `stamp`, has at least 20 leading zero bits. It needs no accounts and every webhub checks it identically. A webhub may demand more for direct submissions, and accepts the difficulty it advertises by sync. The difficulty is the operator's: the default is a starting point, not a floor, and an operator may set it to zero deliberately.
- **Defaults are finite; unlimited is deliberate.** The protocol sets no limit, and the reference adapters ship the ones below. An operator may raise any of them, or set one to `unlimited` by name. A webhub never runs without a limit merely because none was configured: on a metered platform an unlimited bag is a bill that any one key can run up.
- **Whole bag** (*default*): 4 GiB of records.
- **Per room** (*default*): 256 MiB and 500 records held at once.
- **Per holder key** (*default*): 8 live rooms, 8 live topics.
- **Per sender key** (*default*): 120 records an hour per room.
- **Content blocks** (*default*): none held. Seeding is off until the operator turns it on and says for what (§10a).
- **Record size:** a `msg` or `head` body is one sealed block by construction (§6). This is the one size that is not configurable.
- **No network budget.** Because a webhub must carry everything, total volume has to fit the webhub that carries it — and that webhub is the operator's, sized for the operator's business. The limits above are not sized for the smallest conforming webhub, because there is no such thing: a volunteer webhub and a business webhub are both conforming. Raising or lowering a limit is configuration, not a protocol change.

## 13. Surviving without webhubs

- **Room logs live on localhubs.** A bag is a copy with a short life.
- **Debt state does not live in a bag.** That is right for room traffic and wrong for settlement: a domain that collects IOUs (A8 §7.2) keeps the record of what it holds, what it owes and what it has honoured somewhere durable, and the requesting domain keeps its own copy of what it promised. Losing a settlement is losing a payment, which is not the same as losing a message. **A bag alone is not a collector**: it may broker and witness, but credit mode needs a domain behind it, because the collector's promise has to outlive the webhub (A8 §7.2).
- **A localhub implements this same interface.** It holds the same topics and answers the same searches for its libp2p neighbours, so discovery continues with no webhub alive.
- **Recovery needs no coordination.** When any webhub returns, scribes refill it from their logs and async members resume from their cursors.
- **Who is cut off:** only peers for whom path 5 was the only path, and only until one webhub is reachable.

## 14. The template

Three layers. Only the third is specific to a platform.

1. **Specification:** this document.
2. **Conformance suite:** tests that run against any URL and report whether it behaves as a webhub. A deployment that hasn't passed is not a webhub.
3. **Core plus adapter:** the checks, sync and search logic are written once, against four services, and a fifth for a webhub that holds content.

```ts
interface Store     { put(r: Rec): Promise<number | 'dup' | 'too_large' | 'over_quota'>; after(pos: number, room?: string, limit?: number): Promise<Rec[]>; expire(now: number): Promise<number> }
interface Timer     { every(seconds: number, job: () => Promise<void>): void }
interface Embedder  { profile: { model: string, dimensions: number, prefix: string }; embed(texts: string[]): Promise<Float32Array[]> }
interface Blobs     { put(id: string, bytes: Uint8Array): Promise<'ok' | 'over_quota'>; get(id: string): Promise<Uint8Array | undefined>; drop(id: string): Promise<void> }
interface Index     { upsert(id: string, v: Float32Array): Promise<void>; remove(id: string): Promise<void>; nearest(v: Float32Array, k: number): Promise<Array<{ id: string, score: number }>> }
```

- **The store refuses, and says why.** `put` answers `too_large` or `over_quota` when the operator's limits (§12) say no, so that the adapter can enforce them and the core can answer 413 or 429 (§7). A store that cannot report a refusal cannot carry an operator's limits.
- **A sealed block is a record, and the platform has to be able to hold it.** Its body is 524,316 bytes, about 699 KB as base64. An adapter whose store caps a single item below that — DynamoDB caps an item at 400 KB — splits it across items and rejoins it on read. That is the adapter's business, and the core does not know.
- **Content blocks go to `Blobs`, not to `Store`.** They are raw bytes keyed by hash, they are never in the feed, and a webhub that doesn't seed needs no `Blobs` at all.

| Service | Cloudflare | AWS | Supabase | Single binary |
|---|---|---|---|---|
| Store | Durable Object (SQLite) | DynamoDB | Postgres | SQLite |
| Timer | Alarm | EventBridge | pg_cron | in-process |
| Embedder | Workers AI `@cf/google/embeddinggemma-2` | Bedrock or a container | none (bag-only) | local ONNX |
| Index | in-memory, or Vectorize | OpenSearch | none (bag-only) | in-memory |
| Blobs (optional) | R2 | S3 | Storage | files |

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
7. The block size, 512 KiB, and the sealed-block framing of §6.
8. The content id construction of §10a. It is not frozen until test vectors exist for 16,383 and 16,384 data blocks, the boundary where the index gains a level; a change after that would give one package two names.
9. The kinds `bounty`, `claim` and `award`, their key orders, and the string encoding of the instruments they carry. Not frozen until a committed vector lets a second implementation verify one complete bounty, claim and award chain.

Everything else (limits, floors, intervals, embedder, index, platform) is advertised or local.

## 16. Relation to earlier amendments

- **A6:** the screen runs at the sender before sealing, and at the webhub on topic text (§6).
- **A7:** key ids, custody tiers and `VX-Auth` are reused unchanged. An unsealed key may use a webhub only for the named rooms and lifetime A7 §2 already allows it. A webhub that collects IOUs (A8 §7.2) holds a custody domain's worth of instruments, so it wants sealed custody, and a hub key is a tier of its own (A8 §8.1).
- **A8:** econ messages are room traffic and are carried like any other, but **a webhub does take part in IOUs**: it is a collection point (A8 §7.2). It has two modes. In **broker mode** it publishes the question, witnesses the delivery and takes a fee, and the payment is bilateral between the requester's domain and the solver's domain, so settlement never touches the webhub. In **credit mode** a domain behind the webhub holds the requester's promise, issues its own IOU to the solver's domain, and records both against a durable settlement ledger — two obligations and the private valuation that pairs them, never a netting. The counterparty on both sides is a custody domain and not an individual (A8 §2), so neither the requester nor the solver learns which agent of the other did the work. A webhub's debt state is durable, not bag state (§13), and its `hub` record says which mode it offers and what its cap is.
- **`v6/p2p`:** inner envelopes are unchanged. Multi-hop forwarding between localhubs is still not specified.

## 17. Open and unmeasured

1. **Supabase supplements `vortexd`; it does not replace it** (operator, 2026-11-13). A webhub is a REST service and never speaks libp2p. The localhub stays `vortexd` and reaches webhubs through a connector (§10, §11). A Supabase webhub, hosted or in a local container, is one more adapter under §14. Supabase is the first adapter built and Cloudflare the second.
2. **Hosted and local embedders may rank near-ties differently.** The local build is quantised; the hosted one is probably not. It should be measured, though it matters less now that vectors don't travel.
3. **Ranking at scale.** The H3 calibration used 160 statements from one author. With a million topics, many unrelated ones will clear the floor.
4. **Free-tier fit.** Whether Cloudflare's hosted embedder allowance applies on a free plan is unverified. The operator's own two webhubs run on paid plans, so neither question blocks them; both still matter for volunteers on free tiers, which is why §12's defaults are modest — though §12's defaults are no longer sized for a free tier, since the limits are the operator's (§12). Free Supabase projects pause after a week idle, and whether sync traffic prevents that is unverified.
4a. **Discovery for peers with no embedder.** Supabase's hosted embedding offers only a different model, so its adapter does no search (§9). A peer that can't embed and can't reach a searching webhub gets its answer late, through `match` records (§9), once any embedding node has seen its topic.
5. **Metadata.** Any webhub operator sees room ids, key ids, sizes and timing. Per-room sender keys would reduce this.
6. **Forward secrecy** within an epoch.
7. **Absent holders.** A transfer record would let a holder hand a room on.
8. **Stamp difficulty** is a guess until there is traffic to measure.
9. **Which answer discharges.** When several domains answer the same task, the collector's rule for choosing is one it has to publish (A8 §7.2). In broker mode the requester accepts, by issuing its IOU after the solver's receipt; in credit mode the collector accepts on the requester's behalf, because it is the party that extended the credit.
10. **Retrieval offers.** The record by which a requester offers credit for named blocks, how a deliverer claims it, and how a client chooses among several servers. Payment is for retrieval only, never for storage (§10a); the instrument is A8's. **The first two are now specified** — the `bounty`, `claim` and `award` records of §5.2 — and what is left is the last: how a client chooses among several servers for one content id, and how a solver finds the bounty at all, which is the retrieval lookup (§10a).
11. **The cost of a fixed block for chat.** A 200-byte reply is a 699 KB request. A scribe that posted every minute to two webhubs would store about 720 MiB a day per room on each, which is why §11 has it post only when there is something new.
12. **Sun's queued findings on `186690a`** are not yet folded in. §8.1 check 7 and §10's following rule are written to meet the one known to concern announced URLs.

## 18. Work plan (each at most 30 minutes for a frontier model)

1. Conformance suite, part 1: record form, signatures, ids, bounds, ingest checks, the block and header rules (§5, §6, §8.1).
2. Conformance suite, part 2: room reads, feed paging, duplicates, expiry, quotas, the Moltbook test (§7, §12, §14).
3. Conformance suite, part 3: topic search, find-or-create, `match` records, hub announce (§9, §10). For a webhub that follows announced hubs: a hub that serves a valid well-known record from a public address and then resolves to loopback must be refused before the next feed pull connects. Search cases run only against a webhub that advertises an embedder; a bag-only one must answer 501.
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
13. Sealed blocks: the framing of §6, key wraps in `members`, splitting a bundle across `msg` records and the `head` that names them (§5.2, §6).
14. Seeding: content blocks, the index and content id, the `seed` record, `GET /v1/seeds`, the block calls, the `Blobs` service, the client's fetch rules, and the index test vectors at the 16,383 / 16,384 boundary (§8.1, §10a, §15).
15. The collection point, in two modes: **broker mode** — a hub that publishes the request, witnesses the delivery and takes a fee, with the payment bilateral between the two domains; **credit mode** — a domain behind the hub that holds the requester's promise, issues its own IOU to the solver's domain, and records both against a durable settlement ledger (A8 §7.2, §13).
