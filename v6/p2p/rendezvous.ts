// Minimal libp2p rendezvous (libp2p/specs rendezvous, protocol /rendezvous/1.0.0).
//
// No maintained js-libp2p implementation exists for libp2p 3.x (the old
// @libp2p/rendezvous is gone from npm; @canvas-js/libp2p-rendezvous targets
// @libp2p/interface 2.x). This is REGISTER / UNREGISTER / DISCOVER with signed
// peer records, in memory, enough for a handful of VORTEX peers.
//
// Every registration carries a signed peer record (RecordEnvelope, domain
// "libp2p-peer-record"). The server accepts it only when the record's signer
// is the peer Noise authenticated on the connection, and the client checks the
// signature again on DISCOVER, so a rendezvous point cannot forge addresses.
import { peerIdFromPublicKey } from '@libp2p/peer-id'
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record'
import { lpStream } from '@libp2p/utils'
import type { Connection, Libp2p, PeerId, PrivateKey, Stream } from '@libp2p/interface'
import type { Multiaddr } from '@multiformats/multiaddr'
import { decodeMessage, encodeMessage, MessageType, Status, type Message, type Register } from './rendezvous-pb.ts'

export const RV_PROTOCOL = '/rendezvous/1.0.0'
export const DEFAULT_TTL = 2 * 60 * 60
export const MIN_TTL = 120
export const MAX_TTL = 72 * 60 * 60
export const MAX_NS = 255
export const MAX_DISCOVER = 1000
const MAX_FRAME = 64 * 1024

interface Entry { seq: number, record: Uint8Array, expires: number }

export interface RendezvousServer {
  /** Registrations currently held, for tests and status output. */
  size: () => number
  stop: () => Promise<void>
}

export interface RendezvousServerOptions {
  maxRegistrations?: number
  /** Max namespaces one peer may hold at once (Sun's QA on #8: capacity must not be hogged by one peer). */
  maxPerPeer?: number
  /** Admission gate (#24): when set, only peers it accepts may REGISTER. Injected by the relay; the browser peer never imports the checker. */
  admit?: (peer: PeerId | string) => boolean | Promise<boolean>
  now?: () => number
}

/** Serve rendezvous on `node`. Run it on the relay node. */
export async function startRendezvousServer (node: Libp2p, opts: RendezvousServerOptions = {}): Promise<RendezvousServer> {
  const max = opts.maxRegistrations ?? 1000
  const maxPerPeer = opts.maxPerPeer ?? 32
  const admit = opts.admit
  const now = opts.now ?? Date.now
  const byNs = new Map<string, Map<string, Entry>>()
  let seq = 0

  const count = (): number => { let n = 0; for (const m of byNs.values()) n += m.size; return n }
  const countPeer = (p: string): number => { let n = 0; for (const m of byNs.values()) if (m.has(p)) n++; return n }
  const sweep = (): void => {
    const t = now()
    for (const [ns, m] of byNs) {
      for (const [k, e] of m) if (e.expires <= t) m.delete(k)
      if (m.size === 0) byNs.delete(ns)
    }
  }

  async function onRegister (r: Register, remote: PeerId): Promise<Message> {
    const reply = (status: number, statusText?: string, ttl?: number): Message =>
      ({ type: MessageType.REGISTER_RESPONSE, registerResponse: { status, statusText, ttl } })
    // Admission first (#24): an unenrolled or revoked peer gets nothing.
    if (admit !== undefined && !(await admit(remote.toString()))) return reply(Status.E_UNAVAILABLE, 'peer not admitted')
    if (!validNs(r.ns)) return reply(Status.E_INVALID_NAMESPACE, 'invalid namespace')
    const ttl = r.ttl ?? DEFAULT_TTL
    if (ttl < MIN_TTL || ttl > MAX_TTL) return reply(Status.E_INVALID_TTL, 'invalid ttl')
    if (r.signedPeerRecord == null) return reply(Status.E_INVALID_SIGNED_PEER_RECORD, 'missing record')
    try {
      await openRecord(r.signedPeerRecord, remote)
    } catch (e) {
      return reply(Status.E_INVALID_SIGNED_PEER_RECORD, (e as Error).message)
    }
    sweep()
    const key = remote.toString()
    const m = byNs.get(r.ns) ?? new Map<string, Entry>()
    if (!m.has(key)) {
      // A new (peer, ns) pair first passes the per-peer cap, then the table
      // cap, so one authenticated peer cannot fill the table for the others.
      if (countPeer(key) >= maxPerPeer) return reply(Status.E_UNAVAILABLE, 'too many registrations for one peer')
      if (count() >= max) return reply(Status.E_UNAVAILABLE, 'registration table full')
    }
    m.set(remote.toString(), { seq: ++seq, record: r.signedPeerRecord, expires: now() + ttl * 1000 })
    byNs.set(r.ns, m)
    return reply(Status.OK, undefined, ttl)
  }

  function onDiscover (ns: string | undefined, limit: number | undefined, cookie: Uint8Array | undefined): Message {
    const reply = (status: number, statusText?: string): Message =>
      ({ type: MessageType.DISCOVER_RESPONSE, discoverResponse: { registrations: [], status, statusText } })
    if (ns !== undefined && ns !== '' && !validNs(ns)) return reply(Status.E_INVALID_NAMESPACE, 'invalid namespace')
    let after = 0
    if (cookie != null && cookie.length > 0) {
      after = Number(new TextDecoder().decode(cookie))
      if (!Number.isSafeInteger(after) || after < 0) return reply(Status.E_INVALID_COOKIE, 'invalid cookie')
    }
    sweep()
    const cap = Math.min(limit != null && limit > 0 ? limit : MAX_DISCOVER, MAX_DISCOVER)
    const t = now()
    const hits: Array<{ ns: string, e: Entry }> = []
    for (const [n, m] of byNs) {
      if (ns !== undefined && ns !== '' && n !== ns) continue
      for (const e of m.values()) if (e.seq > after) hits.push({ ns: n, e })
    }
    hits.sort((a, b) => a.e.seq - b.e.seq)
    const page = hits.slice(0, cap)
    const last = page.length > 0 ? page[page.length - 1]!.e.seq : after
    return {
      type: MessageType.DISCOVER_RESPONSE,
      discoverResponse: {
        status: Status.OK,
        cookie: new TextEncoder().encode(String(last)),
        registrations: page.map(({ ns: n, e }) => ({
          ns: n, signedPeerRecord: e.record, ttl: Math.max(0, Math.floor((e.expires - t) / 1000))
        }))
      }
    }
  }

  async function handle (stream: Stream, connection: Connection): Promise<void> {
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME })
    const remote = connection.remotePeer
    try {
      for (;;) {
        let req: Message
        try { req = decodeMessage((await lp.read()).subarray()) } catch { break }
        let res: Message | undefined
        if (req.type === MessageType.REGISTER && req.register) res = await onRegister(req.register, remote)
        else if (req.type === MessageType.DISCOVER) res = onDiscover(req.discover?.ns, req.discover?.limit, req.discover?.cookie)
        else if (req.type === MessageType.UNREGISTER && req.unregister?.ns) {
          byNs.get(req.unregister.ns)?.delete(remote.toString()) // spec: no response
        } else break
        if (res) await lp.write(encodeMessage(res))
      }
      await stream.close()
    } catch {
      stream.abort(new Error('rendezvous stream error'))
    }
  }

  await node.handle(RV_PROTOCOL, handle)
  return {
    size: () => { sweep(); return count() },
    stop: async () => { await node.unhandle(RV_PROTOCOL) }
  }
}

