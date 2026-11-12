// Milestone 1, localhost only: relay + rendezvous on one node, two peers that
// reach each other only through the relayed circuit, one signed message each way.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { PeerRecord, RecordEnvelope } from '@libp2p/peer-record'
import { lpStream } from '@libp2p/utils'
import { multiaddr } from '@multiformats/multiaddr'
import { rmSync } from 'node:fs'
import { loadOrCreateKey } from './identity.ts'
import { signMessage, verifyMessage } from './message.ts'
import { isRelayed, startPeer, type Peer } from './node.ts'
import { startRelay, type Relay } from './relay.ts'
import { RV_PROTOCOL } from './rendezvous.ts'
import { decodeMessage, encodeMessage, MessageType, Status } from './rendezvous-pb.ts'
import { loadIceConfig, loadWebRTC } from './transports.ts'

const NS = 'vortex'
const dir = mkdtempSync(join(tmpdir(), 'vx-p2p-'))
let relay: Relay
let a: Peer
let b: Peer
let relayAddr: string

beforeAll(async () => {
  relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] })
  relayAddr = relay.addrs()[0]!.toString()
  ;[a, b] = await Promise.all([
    startPeer({ keyFile: join(dir, 'a.key'), relay: relayAddr }),
    startPeer({ keyFile: join(dir, 'b.key'), relay: relayAddr })
  ])
}, 20_000)

