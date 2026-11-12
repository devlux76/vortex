import { startRelay } from '../../p2p/relay.ts'
import { startPeer, type Peer } from '../../p2p/node.ts'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { multiaddr } from '@multiformats/multiaddr'

const installed = resolve(import.meta.dir, '../../../node_modules')
const models = process.env.VORTEX_MOON_MODELS
if (!models) throw new Error('Set VORTEX_MOON_MODELS to the prepared model directory')
interface Target {
  addr: string
  peerId: string
  namespaces: Array<{ name: string, topic: string }>
}
const targetPath = process.env.VORTEX_MOON_TARGET
const target = targetPath ? await Bun.file(targetPath).json() as Target : undefined
let webSocketOrigin = 'ws://127.0.0.1:*'
if (target) {
  const parts = multiaddr(target.addr).getComponents()
  const [host, port, transport, peer] = parts
  if (parts.length !== 4 || !['dns', 'dns4', 'dns6'].includes(host.name) || port.name !== 'tcp' || transport.name !== 'wss' || peer.name !== 'p2p') {
    throw new Error('Remote relay address must be /dns4/<host>/tcp/<port>/wss/p2p/<peer-id>')
  }
  webSocketOrigin = new URL(`wss://${host.value}:${port.value}`).origin
}
const runtime = mkdtempSync(join(tmpdir(), 'vortex-moon-run-'))
const bundle = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'browser-peer.ts')], target: 'browser' })
if (!bundle.success) throw new Error(bundle.logs.join('\n'))
const root = import.meta.dir
const relay = target ? undefined : await startRelay()
const addr = target?.addr ?? String(relay?.addrs()[0])
let sun: Peer | undefined
let pending = Promise.resolve()
const sunTranscript: Array<{ from: string, id: string, turn: number, content: string }> = []
const challenges = [
  'First question. In one short sentence, what lets a browser talk to another peer?',
  'Second question. What does a rendezvous service do for peers?',
  'Final question. Why should we sign a message? Answer with one sentence.',
]
const room = 'moon-webrtc'
const decoyRoom = 'moon-gardening'
const refresh = (peer: Peer) => Promise.all([peer.register(room, 120), peer.register(decoyRoom, 120)])
if (relay) sun = await startPeer({ keyFile: resolve(runtime, 'sun.key'), relay: addr, onReject: (reason, conn) => console.error('Sun rejected Moon', reason, conn.id), onMessage: message => {
  pending = pending.then(async () => {
    const { from, text } = message
    const match = /^MOON ([a-f0-9]{12}) (\d) (.*)$/s.exec(text)
    if (!match || Number(match[2]) > 3) return
    const [, id, turn, content] = match
    const row = { from, id, turn: Number(turn), content }
    sunTranscript.push(row)
    console.log(JSON.stringify(row))
    const response = challenges[Number(turn)] ?? 'Smoke test complete. Sun received all four Moon messages.'
    const reply = await sun!.send(from, `SUN ${id} ${turn} ${response}`)
    if (!reply.ack.ok) throw new Error('Moon refused Sun reply')
  }).catch(error => console.error(error))
} })
const fixture = sun
if (fixture) await refresh(fixture)
const renew = fixture && setInterval(() => refresh(fixture).catch(error => console.error(error)), 45_000)
const gemma = resolve(models, 'onnx-community/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0')
const routes = new Map([
  ['/', `${root}/index.html`], ['/moon.js', `${root}/moon.js`],
  ['/transformers.js', `${installed}/@huggingface/transformers/dist/transformers.js`],
])
const roots = [
  ['/ort/', `${installed}/onnxruntime-web/dist`],
  ['/models/onnx-community/embeddinggemma-2-ONNX/', gemma],
  ['/models/onnx-community/SmolLM2-135M-Instruct-ONNX-GQA/', resolve(models, 'onnx-community/SmolLM2-135M-Instruct-ONNX-GQA/4622e1d79184ea906d69dc88fca479db019fa32a')],
]
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
  'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' ${webSocketOrigin}`,
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  if (path === '/browser-peer.js') return new Response(bundle.outputs[0], { headers: { ...headers, 'Content-Type': 'text/javascript' } })
  if (path === '/favicon.ico') return new Response(null, { status: 204, headers })
  if (path === '/run-config') return Response.json(target ? { ...target, speaker: 'Clouds' } : { addr, speaker: 'Sun', peerId: String(sun!.id), namespaces: [
    { name: decoyRoom, topic: 'Growing garden vegetables in soil, watering seedlings, and composting' },
    { name: room, topic: 'A browser peer uses WebRTC or a libp2p relay to discover peers and exchange signed messages' },
  ] }, { headers })
  if (path === '/sun-transcript' && fixture) return Response.json(sunTranscript, { headers })
  let file = routes.get(path)
  if (!file) {
    const route = roots.find(([prefix]) => path.startsWith(prefix))
    if (route) {
      const [prefix, dir] = route
      const rest = path.slice(prefix.length)
      if (/^(?:onnx\/)?[A-Za-z0-9_.-]+$/.test(rest) && !rest.includes('..')) file = `${dir}/${rest}`
    }
  }
  if (!file || !await Bun.file(file).exists()) return new Response('Not found', { status: 404, headers })
  return new Response(Bun.file(file), { headers })
} })
console.log(`MOON_URL=${server.url.href}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  clearInterval(renew)
  server.stop(true)
  await sun?.stop()
  await relay?.stop()
  rmSync(runtime, { recursive: true, force: true })
  process.exit(0)
})