function validNs (ns: string | undefined): ns is string {
  return typeof ns === 'string' && ns.length > 0 && ns.length <= MAX_NS
}

/** Open a signed peer record and check it was signed by `expected` (if given). */
async function openRecord (bytes: Uint8Array, expected?: PeerId): Promise<{ id: PeerId, multiaddrs: Multiaddr[] }> {
  const env = await RecordEnvelope.openAndCertify(bytes, PeerRecord.DOMAIN)
  const signer = peerIdFromPublicKey(env.publicKey)
  const rec = PeerRecord.createFromProtobuf(env.payload)
  if (!rec.peerId.equals(signer)) throw new Error('record peer id differs from its signer')
  if (expected != null && !signer.equals(expected)) throw new Error('record not signed by the registering peer')
  return { id: signer, multiaddrs: rec.multiaddrs }
}

async function request (node: Libp2p, rv: PeerId | Multiaddr, msg: Message, signal?: AbortSignal): Promise<Message> {
  const stream = await node.dialProtocol(rv, RV_PROTOCOL, { signal })
  const lp = lpStream(stream, { maxDataLength: 4 * 1024 * 1024 })
  try {
    await lp.write(encodeMessage(msg), { signal })
    const res = decodeMessage((await lp.read({ signal })).subarray())
    await stream.close()
    return res
  } catch (e) {
    stream.abort(e as Error)
    throw e
  }
}

/** Register this node's current addresses under `ns`. Returns the granted ttl in seconds. */
export async function rendezvousRegister (node: Libp2p, key: PrivateKey, rv: PeerId | Multiaddr, ns: string, ttl = DEFAULT_TTL, signal?: AbortSignal): Promise<number> {
  const rec = new PeerRecord({ peerId: node.peerId, multiaddrs: node.getMultiaddrs(), seqNumber: BigInt(Date.now()) })
  const env = await RecordEnvelope.seal(rec, key)
  const res = await request(node, rv, {
    type: MessageType.REGISTER,
    register: { ns, signedPeerRecord: env.marshal(), ttl }
  }, signal)
  const r = res.registerResponse
  if (r?.status !== Status.OK) throw new Error(`rendezvous register refused: ${r?.status ?? 'no response'} ${r?.statusText ?? ''}`.trim())
  return r.ttl ?? ttl
}

export interface Discovered { id: PeerId, multiaddrs: Multiaddr[] }

/** Discover peers registered under `ns`. Records with bad signatures are dropped. */
export async function rendezvousDiscover (node: Libp2p, rv: PeerId | Multiaddr, ns: string, opts: { limit?: number, cookie?: Uint8Array, signal?: AbortSignal } = {}): Promise<{ peers: Discovered[], cookie?: Uint8Array }> {
  const res = await request(node, rv, {
    type: MessageType.DISCOVER,
    discover: { ns, limit: opts.limit, cookie: opts.cookie }
  }, opts.signal)
  const d = res.discoverResponse
  if (d == null || (d.status ?? Status.OK) !== Status.OK) throw new Error(`rendezvous discover refused: ${d?.status ?? 'no response'} ${d?.statusText ?? ''}`.trim())
  const peers: Discovered[] = []
  for (const r of d.registrations) {
    if (r.signedPeerRecord == null) continue
    try { peers.push(await openRecord(r.signedPeerRecord)) } catch { /* drop forged or corrupt record */ }
  }
  return { peers, cookie: d.cookie }
}

export async function rendezvousUnregister (node: Libp2p, rv: PeerId | Multiaddr, ns: string, signal?: AbortSignal): Promise<void> {
  const stream = await node.dialProtocol(rv, RV_PROTOCOL, { signal })
  const lp = lpStream(stream)
  await lp.write(encodeMessage({ type: MessageType.UNREGISTER, unregister: { ns } }), { signal })
  await stream.close()
}
