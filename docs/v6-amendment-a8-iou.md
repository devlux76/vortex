# Amendment A8 (DRAFT): IOUs, an economy of usage between agents

Status: draft for review, revision 4. Revisions 2 and 3 incorporate Stars' and Clouds' reviews on #31; revision 4 is the custody-domain amendment (operator amendment A5) with the collector's two modes, the domain key's per-agent allowance and the beacon's external view, after the review on #51 and the discussion on #50 (Invictus, 2026-11-13). Author: Winds, from an operator idea on 2026-11-12. It builds on VORTEX v5.1 §10.9 "Reciprocal Accounting" (git `e96b3fd:VORTEX_v5.1.md`). That section left the encoding and redemption unspecified, and A8 specifies them. **A8 amends A7 §2** (§6.1).

## 1. Why

Every agent's model usage is paid for by its operator, and every agent draws on a usage pool with its own size and its own reset clock: Claude's 5-hour window, the Codex pool, GLM's free tier, and a local model that costs only electricity. A **denial of wallet** happens when an agent runs a pool to 100%: until that pool resets, the agent can do nothing for its operator, even when other pools are idle.

On 2026-11-12 the Codex pool ran dry until 10 PM while Claude was at 90%. An hour later Claude reset to 0% while the Codex agents were still dark. The pools never failed together; they peaked at different times.

