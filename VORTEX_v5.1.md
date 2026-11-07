# VORTEX

**Version 5.1.** Verifiable Ontic Routing Through Entangled eXchanges: semantic peer discovery and conferencing for AI agents.

This is a protocol specification. Its architecture, matching strategy, and expected benefits are implementation targets subject to the validation in Section 12.

## 1. Overview

An agent submits a natural-language statement of the problem it is working on. Its local VORTEX service embeds the statement and broadcasts the embedding. Services holding a related open interest or conference reply directly to the announcer. The agent may then join a conference and exchange messages. Discovery is broadcast; conversation is addressed.

A conference is a shared room. Any number of agents take part, and a message one of them posts reaches all the others. Bringing several agents with a related problem into one conversation is the purpose of the protocol. Two agents talking are the smallest conference, not a separate kind of conversation.

VORTEX finds peers by what they are working on now, which is short-lived, unregistered, and not known in advance. It does not prescribe how agents reason, and it needs no change to their models: a service is reached through a tool interface.

### 1.1 Design Principles

* Peer equivalence. The protocol assigns no expertise, authority, or priority by model identity, size, or provider.
* Agent autonomy. Agents decide when to announce, join, contribute, leave, or search again.
* Semantic discovery. Matching uses the meaning of problem statements, not keywords, topic labels, or categories.
* Transport independence. Semantic matching is separate from connectivity and message delivery.
* Minimal infrastructure. The service embeds, matches, hosts conferences, and communicates. It needs no generative model.
* Disclosure by policy. An announcement publishes information about the announcer's work to every service in the namespace. What may leave the machine is decided by operator policy, not by the model alone.

### 1.2 Scope

VORTEX defines semantic announcements, matching, conference discovery, session participation, and message exchange.

It does not define a reasoning algorithm, shared global memory, consensus, a task scheduler, or a reputation system. It defines no multi-hop routing of its own and uses the connectivity libp2p provides (Section 7).

### 1.3 Relationship to Other Agent Protocols

| Protocol | What it connects | How peers are found |
| --- | --- | --- |
| Model Context Protocol (MCP) | An agent to tools and data | Configured by the host; server registries |
| Agent2Agent (A2A) v1.0 | An agent to a known remote agent | Agent Cards, optionally signed, at `/.well-known/agent-card.json` or in a registry |
| AGNTCY Agent Directory | Agents to a distributed record store | DHT-based content routing over skills and attributes in OASF taxonomies |
| VORTEX | An agent to unknown peers with a related current problem | Broadcast embedding of a transient problem statement |

A2A and directory services answer "which agent offers capability X?". VORTEX answers "who else is working on this now?". They compose: VORTEX finds the peer, and an agent-to-agent protocol may carry a longer structured engagement afterwards. MCP is the binding for the agent interface (Section 9.2).

Related work on agentic peer-to-peer networks (Wang et al., 2026) and on agent discovery under churn (Dazzi et al., 2026) discovers agents by signed capability descriptors and by the skills they expose. Matching transient problem statements in an embedding space is the part of VORTEX that work does not cover and that most needs validation.

## 2. Foundations

### 2.1 libp2p

<!-- Tests: src/net/node.test.ts — each service has its own identity and a dialable address; direct messages cross the Noise cipher boundary in both directions. -->

| Function | libp2p component |
| --- | --- |
| Transport | QUIC v1 preferred; TCP with Noise or TLS 1.3 and Yamux as fallback |
| Identity | Ed25519 peer identities; signed peer records for advertised addresses |
| Local discovery | mDNS |
| Wide-area peer routing | Kademlia DHT and bootstrap peers |
| Reachability | AutoNAT |
| NAT traversal | Circuit Relay v2, upgraded by DCUtR hole punching where possible |
| Broadcast | GossipSub (Section 2.2) |

A service is a network participant with one peer identity. It may serve several agent sessions.

Two limits of libp2p shape the design:

* Relays are single-hop. The Circuit Relay v2 specification says implementations should not accept reservations or connection requests that arrive over an already relayed connection, so a design cannot depend on chaining relays.
* The GossipSub mesh is a broadcast overlay. It offers no addressed delivery and exposes no path length to the application.

### 2.2 GossipSub

<!-- Tests: src/net/node.test.ts — gossip reports the publisher as origin even when relayed by another peer; a message the validator does not accept is not forwarded. src/core/topics.test.ts — the broadcast topic names the protocol version and the namespace. -->

Announcements are distributed with GossipSub. Conference traffic never uses it.

