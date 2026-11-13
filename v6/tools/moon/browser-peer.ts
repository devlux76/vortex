import { createLibp2p } from 'libp2p'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { peerIdFromString } from '@libp2p/peer-id'
import { lpStream } from '@libp2p/utils'
import { webSockets } from '@libp2p/websockets'
import { yamux } from '@libp2p/yamux'
import { multiaddr } from '@multiformats/multiaddr'
import type { PrivateKey } from '@libp2p/interface'
import { RV_PROTOCOL, rendezvousDiscover, rendezvousRegister } from '../../p2p/rendezvous.ts'
import { decodeMessage, encodeMessage, MessageType, Status } from '../../p2p/rendezvous-pb.ts'
import { MSG_PROTOCOL, signMessage, verifyMessage, type P2PMessage } from '../../p2p/message.ts'

export const createIdentity = () => generateKeyPair('Ed25519')

export async function connect (relayAddress: string, onMessage: (message: P2PMessage, via: string) => void, key: PrivateKey) {
  const relay = multiaddr(relayAddress)
  const component = relay.getComponents().at(-1)
  if (component?.name !== 'p2p' || component.value === undefined) throw new Error('Relay address needs a peer ID')
  const relayId = peerIdFromString(component.value)
  const node = await createLibp2p({
    privateKey: key,
    connectionManager: { dialTimeout: 15000 },
    addresses: { listen: ['/p2p-circuit'] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: address => {
      const target = address.toString()
      return target !== relayAddress && !target.startsWith(`${relayAddress}/p2p-circuit/`)
    } },
    services: { identify: identify() },
  })
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  await node.handle(MSG_PROTOCOL, async (stream, conn) => {
    const frames = lpStream(stream, { maxDataLength: 128 * 1024 })
    try {
      const raw = JSON.parse(decoder.decode((await frames.read({ signal: AbortSignal.timeout(5000) })).subarray()))
      const msg = await verifyMessage(raw, conn.remotePeer, node.peerId)
      await frames.write(encoder.encode('{"ok":true}'))
      await stream.close()
      onMessage(msg, conn.remoteAddr.toString())
    } catch (error) {
      stream.abort(error as Error)
    }
  }, { runOnLimitedConnection: true })
  try {
    await node.dial(relay)
    for (let attempt = 0; !node.getMultiaddrs().some(addr => String(addr).includes('/p2p-circuit')); attempt++) {
      if (attempt >= 100) throw new Error('No relay reservation')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } catch (error) {
    await node.stop()
    throw error
  }
  return {
    id: String(node.peerId),
    addr: node.getMultiaddrs().map(String),
    discover: async () => {
      const signal = AbortSignal.timeout(10000)
      const stream = await node.dialProtocol(relayId, RV_PROTOCOL, { signal })
      const frames = lpStream(stream)
      try {
        await frames.write(encodeMessage({ type: MessageType.DISCOVER, discover: {} }), { signal })
        const response = decodeMessage((await frames.read({ signal })).subarray()).discoverResponse
        if (!response || response.status !== Status.OK) throw new Error('Rendezvous discovery refused')
        await stream.close()
        return [...new Set(response.registrations.flatMap(record => record.ns ? [record.ns] : []))]
      } catch (error) {
        stream.abort(error as Error)
        throw error
      }
    },
    register: async (namespace: string) => rendezvousRegister(node, key, relayId, namespace, 120, AbortSignal.timeout(10000)),
    peers: async (namespace: string) => (await rendezvousDiscover(node, relayId, namespace, { signal: AbortSignal.timeout(10000) })).peers.map(peer => String(peer.id)),
    send: async (id: string, text: string) => {
      const dest = peerIdFromString(id)
      const signal = AbortSignal.timeout(10000)
      const conn = await node.dial(relay.encapsulate(`/p2p-circuit/p2p/${id}`), { force: true })
      const stream = await conn.newStream(MSG_PROTOCOL, { runOnLimitedConnection: true })
      const frames = lpStream(stream, { maxDataLength: 128 * 1024 })
      const msg = await signMessage(key, node.peerId, dest, text)
      try {
        await frames.write(encoder.encode(JSON.stringify(msg)), { signal })
        const ack = JSON.parse(decoder.decode((await frames.read({ signal })).subarray()))
        if (!ack.ok) throw new Error(ack.error ?? 'Peer refused the message')
        await stream.close()
        return { via: String(conn.remoteAddr), ack }
      } catch (error) {
        stream.abort(error as Error)
        throw error
      }
    },
    stop: () => node.stop(),
  }
}
