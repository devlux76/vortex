// A VORTEX p2p peer: persistent Ed25519 identity, reachable only through a
// Circuit Relay v2 reservation (optionally upgraded to WebRTC), discoverable by
// rendezvous, exchanging signed messages on /vortex/msg/1.0.0.
import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@libp2p/noise'
import { yamux } from '@libp2p/yamux'
import { peerIdFromString } from '@libp2p/peer-id'
import { lpStream } from '@libp2p/utils'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import type { Connection, Libp2p, PeerId, PrivateKey, Stream } from '@libp2p/interface'
import { loadOrCreateKey } from './identity.ts'
import { MSG_PROTOCOL, screenOutbound, signMessage, verifyMessage, type P2PMessage } from './message.ts'
import { DedupStore } from './dedup.ts'
import { rendezvousDiscover, rendezvousRegister, type Discovered } from './rendezvous.ts'
import { buildTransports, type IceConfig } from './transports.ts'

const MAX_FRAME = 128 * 1024

export interface PeerOptions {
  /** Key file (created with mode 0600 when missing). */
  keyFile: string
  /** Relay multiaddr ending in /p2p/<relay id>. */
  relay: string
  /** Enable the WebRTC transport (signaled over the relay). Default false. */
  webrtc?: boolean
  ice?: IceConfig
  /** Called for every message that verified. */
  onMessage?: (msg: P2PMessage, conn: Connection) => void
  /** Called for every message that failed verification. */
  onReject?: (reason: string, conn: Connection) => void
  /** Reservation wait, ms. */
  timeoutMs?: number
  /** Dedup database path. Default: `<keyFile>.dedup.sqlite` (persisted, so a restart does not reopen replay). */
  dedupFile?: string
}

export interface Ack { ok: boolean, error?: string }

export interface Peer {
  node: Libp2p
  id: PeerId
  relayId: PeerId
  webrtc: boolean
  webrtcError?: string
  inbox: P2PMessage[]
  /** Address others dial to reach this peer through the relay. */
  circuitAddr: () => Multiaddr
  /** Send one signed message. `via: 'webrtc'` asks for a direct WebRTC upgrade. */
  send: (to: PeerId | string, text: string, via?: 'relay' | 'webrtc') => Promise<{ ack: Ack, conn: Connection }>
  /** Send an arbitrary frame (tests: tampered messages). */
  sendRaw: (to: PeerId | string, frame: unknown, via?: 'relay' | 'webrtc') => Promise<{ ack: Ack, conn: Connection }>
  register: (ns: string, ttl?: number) => Promise<number>
  discover: (ns: string) => Promise<Discovered[]>
  stop: () => Promise<void>
}

export function peerIdOf (addr: Multiaddr): PeerId {
  const p2p = addr.getComponents().filter(c => c.name === 'p2p').pop()
  if (p2p?.value == null) throw new Error('multiaddr has no /p2p/<peer id>')
  return peerIdFromString(p2p.value)
}

export function isRelayed (conn: Connection): boolean {
  return conn.remoteAddr.getComponents().some(c => c.name === 'p2p-circuit')
}

