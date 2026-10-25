import { noise, pureJsCrypto } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { gossipsub, type GossipSub, type Message } from '@libp2p/gossipsub'
import { identify } from '@libp2p/identify'
import type { Libp2p, PrivateKey } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import type {
  DirectEvent, GossipHandler, GossipVerdict, Multiaddr, PeerEvent, PeerId, Transport, TransportInfo, Unsubscribe
} from '../types.ts'

/**
 * Shared libp2p wiring for the desktop (TCP) and browser (WebSocket)
 * transports. Browser-bound: this file and everything it imports use no
 * Node built-in and no `Bun` global, so it can be bundled for an extension.
 */

/** Direct-message protocol, the same on every transport. */
export const DIRECT_PROTOCOL = '/vortex/direct/1.0.0'

export type SharedNode = Libp2p<{ pubsub: GossipSub }>

export interface BaseTransportOptions {
  /** Protobuf-encoded private key from a previous `exportKey()`. A new identity is created if absent. */
  key?: Uint8Array
  /** Largest direct message accepted, in bytes. */
  maxDirectBytes?: number
}

export interface BaseTransport extends Transport {
  /** The identity key, for the caller to persist. Treat as a secret. */
  exportKey(): Uint8Array
}

/** The libp2p-level choices that differ between transports. */
export interface Libp2pWiring {
  transports: any[]
  /** Omit to create a node with no listen addresses: it dials and is never dialed. */
  listen?: Multiaddr[]
  /** Omit to leave dialing unrestricted. */
  denyDialMultiaddr?: (addr: { toString(): string }) => boolean
}

export async function createBaseTransport (options: BaseTransportOptions, wiring: Libp2pWiring): Promise<BaseTransport> {
  const key: PrivateKey = options.key != null ? privateKeyFromProtobuf(options.key) : await generateKeyPair('Ed25519')
  const maxDirectBytes = options.maxDirectBytes ?? 256 * 1024
  const directHandlers = new Set<(event: DirectEvent) => void>()
  const peerHandlers = new Set<(event: PeerEvent) => void>()
  let node: SharedNode | undefined

  const started = (): SharedNode => {
    if (node == null) throw new Error('transport is not started')
    return node
  }

  const info = (): TransportInfo => {
    const n = started()
    return { peerId: n.peerId.toString(), addrs: n.getMultiaddrs().map(a => a.toString()) }
  }

  return {
    async start () {
      node = await createLibp2p({
        privateKey: key,
        ...(wiring.listen ? { addresses: { listen: wiring.listen } } : {}),
        transports: wiring.transports,
        ...(wiring.denyDialMultiaddr ? { connectionGater: { denyDialMultiaddr: wiring.denyDialMultiaddr } } : {}),
        // Use the browser crypto implementation: Bun lacks Node's ChaCha20-Poly1305 cipher.
        connectionEncrypters: [noise({ crypto: pureJsCrypto })],
        streamMuxers: [yamux()],
        services: {
          identify: identify(),
          // StrictSign is the default: every message is signed by its publisher
          // and unsigned or badly signed messages are dropped before validation.
          pubsub: gossipsub({ allowPublishToZeroTopicPeers: true })
        }
      }) as unknown as SharedNode

      await node.handle(DIRECT_PROTOCOL, async (stream, connection) => {
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for await (const chunk of stream) {
            size += chunk.byteLength
            if (size > maxDirectBytes) {
              stream.abort(new Error('direct message exceeds size limit'))
              return
            }
            chunks.push(chunk.subarray())
          }
        } catch {
          return
        }
        const data = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          data.set(chunk, offset)
          offset += chunk.byteLength
        }
        // Close our half too. A stream the sender finished but we left open
        // still counts against the 32 inbound streams libp2p allows this
        // protocol per connection; once they are used up every later message
        // on the connection is reset unread while its sender sees a clean write.
        await stream.close().catch(error => { stream.abort(error) })
        const event: DirectEvent = { from: connection.remotePeer.toString(), data }
        for (const handler of directHandlers) handler(event)
      })

      const emitPeer = (kind: PeerEvent['kind']) => (event: CustomEvent<{ toString(): string }>) => {
        for (const handler of peerHandlers) handler({ kind, peer: event.detail.toString() })
      }
      node.addEventListener('peer:connect', emitPeer('connect'))
      node.addEventListener('peer:disconnect', emitPeer('disconnect'))

      return info()
    },

    async stop () {
      if (node == null) return
      // Abort connections first: under Bun a graceful TCP close never
      // completes and stop() would hang.
      for (const connection of node.getConnections()) connection.abort(new Error('transport stopping'))
      await node.stop()
      node = undefined
    },

    info,

    async dial (addr: Multiaddr): Promise<PeerId> {
      const connection = await started().dial(multiaddr(addr))
      return connection.remotePeer.toString()
    },

    async subscribe (topic: string, handler: GossipHandler) {
      const pubsub = started().services.pubsub
      pubsub.topicValidators.set(topic, async (relayedBy, message: Message) => {
        if (message.type !== 'signed') return 'ignore' as never
        let verdict: GossipVerdict
        try {
          verdict = await handler({
            topic,
            id: `${message.from.toString()}:${message.sequenceNumber}`,
            origin: message.from.toString(),
            relayedBy: relayedBy.toString(),
            data: message.data
          })
        } catch {
          verdict = 'ignore'
        }
        return verdict as never
      })
      pubsub.subscribe(topic)
    },

    async unsubscribe (topic: string) {
      const pubsub = started().services.pubsub
      pubsub.unsubscribe(topic)
      pubsub.topicValidators.delete(topic)
    },

    async publish (topic: string, data: Uint8Array) {
      const result = await started().services.pubsub.publish(topic, data)
      return { recipients: result.recipients.length }
    },

    async send (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]) {
      const n = started()
      const id = peerIdFromString(peer)
      if (addrs != null && addrs.length > 0) {
        await n.peerStore.merge(id, { multiaddrs: addrs.map(a => multiaddr(a)) })
      }
      const stream = await n.dialProtocol(id, DIRECT_PROTOCOL)
      if (!stream.send(data)) await stream.onDrain()
      await stream.close()
      // The receiver closes its half once it has read the message, and resets
      // the stream when it refuses it. Wait briefly for either, so a refused
      // message fails here instead of being reported as sent. A peer running
      // older code never closes; the wait then lapses and the write stands.
      let lapse: ReturnType<typeof setTimeout> | undefined
      const ended = (async () => { for await (const _ of stream) { /* no reply body is expected */ } })()
      try {
        await Promise.race([ended, new Promise<void>(resolve => { lapse = setTimeout(resolve, 2000) })])
      } catch (error) {
        throw new Error(`direct message was not accepted by ${peer}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(lapse)
        ended.catch(() => {})
      }
    },

    onDirect (handler): Unsubscribe {
      directHandlers.add(handler)
      return () => { directHandlers.delete(handler) }
    },

    onPeer (handler): Unsubscribe {
      peerHandlers.add(handler)
      return () => { peerHandlers.delete(handler) }
    },

    async sign (data: Uint8Array) {
      return await key.sign(data)
    },

    async verify (peer: PeerId, data: Uint8Array, signature: Uint8Array) {
      const publicKey = peerIdFromString(peer).publicKey
      if (publicKey == null) return false
      return await publicKey.verify(data, signature)
    },

    exportKey () {
      return privateKeyToProtobuf(key)
    }
  }
}
