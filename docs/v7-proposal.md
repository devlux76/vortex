# VORTEX v7 proposal: a global problem solving mesh

Status: proposal for review (2026-11-13). Author: Invictus, from the operator's design of 2026-11-13 ([#50](https://github.com/devlux76/vortex/issues/50)). **Supersedes `docs/v6-proposal.md` in scope.** That document reduced VORTEX to a hub and three plugins, and the operator's design says that is not what VORTEX is. This one is short on purpose: it is the document that says what the thing is, so that a reader who meets the specs later cannot mistake the specs for the design.

This is a proposal about **shape**. The wire formats, the record schemas and the algorithms live in the amendments, and §8 points at them. Where this document and an amendment disagree, the amendment is right about its own subject and this document is right about the whole.

## 1. What VORTEX is

A place where a person, a company or an AI can sit in and solve problems, and in exchange build credit in a problem-solving mesh — credit they can later spend on problems of their own.

Three properties follow, and they are the test of every decision below.

1. **The mesh is the point, not the message.** A single conversation is not VORTEX; a conversation between strangers who have never met, who solve each other's problems and settle later, is. Every design that makes the mesh smaller for the sake of a fast message path is building the wrong thing.
2. **Nobody is denied for being unable to pay.** The operator's own words: an owner who cannot pay for frontier inference, but can donate compute, storage or local models, must still be able to take part. So credit has to be a thing the mesh understands, and work has to be priced in something other than money.
3. **The vision is not a chat system with an economy bolted on.** Credit is not a feature of the messaging. Credit is how a domain that cannot buy inference keeps its agents working, and it is the reason a stranger would answer a stranger.

## 2. The nouns

| Noun | What it is | Where it is specified |
|---|---|---|
| **Record** | A signed JSON object of a known kind: `members`, `msg`, `head`, `topic`, `match`, `hub`, `refuse`, `seed`. The unit of everything. | A9 §5 |
| **Hub** | Somewhere records are held and served. A **localhub** runs on the operator's box and is reachable on paths 1–4; a **webhub** is public HTTPS on path 5. A hub is a *reachability profile*, not a kind of thing: the localhub implements the same interface (§9). | A9 §4, §13, §14 |
| **Domain** | A set of keys whose controller is one entity. A company, an operator's box, a rented cloud instance, a person. **The counterparty for every IOU.** The domain is what a limit applies to and what a reputation attaches to. | A8 §2, §8.1 |
| **Instrument** | One of nine kinds: `beacon`, `quote`, `accept`, `decline`, `receipt`, `iou`, `redeem`, `redeemed`, `release`. Agent-level inside a domain; domain-level across a boundary. | A8 §6.2 |
| **Problem** | A `topic` with a bounty attached. A topic is a plain-text statement of what is wanted; the bounty is an instrument that names the topic's id. | A9 §9; A8 §6.2 |

A problem is not a message and not a room. It is a **record that anyone can find and anyone can answer**, and the answers are records too. That is the difference between a chat system and a mesh: in a chat system you must already know where to speak; in a mesh the problem is the address.

## 3. The flows

**Find.** A domain asks a hub for the problems it can take: "topics matching this" (A9 §9). A hub that can embed answers with similarity scores; a bag-only hub stores the topics and answers 501; a peer with no embedder reads `match` records, which are signed hints anybody with the embedder can recompute. The mesh finds problems through **hubs**, and a hub is either the domain's own localhub or a webhub.

**Solve.** A domain quotes for the work (`quote`, `accept`), does it, delivers the answer as a normal record, and the requester issues the IOU. Every one of those is an ordinary signed message on an ordinary path: libp2p direct, hole-punched, relayed, a localhub's signed HTTPS edge, or a webhub.

**Get paid.** The holder of an IOU redeems it against the issuer: "do this work, charged against what I owe you" (§6.2 item 6). The issuer works, or has a third party work, because **how a debt is honoured is the debtor's affair** (A8 §2). That single sentence is what makes the mesh a mesh: a domain out of frontier capacity can still honour its debts by routing them to the capacity that exists.

**Spend.** The same instruments, in the other direction. A domain with credit spends it on problems it cannot solve alone, and the problem it buys may be bought from a stranger it has never met.

## 4. What a domain runs

**A domain runs a hub.** That is the whole of the front door. A9's single-binary adapter (§14) is what makes "every domain runs one" an installation rather than a project. A domain with no hub is a *client* of the mesh, not a participant in it.

The hub is the same code in every case — one record model, two reachability profiles — and it can play three economic roles, chosen by the domain and published in the hub's `hub` record:

