// Docs: VORTEX_v5.1.md §§2.1, 2.2, 7.1, 10.1 (authenticated transport and validated gossip).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { DirectEvent, GossipEvent } from '../types.ts'
import { createNodeTransport, type NodeTransport } from './node.ts'

const TOPIC = '/vortex/test/announce'
const text = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Resolves with the first value passed to the returned callback, or rejects on timeout. */
function once<T> (ms = 10_000): { got: Promise<T>, put: (value: T) => void } {
  let put!: (value: T) => void
  const got = new Promise<T>((resolve, reject) => {
    put = resolve
    setTimeout(() => { reject(new Error('timed out')) }, ms).unref()
  })
  return { got, put }
}

let a: NodeTransport, b: NodeTransport, c: NodeTransport

before(async () => {
  a = await createNodeTransport()
  b = await createNodeTransport()
  c = await createNodeTransport()
  await Promise.all([a.start(), b.start(), c.start()])
})

after(async () => {
  await Promise.all([a.stop(), b.stop(), c.stop()])
})

test('each service has its own identity and a dialable address', () => {
  assert.notEqual(a.info().peerId, b.info().peerId)
  assert.ok(a.info().addrs[0].endsWith(`/p2p/${a.info().peerId}`))
})

test('a direct message arrives with the authenticated sender', async () => {
  const { got, put } = once<DirectEvent>()
  const off = b.onDirect(put)
  await a.send(b.info().peerId, text('hello b'), b.info().addrs)
  const event = await got
  off()
  assert.equal(event.from, a.info().peerId)
  assert.equal(new TextDecoder().decode(event.data), 'hello b')
})

test('direct messages keep arriving past the per-connection stream limit', { timeout: 60000 }, async () => {
  // Each message is its own stream. libp2p admits 32 inbound streams per
  // protocol on one connection, so a receiver that leaves its side of a
  // finished stream open silently loses the 33rd message onwards.
  const left = await createNodeTransport()
  const right = await createNodeTransport()
  try {
    await Promise.all([left.start(), right.start()])
    const bodies: string[] = []
    const off = right.onDirect(event => { bodies.push(new TextDecoder().decode(event.data)) })
    const count = 80
    for (let i = 0; i < count; i++) await left.send(right.info().peerId, text(`m${i}`), right.info().addrs)
    for (let waited = 0; waited < 5000 && bodies.length < count; waited += 50) await new Promise(resolve => setTimeout(resolve, 50))
    off()
    assert.equal(bodies.length, count)
    assert.deepEqual(bodies.slice().sort(), Array.from({ length: count }, (_, i) => `m${i}`).sort())
  } finally {
    await Promise.all([left.stop(), right.stop()])
  }
})

test('direct messages cross the Noise cipher boundary in both directions', async () => {
  const left = await createNodeTransport()
  const right = await createNodeTransport()
  try {
    await Promise.all([left.start(), right.start()])
    for (const size of [1183, 1184, 1199, 1200, 4096, 64 * 1024]) {
      for (const [from, to] of [[left, right], [right, left]]) {
        const data = new Uint8Array(size).fill(42)
        const { got, put } = once<DirectEvent>()
        const off = to.onDirect(put)
        try {
          await from.send(to.info().peerId, data, to.info().addrs)
          const event = await got
          assert.equal(event.from, from.info().peerId)
          assert.deepEqual(event.data, data)
        } finally {
          off()
        }
      }
    }
  } finally {
    await Promise.all([left.stop(), right.stop()])
  }
})

test('gossip reports the publisher as origin even when relayed by another peer', { timeout: 30000 }, async () => {
  // Line topology a - b - c: c can only hear a through b.
  await a.dial(b.info().addrs[0])
  await c.dial(b.info().addrs[0])
  const atB = once<GossipEvent>(30_000)
  const atC = once<GossipEvent>(30_000)
  const isAnnounce = (event: GossipEvent): boolean => new TextDecoder().decode(event.data) === 'announce'
  let relayed = false
  await a.subscribe(TOPIC, () => 'accept')
  await b.subscribe(TOPIC, event => { if (isAnnounce(event)) atB.put(event); return 'accept' })
  await c.subscribe(TOPIC, event => { if (isAnnounce(event)) atC.put(event); else relayed = true; return 'accept' })

  // b relays only to peers in its mesh for the topic, which forms over the
  // next heartbeats. Probe until one message has made it from a to c.
  for (let attempt = 0; attempt < 200 && !relayed; attempt++) {
    await a.publish(TOPIC, text(`probe ${attempt}`))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(relayed, true, 'no probe was relayed from a to c')
  await a.publish(TOPIC, text('announce'))

  const [eventB, eventC] = await Promise.all([atB.got, atC.got])
  assert.equal(eventB.origin, a.info().peerId)
  assert.equal(eventC.origin, a.info().peerId)
  assert.equal(eventC.relayedBy, b.info().peerId)
  assert.equal(eventC.id, eventB.id)
  assert.equal(new TextDecoder().decode(eventC.data), 'announce')
})

test('a message the validator does not accept is not forwarded', async () => {
  const topic = '/vortex/test/gated'
  let reachedC = false
  await a.subscribe(topic, () => 'accept')
  const atB = once<void>()
  await b.subscribe(topic, () => { atB.put(); return 'reject' })
  await c.subscribe(topic, () => { reachedC = true; return 'accept' })

  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await a.publish(topic, text('spam'))).recipients > 0) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await atB.got
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(reachedC, false)
})

test('signatures verify against the peer identity and fail for another peer', async () => {
  const data = text('signed bytes')
  const signature = await a.sign(data)
  assert.equal(await b.verify(a.info().peerId, data, signature), true)
  assert.equal(await b.verify(c.info().peerId, data, signature), false)
  assert.equal(await b.verify(a.info().peerId, text('other bytes'), signature), false)
})

test('an exported key restores the same identity', async () => {
  const restored = await createNodeTransport({ key: a.exportKey() })
  const info = await restored.start()
  await restored.stop()
  assert.equal(info.peerId, a.info().peerId)
})
