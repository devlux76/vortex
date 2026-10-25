/**
 * Shared contract between the VORTEX core (src/core) and its adapters
 * (src/net, src/embed).
 *
 * Nothing in this file may import a Node built-in: the core runs in browsers.
 */

/** A libp2p peer identity in its string form, for example "12D3KooW...". */
export type PeerId = string

/** A libp2p multiaddr in its string form, ending in "/p2p/<PeerId>". */
export type Multiaddr = string

export interface TransportInfo {
  peerId: PeerId
  /** Addresses at which this service can currently be dialed. */
  addrs: Multiaddr[]
}

/** One message received on a broadcast topic. */
export interface GossipEvent {
  topic: string
  /** Transport-level message identifier, stable across relays. Use for deduplication. */
  id: string
  /**
   * The peer that published the message. The transport has verified its
   * signature over the message, so this is authenticated.
   */
  origin: PeerId
  /**
   * The peer this copy arrived from. Usually not the author, and says
   * nothing about who wrote the message.
   */
  relayedBy: PeerId
  data: Uint8Array
}

/**
 * What to do with a broadcast message. Only "accept" forwards it to other
 * peers. "reject" also lowers the relaying peer's score; "ignore" does not.
 */
export type GossipVerdict = 'accept' | 'reject' | 'ignore'

export type GossipHandler = (event: GossipEvent) => GossipVerdict | Promise<GossipVerdict>

/** One addressed message received on a direct stream. */
export interface DirectEvent {
  /** The sending peer, authenticated by the connection handshake. */
  from: PeerId
  data: Uint8Array
}

export interface PeerEvent {
  kind: 'connect' | 'disconnect'
  peer: PeerId
}

export type Unsubscribe = () => void

/**
 * Moves opaque bytes between services. It does not interpret payloads:
 * validation, matching, formation, and admission belong to the core.
 */
export interface Transport {
  start(): Promise<TransportInfo>
  stop(): Promise<void>
  info(): TransportInfo

  /** Connect to a peer at a known address, for example a bootstrap peer. */
  dial(addr: Multiaddr): Promise<PeerId>

  /**
   * Join a broadcast topic. The handler is both the validator and the
   * delivery point: it sees every message once, before it is forwarded.
   * A handler that throws is treated as "ignore".
   */
  subscribe(topic: string, handler: GossipHandler): Promise<void>
  unsubscribe(topic: string): Promise<void>

  /** Broadcast on a topic. Resolves with the number of peers it was sent to. */
  publish(topic: string, data: Uint8Array): Promise<{ recipients: number }>

  /**
   * Deliver one message to one peer. Dials `addrs` if not already connected.
   * Resolves when the bytes have been written, not when they have been read.
   */
  send(peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]): Promise<void>

  onDirect(handler: (event: DirectEvent) => void): Unsubscribe
  onPeer(handler: (event: PeerEvent) => void): Unsubscribe

  /** Sign with this service's identity key. */
  sign(data: Uint8Array): Promise<Uint8Array>
  /** Check a signature against the key embedded in a peer identity. */
  verify(peer: PeerId, data: Uint8Array, signature: Uint8Array): Promise<boolean>
}

/**
 * Everything that determines whether two vectors are comparable (Section 2.4),
 * with what a service needs in order to match under it.
 */
export interface EmbeddingProfile {
  /**
   * The namespace: a hash of every field below down to `encoding`. Vectors
   * are comparable only if this is equal.
   */
  id: string
  /** Model identifier, or the name of a non-model method. */
  model: string
  /** Exact revision of the model files, for example a commit hash. Never a moving name such as a branch. */
  revision: string
  /** Weight quantization of the model build. */
  weights: string
  /** The one symmetric task prompt placed before every statement. */
  prompt: string
  /** Most tokens the tokenizer passes to the model, prompt included. */
  maxTokens: number
  /** What happens to a statement longer than `maxTokens`: 'tail' drops what follows the limit. */
  truncation: 'tail'
  /** How token states become one vector. */
  pooling: string
  /** Normalization applied before the vector is published. */
  normalization: string
  /** Supported prefix lengths, longest first. The first is the full length every published vector has. */
  dims: number[]
  /** Element type and byte order of a published vector. */
  encoding: 'float32le'
  /**
   * Says which of two profiles is newer, which a hash cannot (Section 11.5).
   * Carried beside the namespace; not part of the hash.
   */
  version: number
  /**
   * Allowance for differences between inference runtimes: two full vectors
   * whose cosine is at least `1 - tolerance` are the same statement. Not part
   * of the hash.
   */
  tolerance: number
  /**
   * Recommended similarity threshold for each length in `dims`. Defaults
   * only: thresholds are local policy (Section 5.2). Not part of the hash.
   */
  thresholds: Record<number, number>
}

export interface Embedder {
  profile(): EmbeddingProfile
  /**
   * Embed a statement and return the full vector as the model emits it. The
   * profile's prompt is applied here; callers pass the bare statement.
   */
  embed(text: string): Promise<Float32Array>
}

/** The first step of the cascade at which two vectors match (Section 5.2). */
export interface Tier {
  /** 'exact', or the prefix length at which the threshold was met. */
  tier: 'exact' | number
  /** Cosine similarity at that tier, in [-1, 1]. */
  score: number
}
