// Circuit Relay v2 server + rendezvous point, listening on WebSockets.
//
// Locally it listens on plain ws (e.g. /ip4/127.0.0.1/tcp/0/ws). In production
// a TLS-terminating proxy with a CA-signed certificate fronts it on 443 and the
// relay announces /dns4/<host>/tcp/443/wss so peers dial the public name.
// Noise runs inside the WebSocket, so a proxy that terminates or re-signs TLS
// still cannot impersonate either peer.
import './bun-compat.ts'
import { createLibp2p } from 'libp2p'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { webSockets } from '@libp2p/websockets'
import type { Libp2p, PrivateKey, PeerId } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import { loadOrCreateKey } from './identity.ts'
import { startRendezvousServer, type RendezvousServer, type RendezvousServerOptions } from './rendezvous.ts'
import { hubAdmission, type Admission } from './admission.ts'

export interface RelayOptions {
  /** Listen multiaddrs. Default: /ip4/127.0.0.1/tcp/0/ws */
  listen?: string[]
  /** Public addresses to announce instead of the listen ones (e.g. /dns4/host/tcp/443/wss). */
  announce?: string[]
  /** Persistent identity; without it the relay gets a fresh id each start. */
  keyFile?: string
  /** Max simultaneous circuit reservations. */
  maxReservations?: number
  /** Serve rendezvous on this node (default true); pass options for the caps. */
  rendezvous?: boolean | RendezvousServerOptions
  /** Admission through the hub's principal_keys (#24): read-only path to the hub database. Without it the relay stays open. */
  admitDb?: string
}

export interface Relay {
  node: Libp2p
  rendezvous: RendezvousServer | null
  /** Dialable addresses, each ending in /p2p/<relay id>. */
  addrs: () => Multiaddr[]
  stop: () => Promise<void>
}

export async function startRelay (opts: RelayOptions = {}): Promise<Relay> {
  const privateKey: PrivateKey | undefined = opts.keyFile ? await loadOrCreateKey(opts.keyFile) : undefined
  const admission: Admission | undefined = opts.admitDb !== undefined ? hubAdmission(opts.admitDb) : undefined
  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: {
      listen: opts.listen ?? ['/ip4/127.0.0.1/tcp/0/ws'],
      ...(opts.announce ? { announce: opts.announce } : {})
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: admission === undefined ? undefined : {
      // #24: only peers whose key is enrolled, unrevoked and unexpired may
      // connect at all, so reservations and rendezvous inherit the gate.
      denyInboundEncryptedConnection: async peerId => !(await admission.admit(peerId.toString()))
    },
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: { maxReservations: opts.maxReservations ?? 128 }
      })
    }
  })
  const rvOpts = opts.rendezvous === false ? null : opts.rendezvous === true || opts.rendezvous === undefined ? {} : opts.rendezvous
  const rendezvous = rvOpts === null
    ? null
    : await startRendezvousServer(node, {
      ...rvOpts,
      admit: admission === undefined ? undefined : (peer: PeerId | string) => admission.admit(peer.toString())
    })
  return {
    node,
    rendezvous,
    addrs: () => node.getMultiaddrs(),
    stop: async () => {
      await rendezvous?.stop()
      await node.stop()
    }
  }
}