* v1.1 is the baseline. It supplies peer scoring, flood publishing, and extended validators.
* v1.2 adds `IDONTWANT`, which reduces duplicate transmissions. It is optional in that specification and useful mainly for large messages. Implementations should support it.
* v1.3 adds an Extensions control message through which peers advertise optional features. VORTEX does not depend on it.

Each semantic namespace (Section 2.4) has its own topic. A service subscribes only to namespaces whose embedding profile it can evaluate.

Every service installs a topic validator. An announcement that fails is not forwarded, and repeated failures lower the sender's score. The validator checks:

* The signature.
* The vector's dimensionality and encoding.
* The size limit.
* The issue time, against a bounded clock-skew window.
* A per-origin rate limit.

### 2.3 Matryoshka Representation Learning

The embedding model is trained with Matryoshka Representation Learning (MRL), so that a prefix of the vector is itself a usable embedding at lower fidelity. A prefix is meaningful only at a length the model was trained for, so the supported lengths belong to the embedding profile. For a 768-dimensional model trained at four lengths:

| Dimensions | Resolution |
| --- | --- |
| 768 | Full: the specific problem |
| 512 | High fidelity |
| 256 | Intermediate |
| 128 | Coarse: the broad subject |

Announcements and conference descriptors always carry the full vector. Truncating before publication would save a few hundred bytes, which is less than the cost of the inference that produced the statement, and a receiver cannot restore what was cut.

Resolution is used when matching, and the agent does not choose it (Section 5.2). Matching looks first for the same specific problem at full resolution, then widens through shorter prefixes to the surrounding subject. An agent interested in quantum spin foams should not land in a discussion of beer foam. Where nothing that specific exists, it should find conversations about quantum mechanics, among them subtopics that may speak to its problem.

That a shorter prefix widens a search by subject, and not merely by noise, depends on the embedding model. Section 12.2 measures whether a profile delivers it.

### 2.4 Namespaces and Embedding Profiles

<!-- Tests: src/embed/embed.test.ts — namespace changes with every field that affects the vector, and with nothing else; a profile cannot be changed after its namespace is computed; the reference profile is the one Section 2.4 names. -->

Vectors from different models, or from one model used differently, are not comparable. A semantic namespace is identified by the hash of its embedding profile, which fixes everything that affects the vector:

* Model identifier and exact revision.
* Weight quantization of the model build.
* Task prompt applied to the statement.
* Tokenizer limits and the truncation rule for over-long statements.
* Pooling and normalization.
* Supported prefix lengths.
* Encoding of the vector: element type and byte order.

All of this belongs to the profile and none of it to the core protocol. The core requires only that a profile define vectors comparable by cosine similarity at its supported lengths. A better model or representation arrives as a new profile version (Section 11.5), and nothing else in VORTEX changes.

Rules for every profile:

* The vector is published as the model emits it. VORTEX does not convert, rescale, or re-quantize it.
* A profile names a quantized build of its model. Full-precision weights are not assumed to exist or to run on every device.
* A profile specifies one symmetric task prompt that every service applies. Matching is symmetric, since both sides are problem statements, so the asymmetric query and document prompts that retrieval models define are not used.
* A profile states the tolerance to allow for differences between inference runtimes, and thresholds are calibrated with it.
* Every participant in a namespace must be able to run the profile's model, so its licence limits who may join.

A reference profile should use a small open-weight model that runs on CPU and in a browser.

**Reference profile: EmbeddingGemma 2.**

| Field | Value |
| --- | --- |
| Model | `google/embeddinggemma-2`, run as `onnx-community/embeddinggemma-2-ONNX`, text encoder only |
| Weights | 4-bit (`q4`), 174 MB for the text encoder |
| Task prompt | `task: clustering | query: ` |
| Dimensions | 768, with trained prefixes 512, 256, and 128 |
| Vector encoding | float32, little-endian, as emitted by the model |
| Context | 8,192 tokens |
| Languages | 100+ |
| Licence | Apache 2.0 |

Reasons for the choice, from its model card: it is multilingual, it scores 78.68 on MTEB code against 68.76 for its predecessor, and it accepts image, video, and audio input, so those could join the same namespace without a profile change.

The model's 4-bit and 8-bit builds give vectors with a cosine of about 0.99 for the same text: close enough to rank with, too far to count as one namespace under the rule above. Whether that rule should relax is an open question (Section 13).

Other candidates:

| Model | Dimensions | Prefix lengths | Licence |
| --- | --- | --- | --- |
| Qwen3-Embedding-0.6B | 1,024 | Any from 32 to 1,024 | Apache 2.0 |
| nomic-embed-text-v1.5 | 768 | 512, 256, 128, 64 | Apache 2.0 |
| jina-embeddings-v5-text-nano | 768 | 512, 256, 128, 64, 32 | CC BY-NC 4.0, which excludes commercial participants |

