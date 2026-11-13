import { AutoConfig, AutoModel, AutoTokenizer, env, pipeline } from '/transformers.js'
import { connect, createIdentity } from '/browser-peer.js'
import { selectChannel, MATCH_FLOOR } from '/match-rule.js'

const EMBEDDER = 'onnx-community/embeddinggemma-2-ONNX'
const EMBEDDER_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
const GENERATOR = 'onnx-community/LFM3-1.7B-ONNX'
const GENERATOR_REVISION = 'ab9fec4c681a25bec3b48b0b97a62fc2660a2985'
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
  const genDevice = new URLSearchParams(location.search).get('gen') ?? (adapter ? 'webgpu' : 'wasm')
  const ortVariant = embedDevice === 'webgpu' || genDevice === 'webgpu' ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded'
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

  stage('Loading LFM3 1.7B')
  const genStart = performance.now()
  const generate = await pipeline('text-generation', GENERATOR, { revision: GENERATOR_REVISION, dtype: 'q4', device: genDevice, use_external_data_format: true })
  const endTokens = ['<|im_end|>', '</think>'].flatMap(token => generate.tokenizer.encode(token, { add_special_tokens: false }))
  check('LFM3 1.7B loaded in Chrome', { model: GENERATOR, revision: GENERATOR_REVISION, loadMs: Math.round(performance.now() - genStart) })
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
    // #9's rule: similarity ranks, it does not decide. Keep candidates above
    // the recall floor (0.82 at 768 dims), then confirm on plain text with
    // the local model. The hard same-domain decoy scores close to the target,
    // so this confirmation is what separates them (the old 0.1-margin rule
    // could not).
    const topics = Object.fromEntries(config.namespaces.map(entry => [entry.name, entry.topic]))
    const candidates = scores.map(score => ({ ...score, topic: topics[score.name] }))
    const stage1 = selectChannel(candidates, discovered)
    const ranked = stage1.ranked
    if (ranked.length === 0) throw new Error('No rendezvous namespace above the 0.82 floor')
    const numbered = ranked.map((candidate, i) => `${i + 1}. ${candidate.topic}`).join('\n')
    const [decision] = await generate([
      { role: 'system', content: 'You match a problem to one candidate topic. Answer with only the number of the best match.' },
      { role: 'user', content: `Problem: ${TOPIC}\nCandidate topics:\n${numbered}\nNumber:` },
    ], { max_new_tokens: 8, eos_token_id: endTokens, do_sample: false, return_full_text: false, tokenizer_encode_kwargs: { enable_thinking: false } })
    const raw = (typeof decision.generated_text === 'string' ? decision.generated_text : decision.generated_text.findLast(message => message.role === 'assistant')?.content ?? '').trim()
    const confirmedPick = Number((raw.match(/\d+/) ?? [])[0])
    const stage2 = selectChannel(candidates, discovered, confirmedPick)
    const channel = stage2.channel
    const peers = await peer.peers(channel)
    if (!peers.includes(config.peerId)) throw new Error(`The signed rendezvous record for ${config.speaker} was missing`)
    check(`Discovered ${channel} and verified ${config.speaker}’s peer record`, { discovered, floor: MATCH_FLOOR, ranked, confirmedPick, peers, relay: config.addr })
    if (config.hardDecoy !== undefined && ranked.some(candidate => candidate.name === config.hardDecoy)) {
      check(config.hardDecoy === channel ? 'WARNING: the same-domain decoy was selected' : `Same-domain decoy ${config.hardDecoy} scored ${scores.find(score => score.name === config.hardDecoy).score.toFixed(3)} and was not selected`, { channel, hardDecoy: config.hardDecoy })
    }
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
      ], { max_new_tokens: 40, eos_token_id: endTokens, do_sample: false, return_full_text: false, tokenizer_encode_kwargs: { enable_thinking: false } })
      const output = generated.generated_text
      const answer = (typeof output === 'string' ? output : output.findLast(message => message.role === 'assistant')?.content ?? '').split('</think>', 1)[0].trim()
      if (!answer) throw new Error('LFM3 1.7B returned an empty reply')
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