afterAll(async () => {
  await Promise.allSettled([a?.stop(), b?.stop()])
  await relay?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('p2p milestone 1 (relay over WebSockets, localhost)', () => {
  test('relay listens on ws and peers hold circuit addresses only', () => {
    expect(relayAddr).toMatch(/^\/ip4\/127\.0\.0\.1\/tcp\/\d+\/ws\/p2p\//)
    for (const p of [a, b]) {
      const addrs = p.node.getMultiaddrs().map(String)
      expect(addrs.length).toBeGreaterThan(0)
      for (const s of addrs) expect(s).toContain('/p2p-circuit')
    }
  })

  test('rendezvous: each peer registers under the namespace and discovers the other', async () => {
    expect(await a.register(NS)).toBeGreaterThan(0)
    expect(await b.register(NS)).toBeGreaterThan(0)
    expect(relay.rendezvous!.size()).toBe(2)
    const fromA = await a.discover(NS)
    const fromB = await b.discover(NS)
    expect(fromA.map(p => p.id.toString())).toEqual([b.id.toString()])
    expect(fromB.map(p => p.id.toString())).toEqual([a.id.toString()])
    expect(fromA[0]!.multiaddrs.map(String).some(s => s.includes('/p2p-circuit'))).toBe(true)
    expect(await a.discover('other-ns')).toEqual([])
  })

  test('one signed message each way, over the relayed circuit', async () => {
    const [found] = await a.discover(NS)
    const ab = await a.send(found!.id, 'hello from A')
    expect(ab.ack).toEqual({ ok: true })
    expect(isRelayed(ab.conn)).toBe(true)
    expect(b.inbox.at(-1)).toMatchObject({ from: a.id.toString(), to: b.id.toString(), text: 'hello from A' })

    const ba = await b.send(a.id, 'hello from B')
    expect(ba.ack).toEqual({ ok: true })
    expect(isRelayed(ba.conn)).toBe(true)
    expect(a.inbox.at(-1)).toMatchObject({ from: b.id.toString(), to: a.id.toString(), text: 'hello from B' })

    // Every connection between the two peers is relayed; none is direct.
    for (const c of a.node.getConnections(b.id)) expect(isRelayed(c)).toBe(true)
    for (const c of b.node.getConnections(a.id)) expect(isRelayed(c)).toBe(true)
  })

  test('direct dialing of a peer is refused by the connection gater', async () => {
    const direct = multiaddr(`/ip4/127.0.0.1/tcp/9/ws/p2p/${b.id.toString()}`)
    await expect(a.node.dial(direct)).rejects.toThrow()
  })

  test('tampered text, forged sender and wrong recipient are rejected', async () => {
    const before = b.inbox.length
    const aKey = await loadOrCreateKey(join(dir, 'a.key'))
    const good = await signMessage(aKey, a.id, b.id, 'original')
    const tampered = await a.sendRaw(b.id, { ...good, text: 'altered' })
    expect(tampered.ack).toEqual({ ok: false, error: 'bad signature' })

    const badSig = await a.sendRaw(b.id, { ...good, sig: Buffer.alloc(64).toString('base64') })
    expect(badSig.ack.ok).toBe(false)

    const forged = await a.sendRaw(b.id, { ...good, from: b.id.toString() })
    expect(forged.ack.error).toBe('from does not match the authenticated remote peer')

    const misaddressed = await a.sendRaw(b.id, await signMessage(aKey, a.id, a.id, 'x'))
    expect(misaddressed.ack.error).toBe('message is not addressed to this peer')
    expect(b.inbox.length).toBe(before)
  })

  test('rendezvous refuses a peer record signed by another key', async () => {
    const other = await generateKeyPair('Ed25519')
    const rec = new PeerRecord({ peerId: peerIdFromPrivateKey(other), multiaddrs: [], seqNumber: 1n })
    const env = await RecordEnvelope.seal(rec, other)
    const stream = await a.node.dialProtocol(a.relayId, RV_PROTOCOL)
    const lp = lpStream(stream)
    await lp.write(encodeMessage({ type: MessageType.REGISTER, register: { ns: NS, signedPeerRecord: env.marshal(), ttl: 300 } }))
    const res = decodeMessage((await lp.read()).subarray())
    await stream.close()
    expect(res.registerResponse?.status).toBe(Status.E_INVALID_SIGNED_PEER_RECORD)
  })

  test('key file is 0600 and the peer id survives a restart', async () => {
    const keyFile = join(dir, 'a.key')
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const oldId = a.id.toString()
    await a.stop()
    a = await startPeer({ keyFile, relay: relayAddr })
    expect(a.id.toString()).toBe(oldId)
    // The restarted peer is still reachable through the relay.
    const r = await b.send(a.id, 'after restart')
    expect(r.ack.ok).toBe(true)
    expect(a.inbox.at(-1)?.text).toBe('after restart')
  })
})

describe('p2p units', () => {
  test('rendezvous protobuf round trip', () => {
    const msg = {
      type: MessageType.DISCOVER_RESPONSE,
      discoverResponse: {
        registrations: [{ ns: 'vortex', signedPeerRecord: new Uint8Array([1, 2, 3]), ttl: 7200 }],
        cookie: new TextEncoder().encode('42'),
        status: Status.OK
      }
    }
    expect(decodeMessage(encodeMessage(msg))).toEqual(msg)
    expect(decodeMessage(encodeMessage({ type: MessageType.REGISTER, register: { ns: 'x', ttl: 300 } })))
      .toEqual({ type: MessageType.REGISTER, register: { ns: 'x', ttl: 300 } })
  })

  test('verifyMessage rejects skewed timestamps', async () => {
    const k1 = await generateKeyPair('Ed25519')
    const k2 = await generateKeyPair('Ed25519')
    const p1 = peerIdFromPrivateKey(k1)
    const p2 = peerIdFromPrivateKey(k2)
    const m = await signMessage(k1, p1, p2, 'hi', Date.now() - 10 * 60 * 1000)
    await expect(verifyMessage(m, p1, p2)).rejects.toThrow('skew')
    const ok = await signMessage(k1, p1, p2, 'hi')
    expect((await verifyMessage(ok, p1, p2)).text).toBe('hi')
  })

  test('ICE config from env; credentials pass through, bad urls refused', () => {
    expect(loadIceConfig({})).toEqual({ iceServers: [] })
    const servers = [{ urls: 'stun:stun.example.org:3478' }, { urls: 'turns:turn.example.org:443?transport=tcp', username: 'u', credential: 'c' }]
    expect(loadIceConfig({ VORTEX_P2P_ICE: JSON.stringify(servers) }).iceServers).toEqual(servers)
    expect(() => loadIceConfig({ VORTEX_P2P_ICE: JSON.stringify([{ urls: 'http://x' }]) })).toThrow()
  })
})

// Bonus: WebRTC between two local peers, signaled over the relay.
const rtc = await loadWebRTC()
describe.skipIf(!rtc.ok)('p2p WebRTC upgrade (bonus)', () => {
  test('signed message over a direct WebRTC connection signaled via the relay', async () => {
    const r = await startRelay()
    const addr = r.addrs()[0]!.toString()
    const ice = { iceServers: [] }
    const [c, d] = await Promise.all([
      startPeer({ keyFile: join(dir, 'c.key'), relay: addr, webrtc: true, ice }),
      startPeer({ keyFile: join(dir, 'd.key'), relay: addr, webrtc: true, ice })
    ])
    try {
      expect(c.webrtc).toBe(true)
      const res = await c.send(d.id, 'over webrtc', 'webrtc')
      expect(res.ack).toEqual({ ok: true })
      expect(res.conn.remoteAddr.toString()).toContain('/webrtc')
      expect(isRelayed(res.conn)).toBe(true) // the address records the signaling path
      expect(d.inbox.at(-1)?.text).toBe('over webrtc')
    } finally {
      await Promise.allSettled([c.stop(), d.stop()])
      await r.stop()
    }
  }, 20_000)
})