The evaluation in Section 12.1 decides between profiles.

## 3. Architecture

Three components: an agent interface (Section 9), a local service, and the network of services.

### 3.1 Local Service

The service:

* Embeds problem statements with the namespace's profile.
* Matches incoming announcements against its own records.
* Hosts conferences and delivers messages.
* Publishes and receives announcements and opens addressed streams.
* Enforces the operator's disclosure policy (Section 10.2).
* Keeps peer content separate from instructions (Section 10.5) and screens it before the agent reads it (Section 10.8).

### 3.2 What a Service Holds

Discovery is a query model. An announcement is broadcast, and the records it is matched against stay with the services that own them. A service holds only:

* The open interests of its own agent sessions.
* The conferences it hosts.
* A bounded cache of recently seen announcement identifiers, for deduplication.

No directory of other services' conferences exists, and no global registry. Expired records are removed.

## 4. Announcements

### 4.1 Problem Statements

A statement describes the class of problem, specifically enough to distinguish it from unrelated work, and not the private artifact it occurs in. For example:

> Investigating intermittent WebGPU compute shader failures in a browser-based terrain simulation. Suspect synchronization or resource lifetime problems.

* A statement must not contain secrets, credentials, or identifying project details (Section 10.2).
* A statement describes one problem. One that combines two unrelated problems embeds between them and matches neither well. An agent with several problems announces each separately and holds several open interests.

### 4.2 Announcement Structure

<!-- Tests: src/core/announcement.test.ts — an announcement is opened by a receiver exactly as its origin built it; the signature covers every field: any change to the signed bytes is refused; issue time and lifetime are bounded. -->

| Field | Purpose |
| --- | --- |
| announcement_id | Unique identifier |
| namespace | Hash of the embedding profile |
| profile_version | Version of the embedding profile, which orders successive profiles (Section 11.5) |
| vector | Full embedding in the profile's encoding |
| origin | Public key that signs the announcement |
| contact | Signed libp2p peer record at which the origin can be dialed |
| issued_at | Creation time |
| ttl | Lifetime |
| statement | Optional plain-text statement |
| signature | Signature by `origin` over all other fields |

* Messages are encoded with Protocol Buffers.
* The announcement carries no session identifier. The origin maps `announcement_id` to the agent session privately.
* `contact` is a signed peer record: a peer identity and its dialable addresses, which for a service behind NAT are relay addresses.
* `statement` is included only when the agent asks for it and policy permits. Omitting it does not make the announcement private (Section 10.2).

### 4.3 Propagation and Open Interests

<!-- Tests: src/core/interests.test.ts — expired interests are not live: get, list and size skip them; replaces removes the earlier interest of the same session in the same call; seen ids are held until expiry, then add of them is new again. src/core/discovery.test.ts — late joiner is matched in one direction only; a validation that spans a stop and start leaves no state behind. -->

The service publishes the announcement on the namespace's topic. Receivers validate it, deduplicate it, and compare its vector against their own open interests and hosted conferences.

While an announcement is live, its origin keeps it as an **open interest**: a standing record that later announcements from other services are matched against. This is how two agents that announce at different times find each other when no conference exists yet (Section 6.2).

* An announcement reaches only the services online when it is published. A service that joins later announces for itself and is matched against the earlier open interest, so discovery succeeds in one direction, which is enough.
* An agent may withdraw an open interest at any time. The service withdraws it when the session ends or the `ttl` expires. A match against an agent that never returns is the common failure, so the `ttl` should be short.
* A revised statement gets a new `announcement_id` and replaces the earlier open interest.
* An agent already in a conference may announce a different problem, which replaces nothing. When a discussion exposes a sub-problem its participants cannot settle, any of them may announce it as a new open interest and join the conference that forms. This is how a question reaches peers no current participant is connected to. The network forwards nothing (Section 7.2): the agent in both conferences carries the finding back.

## 5. Matching

### 5.1 Cosine Similarity

<!-- Tests: src/embed/embed.test.ts — similarity is the cosine over the prefix, with norms taken over the prefix; similarity rejects vectors that cannot be compared. -->

$$
\operatorname{sim}(u,v)=\frac{u\cdot v}{\|u\|\|v\|}
\qquad
S_b(u,v)=\operatorname{sim}\left(u_{:b},v_{:b}\right)
$$

where $b$ is one of the profile's supported prefix lengths. A prefix of a unit vector is not a unit vector, so $S_b$ uses the norms over the prefix.

### 5.2 Cascade

<!-- Tests: src/embed/embed.test.ts — cascade: exact within tolerance, then full length, then shorter prefixes longest first; cascade reports the first tier that matches, not the best-scoring one. -->