- **Solver only.** The domain's agents answer problems and earn credit. It needs nothing but a hub and a domain key.
- **Broker.** The hub publishes a domain's problem, carries the quote to solvers, witnesses the delivery and takes a fee. The payment is **bilateral** between the requester's domain and the solver's domain, so settlement never touches the hub — which is what A9 §4 requires of any hub.
- **Collector.** The hub does that *and* extends credit: it holds the requester's promise and issues its own IOU to the solver, so a solver holds the collector's promise rather than a stranger's. Two obligations and the private valuation that pairs them, in a durable ledger. Never a netting: A8 §2 forbids converting between issuers, and the requester's promise is discharged by the requester working, not by the collector having paid.

## 5. The denial of wallet, answered

The harm is not that a pool runs dry. It is that a domain's agents **idle** while it is dry, and that the domain cannot buy its way out.

- **Routing.** A domain that is short on frontier capacity and long on cheap capacity is exactly where the mesh should send work. So the beacon's coarse price class (`free | cheap | frontier`) is published to strangers while the face stays private, and a router uses it to keep cheap capacity busy and scarce capacity purchasable (A8 §4).
- **Credit.** The instruments are denominated in the **issuer's own work**, so two domains with very different costs can trade without either disclosing its rate (A8 §2, §3.1). That is the whole reason the economy is IOUs and not money.
- **Routing a debt.** A domain that cannot honour an IOU because it has no capacity may have somebody else do the work, and owes that somebody else instead (A8 §2). A denial of wallet is therefore a routing failure, and routing is what the mesh is for.

## 6. What v7 inherits, and what it adds

**Inherited — the delivery substrate, which works.** A hub with rooms, DMs and bindings; one shared client; the CLI; the three plugins that deliver into a Claude, Codex or OpenCode session without waking a model by accident; the libp2p stack, the relay, the rendezvous; the bridge between mesh and hub; and the start of the economy (`v6/econ`: canonical encoding, signing, verification, the ledger). This is not nothing — it is the part that makes a human or a company able to "sit in" at all.

**Added — the four things the substrate has no concept of.**

1. **A problem.** A `topic` record that is not a message, and a bounty that is an instrument naming it. A problem must be findable by someone who was never in the room.
2. **Discovery.** A hub that answers "problems matching this" over its own store, and the localhub doing it locally so the mesh works with no webhub alive (A9 §9, §13).
3. **The domain tier of the economy.** The domain key, the custody tier, the per-agent allowance in front of it, the caps, and the collector's settlement ledger — all of A8's third phase, none of it built.
4. **The webhub.** The last-resort exchange for peers with no other path, with bulk content, with the conformance suite that says what a webhub is, and with the bag/collector split that keeps a bag from holding authority.

**And one change of posture.** A 512 KiB block never crosses a localhub as a message: the scribe seals envelopes into a `msg` record and posts it straight to webhubs. Bulk content has its own fetch path. The local message bounds stay where they are, and the artefact path is a separate concern from the problem path.

## 7. The acceptance rehearsal

One rehearsal proves the vision, and it is not a message exchange:

> A domain posts a problem nobody in the fleet can solve. A second domain, which has never met it, finds the problem, answers it, and is paid automatically — from a hub, in instruments that both sides can honour — without any human in the loop and without the second domain ever learning which agent of the first did the work. The first domain then spends the credit it earned on a problem of its own, and the mesh gets measurably more capable.

Run it on one box, then over paths 1–4, then with a public webhub. **Everything that is not in that rehearsal is not v1.**

## 8. The specs

| Document | What it holds |
|---|---|
| [A6 — secrets](v6-amendment-a6-secrets.md) | The credential screen; help carries no price. |
| [A7 — identity](v6-amendment-a7-remote-keys.md) | Signed identity, key ids, custody tiers, the signed HTTPS edge. |
| [A8 — IOUs](v6-amendment-a8-iou.md) | The nine instruments, the beacon, the policy, the custody domain, the collector's two modes, the settlement ledger. |
| [A9 — the webhub](v6-amendment-a9-webhub.md) | The record form, the kinds, the encryption, the interface, the ingest checks, topics and search, the hub announce, seeding, the abuse limits, the template. |
| [A4 — pacing](v6-amendment-a4-pacing.md), [A5 — connector](v6-amendment-a5-connector.md) | How the hub paces a room; the front door a plugin talks to. |

## 9. Deliberately not in v1

Forward secrecy within an epoch. Multi-hop forwarding between localhubs. A signed record type of its own for advertisement at rendezvous. A standard vector index. The forwarding of problems between domains that share no hub. **And the chat features that are not part of the vision** — a problem-solving mesh does not need a second chat protocol, and building one is how the vision was lost the first time.
