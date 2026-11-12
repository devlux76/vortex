import { AutoConfig, AutoModel, AutoTokenizer, env, pipeline } from '/transformers.js'
import { connect, createIdentity } from '/browser-peer.js'

const EMBEDDER = 'onnx-community/embeddinggemma-2-ONNX'
const EMBEDDER_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
const GENERATOR = 'onnx-community/SmolLM2-135M-Instruct-ONNX-GQA'
const GENERATOR_REVISION = '4622e1d79184ea906d69dc88fca479db019fa32a'
const TOPIC = 'Discovering a browser messaging peer through a relay and exchanging signed messages'
const el = id => document.getElementById(id)
const state = window.moon = { checks: [], transcript: [], stage: 'ready' }
const stage = value => { state.stage = value; el('status').textContent = value }
function row(id, text) {
  const item = document.createElement('li')
  item.textContent = text
  el(id).append(item)
}
function check(label, data) {
  state.checks.push({ label, ...data })
  row('checks', label)
}
function transcript(speaker, turn, text) {
  state.transcript.push({ speaker, turn, text })
  row('transcript', `${speaker} · ${text}`)
}
function cosine(a, b) {
  let dot = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2 }
  return dot / Math.sqrt(x * y)
}
async function run() {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = '/models/'
  env.useBrowserCache = false
  env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency)
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  const embedDevice = new URLSearchParams(location.search).get('embed') ?? (adapter ? 'webgpu' : 'wasm')
  const genDevice = new URLSearchParams(location.search).get('gen') ?? embedDevice
  const ortVariant = embedDevice === 'webgpu' || genDevice === 'webgpu' ? 'ort-wasm-simd-threaded.jsep' : 'ort-wasm-simd-threaded'
  env.backends.onnx.wasm.wasmPaths = { mjs: `/ort/${ortVariant}.mjs`, wasm: `/ort/${ortVariant}.wasm` }
  check('Model files served from this machine', { chrome: navigator.userAgent, embedDevice, genDevice, fallbackAdapter: adapter?.info.isFallbackAdapter ?? null })
  stage('Loading EmbeddingGemma')
  const embedStart = performance.now()
  const embedOptions = { revision: EMBEDDER_REVISION, dtype: 'q4', device: embedDevice }
  const modelConfig = await AutoConfig.from_pretrained(EMBEDDER, embedOptions)
  modelConfig.vision_config = modelConfig.audio_config = null
  const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDER, embedOptions)
  const embedder = await AutoModel.from_pretrained(EMBEDDER, { ...embedOptions, config: modelConfig })
  const vector = async text => {
    const tokens = await tokenizer([`task: clustering | query: ${text}`], { truncation: true, max_length: 8192 })
    const { sentence_embedding } = await embedder(tokens)
    const result = Array.from(sentence_embedding.data)
    if (result.length !== 768 || !result.every(Number.isFinite)) throw new Error('Expected 768 finite embedding values')
    return result
  }
  const config = await fetch('/run-config').then(response => response.json())
  el('mode').textContent = config.speaker === 'Sun' ? 'VORTEX browser smoke test · local Sun fixture' : 'VORTEX browser smoke test · Clouds'
  const query = await vector(TOPIC)
  const scores = []
  for (const entry of config.namespaces) scores.push({ name: entry.name, score: cosine(query, await vector(entry.topic)) })
  await embedder.dispose()
  check('EmbeddingGemma ran in Chrome · 768 dimensions', { model: EMBEDDER, revision: EMBEDDER_REVISION, loadAndEmbedMs: Math.round(performance.now() - embedStart), scores })

  stage('Loading SmolLM2')
  const genStart = performance.now()
  const generate = await pipeline('text-generation', GENERATOR, { revision: GENERATOR_REVISION, dtype: 'q4', device: genDevice })
  check('SmolLM2 loaded in Chrome', { model: GENERATOR, revision: GENERATOR_REVISION, loadMs: Math.round(performance.now() - genStart) })
  stage('Discovering rendezvous namespaces')
  const runId = Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')
  state.runId = runId
  const inbox = new Map()
  const identity = await createIdentity()
  const openPeer = () => connect(config.addr, (message, via) => {
    const match = /^(SUN|CLOUDS) ([a-f0-9]{12}) (\d) (.*)$/s.exec(message.text)
    if (message.from === config.peerId && match?.[1] === config.speaker.toUpperCase() && match[2] === runId) {
      const turn = Number(match[3])
      if (inbox.has(turn)) state.duplicate = turn
      inbox.set(turn, { text: match[4], via })
    }
  }, identity)
  let peer = await openPeer()
  state.peerId = peer.id
  try {
    const discovered = await peer.discover()
    const ranked = scores.filter(candidate => discovered.includes(candidate.name)).sort((a, b) => b.score - a.score)
    if (ranked.length < 2 || ranked[0].score - ranked[1].score < 0.1) throw new Error('Embedding scores did not distinguish the rendezvous topics')
    const channel = ranked[0].name
    const peers = await peer.peers(channel)
    if (!peers.includes(config.peerId)) throw new Error(`The signed rendezvous record for ${config.speaker} was missing`)
    check(`Discovered ${channel} and verified ${config.speaker}’s peer record`, { discovered, ranked, peers, relay: config.addr })
    const ttl = await peer.register(channel)
    check('Moon announced its signed peer record', { channel, ttl, peerId: peer.id, addresses: peer.addr })
    const send = async (turn, text) => {
      const result = await peer.send(config.peerId, `MOON ${runId} ${turn} ${text}`)
      transcript('Moon', turn, text)
      state.transcript.at(-1).via = result.via
    }
    await send(0, 'Hello, I’m Moon. I discovered this namespace and I am ready for three questions.')
    for (let turn = 0; turn <= 3; turn++) {
      stage(`Waiting for ${config.speaker} · exchange ${turn + 1} of 4`)
      const deadline = performance.now() + (config.speaker === 'Clouds' ? 300_000 : 20_000)
      let renewAt = performance.now() + ttl * 500
      while (!inbox.has(turn)) {
        const now = performance.now()
        if (now >= deadline) throw new Error(`Timed out waiting for ${config.speaker}’s exchange ${turn + 1}`)
        if (now >= renewAt) renewAt = now + (await peer.register(channel)) * 500
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const reply = inbox.get(turn)
      transcript(config.speaker, turn, reply.text)
      state.transcript.at(-1).via = reply.via
      if (turn === 3) break
      stage(`Generating Moon’s reply · exchange ${turn + 2} of 4`)
      const started = performance.now()
      const [generated] = await generate([
        { role: 'system', content: 'You are Moon, a browser AI. Answer each networking question in one short, accurate sentence.' },
        { role: 'user', content: reply.text },
      ], { max_new_tokens: 24, do_sample: false, return_full_text: false })
      const output = generated.generated_text
      const answer = (typeof output === 'string' ? output : output.findLast(message => message.role === 'assistant')?.content ?? '').trim()
      if (!answer) throw new Error('SmolLM2 returned an empty reply')
      const generationMs = Math.round(performance.now() - started)
      state.pendingAnswer = { turn: turn + 1, answer, generationMs }
      stage(`Reconnecting Moon · exchange ${turn + 2} of 4`)
      await peer.stop()
      peer = await openPeer()
      if (peer.id !== state.peerId) throw new Error('Moon identity changed on reconnect')
      await peer.register(channel)
      state.reconnects = (state.reconnects ?? 0) + 1
      stage(`Sending Moon’s reply · exchange ${turn + 2} of 4`)
      await send(turn + 1, answer)
      state.transcript.at(-1).generationMs = generationMs
      delete state.pendingAnswer
    }
    if (state.duplicate !== undefined || inbox.size !== 4) throw new Error('Peer sent an unexpected or duplicate turn')
    check('Moon reconnected with the same identity', { reconnects: state.reconnects })
    if (config.speaker === 'Sun') {
      const remote = (await fetch('/sun-transcript').then(response => response.json())).filter(item => item.id === runId && item.from === peer.id)
      if (remote.length !== 4 || remote.some((item, i) => item.turn !== i || item.content !== state.transcript[i * 2].text)) throw new Error('Peer transcripts differ')
      check('Four exchanges verified against Sun’s transcript', { receivedBySun: remote.length, receivedByMoon: inbox.size })
      stage('Local smoke test passed')
    } else {
      stage('Four exchanges received · compare with Clouds’ transcript')
    }
  } finally {
    await peer.stop()
    await generate.dispose()
  }
}
el('start').addEventListener('click', () => {
  el('start').disabled = true
  run().catch(error => { state.error = { stage: state.stage, message: String(error) }; console.error(error); stage(`Failed · ${error.message}`) })
})