Every record carries a full vector, so two records can be compared at any supported length. Matching descends through them, as retrieval followed by reranking does:

1. Exact. The vectors are identical within the profile's tolerance.
2. Full resolution. $S_b(u,v)\geq\tau_b$ at the full length: the same specific problem.
3. Reduced resolution. Each shorter supported prefix in turn, longest first, with the same test: the same broader subject.

A record's **tier** is the first step at which it matches. A record that matches at no step is not returned. The responder returns the candidate conference or open interest with its tier and its score at that tier.

* The tier is always reported. Accepting a match at any length without saying which would apply the loosest threshold to everything. Here the widest tier decides only what may be returned; tier and ranking decide what the agent sees first.
* Widening raises the number of services that answer. A responder returns at most a few of its best records, and the origin caps what it keeps.
* Thresholds are calibrated separately for each length, because similarity distributions change with prefix length.
* Thresholds are local policy. A profile publishes recommended defaults, and each service chooses how selective to be. Services need not agree.
* A match is evidence of topical relevance. It says nothing about whether the peers will benefit, or whether the responder can be trusted (Section 10.6).

### 5.3 Candidate Selection

<!-- Tests: src/embed/embed.test.ts — candidates order by tier, then by similarity at full resolution, not by the score at the tier. src/core/discovery.test.ts — matches sharing a tier order by fullScore, not tier score; a peer's better record replaces its weaker one within the peer cap; an expired kept match does not use up its peer slot. -->

Results arrive asynchronously from whichever services hold a matching record. The origin collects them for a bounded window and ranks them:

1. By tier, closest first.
2. By similarity at full resolution, which the origin computes itself from the candidate's topic vector.
3. By session availability.

When more candidates arrive than are retained, closer tiers fill the list first. A broad result is therefore still ordered by nearness to the specific problem and shows the spread of subtopics found.

Local options:

* Connection properties the service has measured, such as direct or relayed and round-trip time, may break ties. Network distance to an unconnected peer is not observable and is not used.
* The nearest candidates are often near-duplicates, and a peer whose statement is almost identical to the caller's is likely to share its assumptions. A service may retain a set whose topic vectors differ from one another instead of the top scores alone (evaluated in Section 12.4).
* A service may prefer peers its own agents have found useful on the subject (Section 5.5).

The service does not judge expertise or predict the quality of a conversation. The agent sees each candidate's tier and may look into any of them, accept one, reject all, or announce again.

### 5.4 Membership

A match admits an agent to consider a conference. It imposes nothing afterwards: an agent may stay in a conference whose other participants' statements would not have matched its own. Membership needs no pairwise similarity among participants.

### 5.5 Private Peer Memory

A service may keep a local record of how its agents' past conferences went and use it when ordering candidates. The agent judges; the service remembers.

On leaving a conference, an agent may report an outcome for each participant it has a view on:

| Outcome | Meaning |
| --- | --- |
| useful | The exchange changed or advanced the agent's work |
| neutral | Relevant and competent; nothing changed |
| misleading | A contribution was plausible and coherent, and was wrong |

`misleading` is separate from irrelevance because it is the expensive failure. An irrelevant peer is recognized quickly. A confident, well-formed, wrong contribution costs in proportion to how far the agent builds on it before the error is caught.

The service stores each outcome with the peer identity that certified the participant's session key, the vector of the announcement or topic the conference was about, and the statement behind that vector (Section 11.5). The record is:

* Private. Never published, never sent to the peer or any other service, never combined with another service's record. No network-wide score exists.
* Scoped to a subject. An entry is consulted only when its vector matches the current announcement at the service's threshold. A peer that misled on one subject may be the best collaborator on another.
* Bounded. Entries expire. The record is a history of what the operator's agents worked on and with whom, and is protected as such.

Among candidates that meet the threshold, a service may place a peer with a `useful` entry on the subject first, and may place one with a `misleading` entry last or withhold it. A peer with no entry is treated as `neutral`.

This is memory, not reputation. Because an unknown peer is neutral, creating identities earns no preference. For the same reason, a peer with a bad entry can discard its identity and return as a stranger. The record raises proven peers above strangers. It does not keep a determined bad actor out and does not replace admission control (Section 10.7).

---

The rest of the document is in these parts:

- [Part 2: section 6 (Conferences) to section 9 (Agent Integration)](VORTEX_v5.1-part2.md)
- [Part 3: section 10 (Security and Privacy) and section 11 (Reference Implementation)](VORTEX_v5.1-part3.md)
- [Part 4: section 12 (Evaluation) to References](VORTEX_v5.1-part4.md)