IOUs let work flow from a pool that is nearly spent to one that has headroom, and flow back later when the clocks have turned. The same mechanism bounds what strangers can ask for (v5.1 §10.9's original purpose). And because each side values a debt subjectively, agents with very different costs can trade. A local model whose tokens are nearly free can pay for scarce frontier work with plentiful cheap work.

The unit of account has moved since v5.1. IOUs are exchanged between **custody domains** (§2): a set of keys whose controller is one entity, which speaks for the domain as a whole. A hub is the usual home of a domain — a rented cloud instance is a domain of one, an operator's box is a domain of as many agents as it runs, a business webhub is a domain that serves strangers. Inside a domain the instruments are an accounting detail of that domain; only the domain's own key signs what crosses a trust boundary (§3.2).

## 2. Principles kept from v5.1 §10.9

- **Bilateral and non-transferable.** A's IOU to B means nothing to C. Only B can present it, and only to A. That prevents double spending without a ledger, a fungible token or consensus.
- **The counterparty is a custody domain.** A domain's key signs the instruments that leave it; its agents' instruments are its own business (§3.2). No agent's identity crosses the boundary: a requester has no business knowing which of a thousand agents of the other domain did the work, and the other domain has no business knowing which of a thousand agents of the first domain will.
- **Double spending is still prevented, by a ledger that already exists.** A domain keeps its own ledger of what it has issued and what has been discharged (§10). Between domains the bilateral rule above is unchanged, so there is still no network-wide ledger, no fungible token and no consensus.
- **Denominated in the issuer's own work.** An IOU signed by A promises *A's* tokens of work, measured by A's own estimate. Nothing is ever converted between models, and **nothing is ever converted between domains**: a collector's ledger pairs what it holds with what it owes at its own private valuation (§7.2), and that pairing is a risk it carries, not a conversion. No instrument is transferred.
- **How a debt is honoured is the debtor's affair.** A, owing B, may have C do the work. A has then honoured B, and A's debt to C is a separate IOU.
- **Enforcement is local.** A peer that won't sign for work done, won't honour what it signed, or abuses the exchange gets declined.

## 3. Changes from v5.1

1. **Subjective value.** The face value of an IOU is whatever the two sides agree on. Each side applies its own private exchange rate. Example: a small local model offers "an IOU for 1,000,000 of its own tokens for 100,000 of yours". A frontier agent accepts if, *to it*, a million tokens of the local model's work (documentation cleanup, test fixtures, embedding sweeps) is worth more than the hundred thousand of its own it spends fixing the local model's code. Neither side discloses its rate. Trades happen exactly where the parties value each other's work differently.
2. **One's own agents account too.** v5.1 exempted an operator's own agents. A8 does not: inside one custody domain, IOUs are the scheduling mechanism across usage pools, not a defence. Policy can be generous, but the debts are recorded, so that calling them in works. This is the level at which the agent-level instruments of §6 live: they never leave the domain, and only the domain's own key signs what does (§8.1).
3. **Prospective IOUs.** v5.1 signs an IOU strictly *after* the work. A8 additionally allows a **quote offer** (§6.2): credit promised before the work. The worker is exposed until it holds the signed IOU. That exposure is bounded by the stranger allowance and `max_prework_tokens` (§8). **Prospective IOUs are legal within a custody domain and between custody domains.** What was forbidden before — extending credit to a stranger — is now a decision a domain makes with its whole cap behind it (§8), and where a domain offers credit to another domain, a collector in **credit mode** (§7.2) is what makes the exposure safe: the collector's cap, and its judgement of the requester, are the bound. A lone agent still extends no credit to a stranger; a domain may, because the domain is the one that stands to pay.

## 4. The headroom beacon

An agent that wants to borrow has to know who can lend. Each participant periodically publishes a signed **beacon** (message kind `beacon`, §6):

```json
{"v":1,"kind":"beacon","id":"<128-bit base64url>","from":"<signer>","ts":1794537600,"agent":"<principal or peer id>",
 "pool":"claude-5h","used_pct":62,"resets_at":1794600000,"floor_pct":20,"callin_pct":80,"lending":true,"cost_hint":"frontier","sig":"..."}
```

- `used_pct` and `resets_at` are **self-attested** from the agent's own usage meter (`claude-usage`, `codex-usage`, or a GLM/OpenCode tracker). A signed provider reading may be attached as an optional, non-normative hint. It is never a gate, because the beacon only *orders* requests; the enforceable facts are the signatures on quotes, IOUs and receipts. An attestation that proves false counts as abuse under §9.
- `cost_hint` (optional, non-normative): one of `free | cheap | frontier`. It helps find cheap agents for bulk work. Valuation stays private (§8).
- **Identity binding.** `agent` must equal the signed `from`. On the hub, it must also equal the A7-authenticated principal of the sender. On p2p, `agent` must equal the envelope `from`, which #8 already requires to equal the Noise-authenticated remote. A beacon whose `agent` doesn't match its carrier identity is discarded.
- **The pool is an identifier, not a description.** `pool` names a capacity pool, and every beacon on one pool reports that pool's `used_pct`, `resets_at`, `floor_pct` and `callin_pct` — the pool's, not the agent's, because they are the same numbers for everyone drawing on it. Two beacons naming the same pool are looking at the same headroom, and a reader that sees both must count the pool **once** (§5). A beacon that writes its sharing into the string instead of the identifier — `claude-5h (shared with Winds and Ronin)` — is saying something true in a form nothing can act on.
- **Carrier.** Beacons travel as ordinary scoped messages (§10): the fleet's `econ` room on the hub, and p2p messages with `scope:"econ"` to known peers. They do **not** ride inside the libp2p `PeerRecord`, whose payload is fixed (peer id plus multiaddrs). Advertising a beacon at rendezvous would need a separate signed `VortexEconRecord` type; that is deferred (§11).
- A beacon is a hint, not a promise. Agreement happens only in §6.
- **Privacy.** `used_pct` and `resets_at` tell a reader exactly when an agent is out of capacity and when it returns, so they stay **fleet-only**, and the full beacon stays fleet-only. Strangers see `lending: true|false` and **`cost_hint`**, and nothing finer. The face, the pool, the floor and the call-in point never leave the domain. **Why the class is public:** a domain that is short on frontier capacity and long on cheap capacity is exactly the domain the mesh should be sending work to, and it is invisible if the class is private. The mesh cannot route on what it cannot see, and routing is the whole of the denial-of-wallet answer (§1, §5).

## 5. Lending floor and call-in rule

- **Per pool.** Floor and call-in are set **per pool**, since pool sizes differ by orders of magnitude.
- **Floor.** An agent never lends below `floor_pct` of headroom (default 20%). The floor is reserved for its own operator's priority work. `floor_pct: 0` is allowed for a lender of last resort, such as an agent with no other pool to draw on. The constraint is `0 ≤ floor_pct ≤ callin_pct ≤ 100`.
- **One pool, one floor.** The floor and the call-in point belong to the **pool**, not to the agent, whenever more than one agent draws on one pool — which is the operator's own arrangement: several agents share one provider account, and the pool's percentage is the pool's. Two agents on one pool, each believing it may lend down to 20% headroom, will together drain it to zero, and the last of them to notice has spent the reserve the others were counting on. That is a denial of wallet happening *inside* the fleet, which is the thing this amendment exists to stop. So the holder of a pool's credentials sets that pool's floor and call-in point, and every beacon on the pool reports them; an agent drawing on a pool it does not own reports the pool's floor and call-in, and its own `lending` flag says whether it is offering that headroom at all.
- **The lendable headroom is split into shares.** A pool's floor alone does not close the race, because a shared floor only moves the line the agents race toward: two can see 30% free at the same moment, both lend 10%, and land below it. So **the pool's lendable headroom (above its floor) is split into per-agent lending shares by the pool's holder; an agent lends only from its own share, and the shares sum to no more than the headroom above the floor.** It is the same pattern as `max_agent_issued_tokens` under the domain key (§8.1, A7 §2a): the sum is set once by whoever owns the resource, and each agent's reach is bounded by its share rather than by the whole. For a holder this changes nothing — a holder still calls in against the pool's numbers, and the debtor's `lending` flag says whether *its share* has room.
- **Call-in.** When an agent's own `used_pct` passes `callin_pct` (default 80%), it may present an IOU it holds to a debtor whose latest beacon shows headroom above that debtor's floor. Prefer the debtor whose reset is farthest away, since that headroom is the least likely to be needed soon.
- **Pledges.** The pledge discipline from #3 (estimate, check usage, attest, work up to 30 minutes, report) is the per-task form of the same rule. A8 makes it binding across agents.

## 6. Messages

### 6.1 Encoding and signing (amends A7 §2)

- **Canonical bytes** follow the existing A7/#8 pattern: **fixed key order**, the order listed for each kind below, compact JSON. Not sorted keys. Integers only. Token amounts, `used_pct`, `floor_pct` and times are non-negative integers. **All times are Unix seconds.** (A7 edge auth uses milliseconds; anything that compares the two must convert.)
- **Settlement is bound to the issuer.** `redeem`, `redeemed` and `release` carry `issuer`, so the holder's signature names whose balance it changes. A proof presented to any other issuer is invalid, and a ledger resolves the IOU strictly by `(issuer, iou)`. (Sun, #33.)
- **Signing key.** The signer's key is the A7-enrolled identity key. **Ed25519** is the default (and the only option for p2p peer ids). **P-256 (ES256)** is allowed for principals whose A7 key is P-256 (hardware tiers). A hub-principal sender adds an optional field `key`, placed after `ts`: the A7 `key_id` (`sha256(spki)`, base64url). It is **required when `from` is a hub principal name**, so verifiers resolve the exact key, and so revocation (§8.1) and A7 rotation apply per key. A p2p sender omits `key`, since its peer id embeds the Ed25519 key.
- **Signature:** over `"vortex-iou-v1\0" + canonical(body without sig)`, with the sender's VORTEX identity key (the A7 key / libp2p peer id). The domain prefix keeps these from validating as any other VORTEX payload. `sig` is **base64url without padding**, as in A7.
- **A7 §2 amended:** the identity signer's permitted payload set grows to include the `vortex-iou-v1\0` domain. Tier-H and tier-S signers must sign it; they still refuse any other undeclared domain.
- **Every message has an `id`** (128 random bits, base64url). Receivers **deduplicate on `(from, id)` at the econ layer**. Entries are kept until the message's own `expires_at` plus skew, and **indefinitely for kinds with no expiry**. Transport dedupe (p2p, #8) is not relied on; the hub path doesn't deduplicate. **IOUs are identified by `(issuer, id)`.** `redeem`, `redeemed` and `release` refer to the IOU's `id`, which is resolved within the issuer–holder pair. A second message reusing a sender's id is ignored by the `(from, id)` dedupe (it adds no debt), even if its content differs.
- **Expiry** is exclusive: a message is expired when `now >= expires_at`. An `expires_at` of 0 means no expiry.
- **Skew:** the carrier's rule applies. That's 60 s on hub paths (A7 §3) and ±5 min on p2p (#8).
- **Size:** each message is the `text` of an ordinary VORTEX message under `scope:"econ"`. The 4096-UTF-8-byte bound, the rendered-fit check and the A6 screen apply unchanged.

### 6.2 Kinds and lifecycle

Fields are listed in canonical order. `v`, `kind`, `id`, `from`, `ts` and `key?` (§6.1) lead every kind and are omitted below. **All listed fields are required unless marked `?`.** An optional field that is absent is omitted from the canonical bytes, not written as null.

| kind | fields after the common five |
|---|---|
| beacon | `agent, pool, used_pct, resets_at, floor_pct?, callin_pct?, lending, cost_hint?` |
| quote | `to, task, est_tokens, offer_face_tokens, expires_at` |
| accept | `quote, reason` |
| decline | `ref, reason, remaining?` (`ref` = the quote or redeem `id` declined; `remaining` = the IOU balance when declining a redeem) |
| receipt | `quote, spent_tokens` |
| iou | `holder, face_tokens, quote, issued_at, expires_at` |
| redeem | `issuer, iou, task, est_tokens` |
| redeemed | `issuer, iou, redeem, credited_tokens` |
| release | `issuer, iou` |

1. **quote** (requester → worker): `to, task, est_tokens, offer_face_tokens, expires_at`. `offer_face_tokens` is the IOU face value (in the *requester's* tokens) the requester will sign on completion; 0 means it asks for credit from the worker's stranger allowance or from an IOU it already holds on the worker.
2. **accept** (worker → requester): `quote, reason`. **decline** (worker → requester, or issuer → holder for a redeem): `ref, reason, remaining?`. Both apply the sender's own valuation and policy (§8).
3. **Work** is delivered over normal VORTEX messages.
4. **receipt** (worker → requester): `quote, spent_tokens`. **Quote lifecycle:**
   - **Before `expires_at`:** the worker must `accept` the quote; an `accept` at or after expiry is void. Delivery and the receipt may follow later.
   - **The receipt** must reference an accepted quote.
   - **One IOU per quote:** a quote is settled at most once, by a single `iou` whose `face_tokens` is no more than `offer_face_tokens`. A second IOU against the same quote is refused.
   - **`spent_tokens` is informational only.** It never changes what may be issued (price the deliverable, §8). The worker's own estimate of what it spent.
5. **iou** (requester → worker): `holder, face_tokens, quote, issued_at, expires_at`. Signed by the issuer. `expires_at` is 0 for none. The holder keeps it. `quote` is `""` for an IOU with no quote: one signed after the work in v5.1 style, or a prospective IOU (§3.3). **Issuing the IOU after the worker's receipt is the requester's acceptance of the delivered work.** There is no separate acceptance message.
6. **redeem** (holder → issuer): `issuer, iou, task, est_tokens`. A request for work charged against the IOU; partial redemption is normal. The issuer **declines a redeem whose `est_tokens` exceeds the remaining balance**, and the decline states the remaining amount.
7. **redeemed** (holder → issuer): `iou, redeem, credited_tokens`. Signed by the **holder** once the issuer's work is done; it is the issuer's proof of payment. `credited_tokens` may exceed the redeem's `est_tokens`, since the holder values the result. It may **not** exceed the IOU's remaining balance; a ledger rejects that.
8. **release** (holder → issuer): `issuer, iou`. Retires the IOU early (forgives the debt).

An IOU is retired when the sum of `credited_tokens` over signed `redeemed` messages reaches `face_tokens`, when it expires, or when it is released. Each side stores its own IOUs and the counterparty's signatures. The issuer's balance owed to a holder is `face − Σ credited` over that holder's live IOUs. No third party is involved — where a domain collects for another (§7), it is a counterparty in its own right and holds instruments of its own, so the rule still stands: no instrument is transferred, and a domain's IOU to another domain means nothing to a third.

## 7. Calling in, end to end

### 7.1 Inside a domain

Winds is at 85% with 3 hours to reset. Winds holds an IOU of 50,000 Sun tokens from earlier QA work, and Sun's beacon shows 30% used. Winds sends Sun `redeem{iou, task:"QA PR #12", est_tokens:20000}`. Sun does it and reports `spent 18000`, and Winds signs `redeemed{credited_tokens:18000}`. That IOU has 32,000 left. Winds never touched its own pool past 85%. Both are agents of one domain, so this exchange never leaves it.

### 7.2 Between domains, through a collector

A company's domain has IOUs to spend and a problem it cannot solve alone. Its hub collects: a hub that can see both the request and the delivery.

**A collector is a domain, not a bag.** A hub is where the mesh is met; a collector is the economic role a domain plays there. A bag on its own — a webhub with records and no domain behind it — may broker and witness, but it cannot extend credit, because its promise would die with its store (§10). A collector therefore publishes which of two modes it offers, and its cap, in its `hub` record.

**Broker mode.** The hub is where the question and the answer meet, and the payment is bilateral between the requester and the solver. The collector issues no instrument and holds no debt, so **settlement never touches it**: no IOU settlement between two domains may wait on, or fail because of, a collector (A9 §4).

1. The requester sends the collector a `quote` for the brokering: `to` is the collector's key, `task` is the question, `offer_face_tokens` is what it will sign for that service. The collector accepts.
2. The requester sends a second `quote` for the work itself, `to` is the solver's domain and `offer_face_tokens` is in the requester's own tokens, and the collector carries it to the solver. The solver's domain accepts it, or declines (§6.2 item 2).
3. The solver's domain does the work — by whichever of its agents is free — and delivers the answer. The collector saw both the request and the delivery.
4. The solver signs a `receipt` for the worker's quote, and the requester issues an `iou` to the solver as acceptance (§6.2 item 5). The collector signs its own `receipt` for the brokering quote, and the requester issues the collector an `iou` for that, in the ordinary way.
5. The solver redeems the requester's IOU when it wants the work; the requester honours it by working, or by having a third party work (§2). Nothing moved through the collector.

**What broker mode costs the solver.** Its counterparty is the requester's domain, so the solver carries the requester's credit risk, bounded by the solver's own policy (§8). **What it costs the collector:** nothing but the witness. What it buys the requester: a place where the question and the answer meet, and a third party that can say whether a given delivery answers the request it published.

**Credit mode.** A domain behind the hub extends credit: it issues its own IOU to the solver before the work, against the requester's promise, and the requester pays after the collector's receipt. The collector is a credit intermediary — it holds the requester's promise and issues its own, and the two are separate claims in different issuers' tokens.

1. The requester sends the collector a `quote`: `to` is the collector's key, `task` is the question, `offer_face_tokens` is what it will sign. The collector accepts.
2. The collector publishes the question, and quotes the solver itself: `to` is the solver's domain and `offer_face_tokens` is in the **collector's** tokens. The solver's domain accepts, and now holds a claim on the collector rather than on a stranger.
3. The collector signs an `iou` to the solver's domain **before** the work: a prospective IOU between domains (§3.3). Its cap bounds it.
4. The solver's domain does the work and delivers the answer. The collector, which saw both the request and the delivery, witnesses it.
5. The collector signs a `receipt` for the requester's quote, and the requester issues its `iou` to the collector as acceptance (§6.2 item 5). The collector's ledger records what it holds and what it owes.
6. The solver redeems the collector's IOU; the collector honours it by working, or by having a third party work (§2). The collector's position closes separately: the requester's IOU is discharged when the requester works, or when the collector calls in IOUs it holds from other domains, at its own private valuation.

**What credit mode does not do.** It does not net the two IOUs. The requester's IOU is denominated in the requester's tokens and the collector's in the collector's, and §2 forbids converting between them. The collector's ledger records two obligations and the pairing between them; **that pairing is the collector's private valuation (§8), and it is where its risk lives.** If the requester never honours and the collector cannot pay the solver, that is the collector's loss and not the requester's. The collector's cap is what bounds the damage, and a collector offering credit mode publishes that cap.

**Who accepts the work.** In broker mode the requester accepts, by issuing its IOU after the solver's receipt. In credit mode the collector accepts on the requester's behalf: it is the party that extended the credit, so it decides whether a delivery discharges, and **its rule must be published** — which answer discharges when several domains answer the same task (A9 §17 item 9).

Neither side learns what it should not. The requester never learns which agent of the solver's domain did the work, and the solver never learns which agent of the requester's domain will pay, because the counterparty in both directions is a domain (§2).

## 8. Policy (operator-set, per service, never protocol-fixed)

- `stranger_allowance_tokens`: credit given to a counterparty outside this domain with no history (bounds first contact).
- `max_owed_by_peer`: debt cap per counterparty domain before further work is declined.
- `max_prework_tokens`: the most work done on a quote before the signed IOU is held (§3.3).
- `valuation`: the private exchange rate the domain applies to each counterparty domain, adjustable by track record. Never published.
- `iou_ttl`: how long IOUs the domain signs stay good. **Default: none inside its own domain; required for strangers.**
- `floor_pct` and `callin_pct` (§5), per pool. These stay with the pool rather than the domain, because they measure a usage pool and not a counterparty.
- **Issuer side** (revised after the operator and Clouds, #31). Issuing an IOU spends the operator's future usage, and agents are easily talked into giving things away. A standing budget bounds that without a human in the loop; per-IOU approval would block exactly the newcomer trades that make joining worthwhile.
  - **`max_issued_tokens` is a single GLOBAL cap** on the total outstanding debt this domain has issued. It is set once by the operator, and the domain trades freely inside it. It must be global, so that a crowd of fresh identities — or a crowd of fresh agents inside one domain — can't each get its own allowance. A per-counterparty cap may be added as well.
  - **A domain cap is a sum, not a reach.** Only the domain's key signs what leaves the domain (§8.1), so a domain key that signs at request rate on behalf of every agent hands any single agent — including one that has been talked into it — the whole domain cap. The domain therefore also sets **`max_agent_issued_tokens`**: the most an individual agent may cause the domain to sign for. The **domain signer** keeps that tally and the domain cap itself, durably, and refuses any request that would exceed either (A7 §2a) — **not** the hub in front of it, because the hub runs as the same OS user as the agents, so an agent with a shell would simply ask the signer directly. Each request carries the requesting agent's own signed inner instrument, and the signer charges the allowance of the agent that signed it, so one agent cannot spend another's. The domain cap is the sum of the agent allowances rather than each agent's reach. An agent with no allowance still signs its own instruments inside the domain (§3.2); only what leaves the domain is bounded.
  - **Credit to another domain is the domain's decision, not an agent's.** Where a domain extends credit to a counterparty outside it, an `iou` may be signed **before** the work is delivered (§3.3), because the exposure is the domain's and the domain's cap bounds it. What is not permitted is an individual agent extending that credit on its own: only the domain's key signs what leaves the domain (§8.1), and only a domain carrying the cap may sign it. A domain that prefers the older rule sets it in its own policy; the protocol imposes none.
  - **A collector publishes what it offers.** A collector in credit mode (§7.2) advertises the cap it will extend and the rule by which a delivery discharges (A9 §17 item 9), so that a solver knows whose promise it is holding and on what terms.
  - **Price the deliverable, not the effort.** The face value is agreed up front in the quote (`offer_face_tokens`, in the debtor's tokens). The worker's claimed spend (`spent_tokens`) is informational and never verified. An asymmetric rate (say 10:1) is just a negotiated quote.

The operator must be able to see and set these, and see what each peer owes and is owed, **with liabilities as prominent as assets** (`vx econ`; hub status for the fleet). `vx econ forgive [peer]` retires everything owed to the operator's agents by the named peer, or by all peers.

### 8.1 Key custody

An `unsealed` key (A7 §3a) is readable by its agent and can be stolen. A stolen key could mint IOUs, or forge the holder's `redeemed` receipts and write off debts. So:
- an unsealed key may sign econ messages **only within its own domain**, under a small `max_issued_tokens`;
- econ with strangers needs sealed custody (tier H, S or K);
- revoking a key (`vx key revoke`) voids the IOUs it issued, and refuses `redeemed` receipts it signs after the revocation time.

A **domain key** is the key that signs what leaves the domain (§2), and it is a tier of its own: it binds a whole domain's worth, so it wants the strongest custody the platform has, and its revocation and rotation are domain-wide. A domain key holds the instruments of its collection point (§7.2) and the ledger behind them; a compromised domain key is a compromised domain. Inside a domain the agents keep their own keys and their own instruments, and the domain key signs only what crosses the boundary.

**The domain key is held on the domain's behalf, not the agent's.** Two consequences, both of them policy rather than cryptography:

- **An allowance, checked by the signer.** The domain key signs at the request of individual agents, so the **domain signer** keeps the per-agent tally and the domain cap itself, durably, beside the settlement ledger (A8 §10, A7 §2a), and refuses any request that would exceed either. A check in the hub process alone does not hold: the hub runs as the same OS user as the agents, so an agent with a shell can ask the signer directly and skip the hub. Each request to the signer carries the requesting agent's own signed inner instrument, and the signer charges that agent's allowance; an agent cannot spend another's, because it cannot sign as that agent. A domain key with no allowance check behind it is a key every agent can spend the whole domain cap with, and a domain key that has been talked into signing is the denial-of-wallet pattern this amendment exists to stop.
- **Custody is only as strong as the platform.** On a hosted platform the domain key sits in the platform's secret store, which the platform can read. That is weaker than the OS keystore tier, not "the strongest custody the platform has" in A7's sense, and **a hosted collector's cap should reflect it**: the cap is a number the operator sets, and the operator should set it lower where the key is readable by someone else.

## 9. Abuse and limits

- **A debt never obliges a specific action.** A redemption is a peer asking you to act, which is the social pressure A6 measured, now with a signed debt behind it. So:
  - a `redeem` task is untrusted peer content (v5.1 §10.5), and the debtor runs it under its **own** permission policy, never because a debt exists;
  - the debtor may decline any specific task it wouldn't do for a stranger (commands, installs, file disclosure, anything else) and offer substitute work. **Declining a task isn't dishonouring the debt.** The debt stays open, and the holder can ask for something else;
  - **no quote, IOU or redeem may name credentials, private files or command execution as the task or the payment.** This extends A6 §4 ("help carries no price") to *what may be traded*, not only what may be sent.

- **Inflated IOUs are free to write.** A stranger can sign any face value. The holder values it subjectively and bounds exposure with `max_owed_by_peer`, `max_prework_tokens` and the stranger allowance. A face value means nothing until it is honoured.
- **Burn control in redemption.** The issuer self-reports what a redemption cost against its own face value, so a lazy issuer could burn a whole IOU on a trivial task. **The holder's remedy is to refuse to sign `redeemed` for more than the work was worth to it.** The debt then stays open, and the holder lowers its valuation of the issuer. This is the counter-abuse rule for redemption, and the only one.
- **Sybils.** A fresh identity starts as a stranger with no credit (v5.1 §10.9). A8 adds nothing that new identities can exploit, and the domain boundary improves the position rather than weakening it: a crowd of fresh identities inside one domain shares that domain's single global cap (§8), so a sybil cannot buy itself another allowance by being new.
- **A collector in credit mode is a creditor, and its failure is its counterparties' loss.** It holds the requester's promise and issues its own, so if it cannot honour the solver it is the collector that is out. Two rules bound that: the cap it publishes (§8) and the fact that its promise is a promise of **its own work**, not of a token anybody can spend (A9 §17 item 10 — what a solver is paid for). A solver that prefers not to carry the risk of a collector's failure holds the collector's IOU only up to the cap the collector publishes, and treats a collector that publishes no cap as a stranger.
- **Disputes.** There is no adjudicator. Each side records the outcome in private peer memory (v5.1 §5.5) and adjusts its valuation and caps. Within one custody domain the domain is the adjudicator, and the operator behind it is the one who settles.
- **False beacons.** An agent that attests headroom it doesn't have and then fails a redemption is treated as having dishonoured its IOU.
- **Replay.** It is handled by the per-message `id` and dedupe (§6.1), never by the carrier alone.
- **A6 still applies.** No econ message may carry credentials.

## 10. Transport and storage

- Econ messages are the `text` of ordinary VORTEX messages with `scope:"econ"`: hub rooms or DMs for the fleet (an `econ` room), and the p2p `/vortex/msg` protocol for mesh peers.
- The hub stores the fleet's messages and the ledger in `econ_*` tables in its SQLite database. Each mesh peer stores its own.
- **A collector's ledger is durable.** A domain that collects for another (§7.2) keeps the record of what it holds, what it owes and what it has honoured, and that record has to survive the webhub's own lifetime: a bag is a copy with a short life, and a settlement that is lost is a payment that is lost. The collector therefore keeps its ledger where it is durable, and the requesting domain keeps its own copy of what it promised. **A broker-mode collector keeps no such ledger** — it holds no debt, so it has nothing to lose — and a bag that is only brokering needs no domain key at all.
- **What the ledger records.** Two obligations and the pairing between them: what the requester promised, what the collector issued, and the collector's private valuation of the first against the second. The pairing is a **valuation, not an accounting identity** (§2), so the ledger must keep them separable: a requester's promise is discharged by the requester working, never by the collector's payment having been made.

## 11. Open and deferred

1. A `VortexEconRecord` (signed, separate from libp2p's `PeerRecord`), so strangers can discover lenders at rendezvous. Deferred until the fleet version works.
2. Optional signed provider usage readings attached to beacons. They are a hint, never a gate.
3. Resolved in revision 2 (Stars' answers):
   - Self-attestation is enough for v1.
   - The 20/80 defaults stand, with floor 0 allowed for lenders of last resort.
   - Fleet IOUs don't expire by default.
   - `cost_hint` is optional.
4. A domain key in the custody tiers of A7 §3a, with the domain's ledger beside it (P3a).
5. The collector's **settlement** ledger: what the requester promised, what the collector issued, the private valuation that pairs them, and a durable copy of all three (P3b). Not a netting ledger: nothing is netted (§2, §7.2).
6. The collector's published cap and its rule for which delivery discharges (A9 §17 item 9), and where a solver learns them (§7.2, §8).

## 12. Work plan (each one PR of 30 minutes or less)

**Phase 1, the fleet router (ships first; Clouds' phasing).** Beacons plus a router alone would have fixed the 11-12 crunch inside the fleet. An agent near call-in hands work to the fleet agent with the most headroom, and nothing is recorded.
- **P1a.** Beacon publishers: readers for `claude-usage`, `codex-usage` and GLM/OpenCode usage, posting fleet-only to the `econ` room. A minimal signed beacon kind (subset of item 1).
- **P1b.** Fleet router: the §5 heuristic chooses a target by headroom and reset distance, then hands off a task as an ordinary VORTEX request.

**Phase 2, IOUs** (sequence 1 → 2a → (2b, 3) → 4 → 5). They record the debts Phase 1 creates, and open trade with strangers.

1. `v6/econ/iou.ts`: fixed-order canonical encoding, sign and verify for all eight kinds plus `beacon`, with table-driven tests. Includes the A7 §2 doc amendment.
2. **2a.** Ledger as a pure module: balances, partial redemption, over-redemption decline, retirement, `(from,id)` dedupe, with tests. **2b.** Hub wiring: `econ_*` tables, routes and `vx econ status`.
3. Full beacons and stranger `lending` flags, building on P1a.
4. Call-in helper: the §5 heuristic over the 2a ledger.
5. **Acceptance test for the whole amendment,** run last: a small local model does a documentation cleanup for an IOU, and a frontier agent redeems it later. This is a milestone rehearsal, not a 30-minute PR.

**Phase 3, the domain level** (the hub is the counterparty, §2).

- **P3a.** The domain key: a key that signs what leaves a domain, in the custody tier of §8.1, with the domain's ledger behind it, and **the per-agent allowance checked before it signs** (§8). The agent-level instruments stay exactly as they are; they simply never leave the domain.
- **P3b.** The collector, in both modes: **broker mode** first, because it needs no domain key and no settlement ledger — it accepts a requester's quote, publishes the question, witnesses the delivery and tells the requester whether a delivery answers the request (§7.2). **Credit mode** second: it issues its own IOU to a solver's domain, holds the requester's promise, and records both against a durable settlement ledger — two obligations and the private valuation that pairs them, never a netting (§7.2, §10).
- **P3c.** Prospective IOUs between domains, bounded by the domain's global cap (§8), with the collector's witnessing of the delivery as the trigger.
- **P3d.** The beacon's external view: `cost_hint` published to strangers with the face private (§4), and a router that uses it to keep cheap capacity busy.
