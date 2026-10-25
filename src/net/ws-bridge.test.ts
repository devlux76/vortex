// Docs: docs/browser-extension-design.md — Service side: a WebSocket door onto the existing listener.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect } from 'node:net'
import { noise, pureJsCrypto } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webSockets } from '@libp2p/websockets'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { createLibp2p } from 'libp2p'
import { createNodeTransport } from './node.ts'
import { startWsBridge } from './ws-bridge.ts'

const DIRECT = '/vortex/direct/1.0.0'
const text = (s: string): Uint8Array => new TextEncoder().encode(s)

function once<T> (ms = 10_000): { got: Promise<T>, put: (value: T) => void } {
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

async function collectDirect (stream: any): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = chunk.subarray()
    size += bytes.byteLength
    chunks.push(bytes)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
  return out
}

/** Send a minimal WebSocket upgrade over raw TCP and return the status code. */
function probeUpgrade (port: number, headers: Record<string, string> = {}, upgrade = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const lines = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
      ]
      if (upgrade) {
        lines.push(
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
        )
      }
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
      lines.push('', '')
      sock.write(lines.join('\r\n'))
    })
    let data = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('probe timed out')) }, 5000)
    timer.unref()
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8')
      const match = data.match(/^HTTP\/\d\.\d (\d{3})/)
      if (match) {
        clearTimeout(timer)
        sock.destroy()
        resolve(Number(match[1]))
      }
    })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

test('direct messages travel both ways through the bridge', async () => {
  const service = await createNodeTransport()
  const info = await service.start()
  const bridge = await startWsBridge({ port: 0, tcpPort: tcpPortOf(info.addrs), origins: [] })
  const browser: any = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise({ crypto: pureJsCrypto })],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
  })
  try {
    const wsAddr = `/ip4/127.0.0.1/tcp/${bridge.port}/ws/p2p/${info.peerId}`
    await browser.dial(multiaddr(wsAddr))

    // (a) browser -> service
    const gotAtService = once<{ from: string, data: Uint8Array }>()
    const off = service.onDirect(e => { gotAtService.put(e) })
    const outStream: any = await browser.dialProtocol(peerIdFromString(info.peerId), DIRECT)
    const payload = text('hello through ws bridge')
    if (!outStream.send(payload)) await outStream.onDrain()
    await outStream.close()
    const atService = await gotAtService.got
    off()
    assert.equal(atService.from, browser.peerId.toString())
    assert.deepEqual(atService.data, payload)

    // (b) service -> browser over the same connection
    const gotAtBrowser = once<Uint8Array>()
    await browser.handle(DIRECT, async (stream: any) => { gotAtBrowser.put(await collectDirect(stream)) })
    const reply = text('reply through ws bridge')
    await service.send(browser.peerId.toString(), reply)
    assert.deepEqual(await gotAtBrowser.got, reply)
  } finally {
    await browser.stop()
    await bridge.stop()
    await service.stop()
  }
})

test('origin allow-list is enforced', async () => {
  const service = await createNodeTransport()
  const info = await service.start()
  try {
    // Empty origins: a browser origin is refused, no-Origin upgrade succeeds.
    const closed = await startWsBridge({ port: 0, tcpPort: tcpPortOf(info.addrs), origins: [] })
    try {
      assert.equal(await probeUpgrade(closed.port, { Origin: 'https://example.com' }), 403)
      assert.equal(await probeUpgrade(closed.port), 101)
      // Non-upgrade requests get 426.
      assert.equal(await probeUpgrade(closed.port, {}, false), 426)
    } finally {
      await closed.stop()
    }
    // Listed origin is accepted (101 handshake).
    const open = await startWsBridge({ port: 0, tcpPort: tcpPortOf(info.addrs), origins: ['https://example.com'] })
    try {
      assert.equal(await probeUpgrade(open.port, { Origin: 'https://example.com' }), 101)
    } finally {
      await open.stop()
    }
  } finally {
    await service.stop()
  }
})

test('after stop() a new connection is refused', async () => {
  const service = await createNodeTransport()
  const info = await service.start()
  try {
    const bridge = await startWsBridge({ port: 0, tcpPort: tcpPortOf(info.addrs), origins: [] })
    const port = bridge.port
    await bridge.stop()
    await assert.rejects(probeUpgrade(port), /ECONNREFUSED|probe timed out|connect/)
  } finally {
    await service.stop()
  }
})