export async function startPeer (opts: PeerOptions): Promise<Peer> {
  const privateKey: PrivateKey = await loadOrCreateKey(opts.keyFile)
  const relayAddr = multiaddr(opts.relay)
  const relayId = peerIdOf(relayAddr)
  const t = await buildTransports({ webrtc: opts.webrtc, ice: opts.ice })

  const node = await createLibp2p({
    privateKey,
    addresses: {
      // No direct listener: the peer is reachable only via the relay
      // reservation (and WebRTC signaled over it).
      listen: ['/p2p-circuit', ...(t.webrtc ? ['/webrtc'] : [])]
    },
    transports: t.transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      // Direct dials go only to the relay; everyone else is reached through it.
      denyDialMultiaddr: (ma: Multiaddr) => {
        const comps = ma.getComponents()
        if (comps.some(c => c.name === 'p2p-circuit')) return false
        const p2p = comps.filter(c => c.name === 'p2p').pop()
        return p2p?.value !== relayId.toString()
      }
    },
    services: { identify: identify() }
  })
  const self = node.peerId
  const inbox: P2PMessage[] = []
  const dedup = new DedupStore(opts.dedupFile ?? `${opts.keyFile}.dedup.sqlite`)

  async function onStream (stream: Stream, conn: Connection): Promise<void> {
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME })
    let ack: Ack
    try {
      const raw = JSON.parse(new TextDecoder().decode((await lp.read()).subarray())) as unknown
      const msg = await verifyMessage(raw, conn.remotePeer, self)
      // Dedup on (from, id), persisted (PR #8, Sun's QA). Claimed only after
      // the signature verifies, so unsigned noise cannot fill the store.
      const claim = dedup.claim(msg.from, msg.id)
      if (claim === 'used') throw new Error('duplicate message')
      if (claim === 'full') throw new Error('too many messages; retry shortly')
      inbox.push(msg)
      opts.onMessage?.(msg, conn)
      ack = { ok: true }
    } catch (e) {
      const reason = (e as Error).message
      opts.onReject?.(reason, conn)
      ack = { ok: false, error: reason }
    }
    try {
      await lp.write(new TextEncoder().encode(JSON.stringify(ack)))
      await stream.close()
    } catch (e) {
      stream.abort(e as Error)
    }
  }
  await node.handle(MSG_PROTOCOL, onStream, { runOnLimitedConnection: true })

  // A failed dial or reservation must leave nothing open (Sun's QA on #30):
  // the node and the dedup store are already allocated here, so the startup
  // failure path closes both before the error propagates.
  try {
    await node.dial(relayAddr)
    await waitForReservation(node, relayId, opts.timeoutMs ?? 15_000)
  } catch (e) {
    await Promise.resolve(node.stop()).catch(() => {})
    dedup.close()
    throw e
  }

  const circuitAddr = (): Multiaddr => relayAddr.encapsulate(`/p2p-circuit/p2p/${self.toString()}`)

  async function sendFrame (to: PeerId | string, frame: unknown, via: 'relay' | 'webrtc'): Promise<{ ack: Ack, conn: Connection }> {
    const dest = typeof to === 'string' ? peerIdFromString(to) : to
    if (via === 'webrtc' && !t.webrtc) throw new Error(`WebRTC unavailable: ${t.webrtcError ?? 'disabled'}`)
    const path = via === 'webrtc' ? `/p2p-circuit/webrtc/p2p/${dest.toString()}` : `/p2p-circuit/p2p/${dest.toString()}`
    const conn = await node.dial(relayAddr.encapsulate(path))
    const stream = await conn.newStream(MSG_PROTOCOL, { runOnLimitedConnection: true })
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME })
    try {
      await lp.write(new TextEncoder().encode(JSON.stringify(frame)))
      const ack = JSON.parse(new TextDecoder().decode((await lp.read()).subarray())) as Ack
      await stream.close()
      return { ack, conn }
    } catch (e) {
      stream.abort(e as Error)
      throw e
    }
  }

  return {
    node,
    id: self,
    relayId,
    webrtc: t.webrtc,
    webrtcError: t.webrtcError,
    inbox,
    circuitAddr,
    send: async (to, text, via = 'relay') => {
      // A6 outbound screen before signing: p2p text never passes the hub, so
      // the credential screen must run here too (Clouds' point 3 on #8).
      screenOutbound(text)
      const dest = typeof to === 'string' ? peerIdFromString(to) : to
      return await sendFrame(dest, await signMessage(privateKey, self, dest, text), via)
    },
    sendRaw: async (to, frame, via = 'relay') => await sendFrame(to, frame, via),
    register: async (ns, ttl) => await rendezvousRegister(node, privateKey, relayId, ns, ttl),
    discover: async (ns) => (await rendezvousDiscover(node, relayId, ns)).peers.filter(p => !p.id.equals(self)),
    stop: async () => {
      await node.stop()
      dedup.close()
    }
  }
}

/** Resolve once the node advertises a circuit address through `relayId`. */
async function waitForReservation (node: Libp2p, relayId: PeerId, timeoutMs: number): Promise<void> {
  const has = (): boolean => node.getMultiaddrs().some(a => {
    const s = a.toString()
    return s.includes(`/p2p/${relayId.toString()}/p2p-circuit`)
  })
  if (has()) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('no relay reservation within timeout')) }, timeoutMs)
    const onUpdate = (): void => { if (has()) { cleanup(); resolve() } }
    const cleanup = (): void => { clearTimeout(timer); node.removeEventListener('self:peer:update', onUpdate) }
    node.addEventListener('self:peer:update', onUpdate)
  })
}
