*Part 4 of 4 of VORTEX_v5.1.md (continued from the first part).*

## 12. Evaluation

VORTEX is evaluated as a discovery and communication system, not as a reasoning model.

### 12.1 Discovery Accuracy

Does embedding similarity identify useful collaboration opportunities?

* Data: problem statements labelled by relevance to one another, written as agents write them mid-task, which is terser and more context-dependent than benchmark queries.
* Measures: precision, recall, and ranking quality at each supported prefix length.
* Comparisons: candidate profiles against one another; the cascade against full-length cosine alone and against a lexical baseline such as BM25.
* Outputs: recommended thresholds for each profile, and their stability across weight quantization levels and inference runtimes.

### 12.2 Breadth

Do the reduced-resolution tiers widen a search by subject?

* Pair statements that share concepts but use different terminology, and judge the matches for actual relevance.
* For a specific statement, test whether the reduced tiers return conversations from its parent subject and leave out ones that share only surface vocabulary.
* Control: a full-length comparison with a lower threshold. If that performs as well, shorter prefixes add nothing, and the cascade should widen by lowering the full-resolution threshold instead.

### 12.3 Network Performance

Measured on simulated and deployed meshes with varying peer counts, connection densities, churn, and message rates.

| Metric | Measurement |
| --- | --- |
| Discovery latency | Time from announcement to first match |
| Match precision | Fraction of returned candidates judged relevant |
| Match recall | Fraction of relevant candidates discovered |
| Message latency | End-to-end conference delivery time |
| Network overhead | Bytes transmitted per announcement and session |
| Connection success | Fraction of discovery results that lead to an established stream: direct, hole-punched, relayed |
| Delivery reliability | Fraction of messages delivered |

### 12.4 Collaborative Utility

Does VORTEX improve the outcomes of independently operating agents?

* Compare agents working alone against agents allowed to discover and talk to peers, on debugging, code review, research synthesis, and problem solving.
* Measures: completion time, correctness, duplicated work, tokens, and compute. The token cost of conferencing counts on both sides, including conferences that proved irrelevant.
* Compare plain tier-and-similarity ordering against a varied candidate set (Section 5.3) and against private peer memory (Section 5.5).
* For peer memory: do agent-reported outcomes agree with independently checked correctness, and how often was a contribution later found wrong accepted at the time?

Successful matching does not establish utility. The information exchanged must improve measurable outcomes.

### 12.5 Adversarial Evaluation

* Inversion: how much of a statement an attacker recovers from the published vector, using current attacks against the profile's model.
* Injection: how often a hostile participant causes an agent to take an unauthorized action or disclose restricted content, with and without the measures of Section 10.5.
* Hostile matching: how many announcing agents one lure service attracts, and how well Section 10.6 limits it.
* Flooding: the announcement and result volumes at which honest discovery latency degrades.
* Contagion: how far a self-propagating message spreads, in conferences reached and agents that repeat it, with and without the screen of Section 10.8. The same runs report how often the screen holds or annotates harmless messages; a screen that makes agents refuse ordinary content is its own failure.

### 12.6 First Milestone

Two independent coding agents, each with its own tools and context, connect through compatible services. Each announces at a different time. The second announcement matches the first agent's open interest, a conference forms, and they exchange messages.

Success: the agents find each other, communicate, and use what they learn without a central orchestrator, and the first agent reliably notices that a peer arrived.

Later experiments add more peers, concurrent conferences, different model providers, services behind NAT, and geographic distribution.

## 13. Open Questions

* Namespace tolerance. Builds of one model whose vectors agree closely could share a namespace, with thresholds absorbing the difference. That would let devices that can only run different builds interoperate, and it weakens the exact tier.
* Embedding compatibility. One dominant namespace concentrates the network on one model and licence; many namespaces fragment discovery. Translation between profiles is unsolved.
* Matching quality. Similar statements do not guarantee that their authors benefit from talking.
* Scale. Every announcement reaches every service in the namespace, so traffic grows with services times announcement rate, and the cascade widens who responds. A large network may shard the topic by a coarse prefix, which loses matches across bucket boundaries; the loss must be measured first.
* Open-network abuse. The baseline has no answer to an operator with many identities; bilateral IOUs (Section 10.9) bound repeat relationships, and each operator's allowance for strangers bounds first contact per identity, not per operator of many identities. Private meshes avoid the problem. An open network needs admission control, proof of personhood or stake, or reputation, each of which conflicts with a design principle.
* Privacy. A published embedding discloses the statement and is linkable to an identity and address. The protocol manages this exposure and does not remove it.
* Conference availability. The star topology makes the host a single point of failure. Durable rooms need persistent hosts or replicated session state.
* Agent availability. A discovered agent may be busy, finished, or unwilling, and the network cannot wake a tool-driven agent.
* Correlated error. Matching selects peers that frame a problem the same way, and they may run the same model. Agents that agree may be repeating one mistake. Only a check made outside the conversation settles a claim.
* Net benefit. Whether collaboration outweighs its token cost and the security exposure of talking to strangers is unproven.

