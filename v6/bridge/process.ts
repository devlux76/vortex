// The hub↔mesh bridge process (sub-issue #13 of #3): one process holding a
// hub principal and a libp2p peer.
//
// - Hub half: the A7 §3a edge client (v6/client/edge.ts). Every request is
//   signed; the hub id (TLS certificate fingerprint) binds it to one hub.
//   The skeleton proves the identity once at startup with one signed GET.
// - Mesh half: the libp2p peer of v6/p2p/node.ts (#8): persistent key, relay
//   reservation, signed messages, rendezvous.
//
// Delivery both ways (#11, #20) layers on top of this lifecycle. The bridge
// key is `unsealed` custody for now: the hub caps it to named rooms, and the
// key file is the A7 stand-in (§2 rules it out for remote principals; sealed
// tiers come with the A7 signers).
import { startPeer, type Peer } from '../p2p/node.ts'
import { loadOrCreateKey } from '../p2p/identity.ts'
import { EdgeClient } from '../client/edge.ts'
import type { PrivateKey } from '@libp2p/interface'

export interface BridgeOptions {
  /** libp2p peer key file (#8); created with mode 0600 when missing. */
  keyFile: string
  /** Relay multiaddr ending in /p2p/<relay id>. */
  relay: string
  /** Hub edge key file written by `vx edge keygen` (A7 §3a). */
  hubKeyFile: string
  /** Overrides for the hub_url/hub_id recorded in the key file (tests). */
  hubUrl?: string
  hubId?: string
  /** A prebuilt hub client instead of `hubKeyFile` (the bridge's own libp2p key, #11). */
  edge?: EdgeClient
  /** Accept a self-signed hub certificate; loopback hosts only (tests). */
  insecureLoopback?: boolean
}

export interface Bridge {
  /** The mesh half (#8). */
  peer: Peer
  /** The hub half (A7 §3a). Stateless fetch; nothing to close. */
  edge: EdgeClient
  /** The mesh key file; delivery state files are derived from it. */
  keyFile: string
  /**
   * The libp2p private key, for signing envelopes inside this process
   * (v6/bridge/delivery.ts). Process-internal: no model-facing tool or hub
   * route ever sees it or a signature over arbitrary data (A7 §2, §6).
   */
  privateKey: PrivateKey
  /** Stops the mesh half and closes state. Idempotent. */
  stop: () => Promise<void>
}

export async function startBridge (opts: BridgeOptions): Promise<Bridge> {
  const edge = opts.edge ?? await EdgeClient.fromKeyFile(opts.hubKeyFile, {
    url: opts.hubUrl,
    hubId: opts.hubId,
    insecureLoopback: opts.insecureLoopback
  })
  // Signed handshake before the mesh half starts: one authenticated round trip
  // proves the key, the hub id and the TLS listener all agree, so a bridge with
  // a wrong identity never comes up at all. /v1/recent is room-independent, so
  // it works for any enrolled principal.
  await edge.request('GET', '/v1/recent')
  // Loaded before the peer starts; startPeer loads the same file and gets the
  // same key, and the delivery layer signs envelopes with it in-process.
  const privateKey = await loadOrCreateKey(opts.keyFile)
  const peer = await startPeer({ keyFile: opts.keyFile, relay: opts.relay })
  // Concurrent stop() callers share one in-flight shutdown: the second caller
  // awaits the same promise instead of returning early (or missing a failure).
  // A failed stop clears the promise so the shutdown can be retried.
  let stopping: Promise<void> | undefined
  return {
    peer,
    edge,
    keyFile: opts.keyFile,
    privateKey,
    stop: () => {
      if (stopping === undefined) {
        stopping = peer.stop().catch(e => {
          stopping = undefined
          throw e
        })
      }
      return stopping
    }
  }
}
