// Docs: docs/browser-extension-design.md — Transport, joining and identity; VORTEX_v5.1.md §10.1.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNodeTransport } from './node.ts'
import { createBrowserTransport, isAllowedDial } from './browser.ts'
import { startWsBridge } from './ws-bridge.ts'

const TOPIC = '/vortex/test/browser'
const text = (s: string): Uint8Array => new TextEncoder().encode(s)

function once<T> (ms = 30_000): { got: Promise<T>, put: (value: T) => void } {
  let put!: (value: T) => void
  const got = new Promise<T>((resolve, reject) => {
    put = resolve
    setTimeout(() => { reject(new Error('timed out')) }, ms).unref()
  })
  return { got, put }
}

function tcpPortOf (addrs: string[]): number {
  const addr = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
  if (!addr) throw new Error('no loopback TCP address')
  return Number(addr.split('/')[4])
}

test('the allow-list predicate matches exactly and nothing else', () => {
  const allow = ['/ip4/127.0.0.1/tcp/47821/ws/p2p/12D3KooWAbc']
  assert.equal(isAllowedDial(allow, { toString: () => allow[0] }), true)
  assert.equal(isAllowedDial(allow, { toString: () => '/ip4/127.0.0.1/tcp/47822/ws/p2p/12D3KooWAbc' }), false)
  assert.equal(isAllowedDial(allow, { toString: () => '/ip4/127.0.0.1/tcp/47821' }), false)
  assert.equal(isAllowedDial(allow, { toString: () => '/ip4/10.0.0.2/tcp/47821/ws/p2p/12D3KooWAbc' }), false)
  assert.equal(isAllowedDial([], { toString: () => allow[0] }), false)
})

test('browser transport talks both ways through the bridge, gets gossip, and refuses non-allow dials', { timeout: 120000 }, async () => {
  const service = await createNodeTransport()
  const info = await service.start()
  const bridge = await startWsBridge({ port: 0, tcpPort: tcpPortOf(info.addrs), origins: [] })
  const wsAddr = `/ip4/127.0.0.1/tcp/${bridge.port}/ws/p2p/${info.peerId}`

  // A second service behind its own bridge, NOT in the browser's allow-list.
  const other = await createNodeTransport()
  const otherInfo = await other.start()
  const otherBridge = await startWsBridge({ port: 0, tcpPort: tcpPortOf(otherInfo.addrs), origins: [] })
  const otherAddr = `/ip4/127.0.0.1/tcp/${otherBridge.port}/ws/p2p/${otherInfo.peerId}`

  const browser = await createBrowserTransport({ allow: [wsAddr] })
  try {
    const browserInfo = await browser.start()
    assert.deepEqual(browserInfo.addrs, [])

    await browser.dial(wsAddr)

    // Browser -> service over the bridge.
    const gotAtService = once<{ from: string, data: Uint8Array }>()
    const off = service.onDirect(e => { gotAtService.put(e) })
    const payload = text('hello from browser transport')
    await browser.send(info.peerId, payload, [wsAddr])
    const atService = await gotAtService.got
    off()
    assert.equal(atService.from, browserInfo.peerId)
    assert.deepEqual(atService.data, payload)

    // Service -> browser, opened back over the same connection.
    const gotAtBrowser = once<{ from: string, data: Uint8Array }>()
    const offBrowser = browser.onDirect(e => { gotAtBrowser.put(e) })
    const reply = text('reply to browser transport')
    await service.send(browserInfo.peerId, reply)
    const atBrowser = await gotAtBrowser.got
    offBrowser()
    assert.equal(atBrowser.from, info.peerId)
    assert.deepEqual(atBrowser.data, reply)

    // Gossip published by the service reaches the browser through the bridge.
    const gotGossip = once<Uint8Array>()
    await browser.subscribe(TOPIC, event => { gotGossip.put(event.data); return 'accept' })
    await service.subscribe(TOPIC, () => 'accept')
    let delivered = false
    for (let attempt = 0; attempt < 200 && !delivered; attempt++) {
      await service.publish(TOPIC, text('gossip for the browser'))
      try {
        await Promise.race([gotGossip.got, new Promise((_, reject) => setTimeout(() => reject(new Error('wait')), 100))])
        delivered = true
      } catch { /* mesh still forming; keep publishing */ }
    }
    assert.equal(delivered, true, 'no gossip arrived through the bridge')
    assert.deepEqual(await gotGossip.got, text('gossip for the browser'))

    // A bridge address outside `allow` is refused.
    await assert.rejects(browser.dial(otherAddr))
  } finally {
    await browser.stop().catch(() => {})
    await bridge.stop()
    await otherBridge.stop()
    await service.stop()
    await other.stop()
  }
})

test('an exported browser key restores the same identity', async () => {
  const a = await createBrowserTransport({ allow: [] })
  const info = await a.start()
  const key = a.exportKey()
  await a.stop()
  const b = await createBrowserTransport({ allow: [], key })
  const restored = await b.start()
  await b.stop()
  assert.equal(restored.peerId, info.peerId)
})