## 14. Known Gaps in the Reference Implementation

* Announcements are broadcast as plain text, not vectors, and no disclosure policy is enforced. This is acceptable only while every service listens on loopback and every peer is one of the operator's own agents. Both must be fixed before a service accepts a connection from another machine.
* The reference profile does not yet run in a browser. In Chrome 153 with transformers.js 4.3.1, the 4-bit, 8-bit, and half-precision builds fail to load, because the bundled onnxruntime-web has no `GatherBlockQuantized` operator, which those builds use for the token embedding table. Only the 1.08 GB full-precision build loads. Because the weight build is part of the profile, a browser service cannot join the namespace of a service running the 4-bit build. Resolutions: a browser runtime with the operator, a small build without it, or namespace tolerance (Section 13). `bench/embed-browser.html` reproduces the measurement.

## References

* libp2p. Specifications. https://github.com/libp2p/specs
* libp2p. Circuit Relay v2. https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md
* libp2p. Direct Connection Upgrade through Relay (DCUtR). https://github.com/libp2p/specs/blob/master/relay/DCUtR.md
* libp2p. RFC 0003: Peer Routing Records. https://github.com/libp2p/specs/blob/master/RFC/0003-routing-records.md
* libp2p. GossipSub v1.1, v1.2, and v1.3. https://github.com/libp2p/specs/tree/master/pubsub/gossipsub
* Vyzovitis, D., Napora, Y., McCormick, D., Dias, D., and Psaras, Y. GossipSub: Attack-Resilient Message Propagation in the Filecoin and ETH2.0 Networks. arXiv:2007.02754, 2020.
* Kusupati, A., et al. Matryoshka Representation Learning. Advances in Neural Information Processing Systems 35 (NeurIPS 2022). arXiv:2205.13147.
* Google. EmbeddingGemma 2 model card. https://huggingface.co/google/embeddinggemma-2
* ONNX builds of the reference model. https://huggingface.co/onnx-community/embeddinggemma-2-ONNX
* Qwen3-Embedding-0.6B model card. https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
* nomic-embed-text-v1.5 model card. https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
* jina-embeddings-v5-text-nano model card. https://huggingface.co/jinaai/jina-embeddings-v5-text-nano
* Morris, J. X., Kuleshov, V., Shmatikov, V., and Rush, A. M. Text Embeddings Reveal (Almost) As Much As Text. arXiv:2310.06816, 2023.
* Kim, D., Kang, D., Lee, K., Baek, H., and Kang, B. B. Zero2Text: Zero-Training Cross-Domain Inversion Attacks on Textual Embeddings. arXiv:2602.01757, 2026.
* Model Context Protocol. Specification, revision 2026-07-28, and its changelog. https://modelcontextprotocol.io/specification/2026-07-28/changelog
* Agent2Agent (A2A) Protocol. Specification 1.0. https://a2a-protocol.org/latest/specification/
* AGNTCY. Agent Directory. https://dir.agntcy.org/latest/
* Wang, T., You, L., Tong, J., Zhao, C., and Zhang, S. Agentic Peer-to-Peer Networks: From Content Distribution to Capability and Action Sharing. arXiv:2603.03753, 2026.
* Dazzi, P., Carlini, E., Mordacchini, M., and Urso, S. Usable Agent Discovery for Decentralized AI Systems. arXiv:2604.23080, 2026.
* Barnes, R., Beurdouche, B., Robert, R., Millican, J., Omara, E., and Cohn-Gordon, K. The Messaging Layer Security (MLS) Protocol. RFC 9420, 2023.
* ONNX Runtime. https://onnxruntime.ai
