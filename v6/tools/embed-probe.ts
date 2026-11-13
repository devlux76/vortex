// Embedding probe for the semantic-discovery layer (v5.1 §2.4 reference profile).
// Answers three questions for any machine, including a cloud container:
//   1. Can it fetch and run the pinned EmbeddingGemma 2 ONNX q4 model on CPU?
//   2. How fast is load and embedding?
//   3. Do its vectors agree with another machine's (profile tolerance 0.001)?
//
//   bun v6/tools/embed-probe.ts                       # run, print report
//   bun v6/tools/embed-probe.ts --write ref.json       # also save vectors
//   bun v6/tools/embed-probe.ts --compare ref.json    # agreement vs saved vectors
//   bun v6/tools/embed-probe.ts --gguf http://127.0.0.1:8091/v1/embeddings
//                                                     # agreement vs a llama.cpp server
// Exit code 0 = model ran (and, with --compare, agreed within tolerance).

import { cpus } from 'node:os'

const MODEL = 'onnx-community/embeddinggemma-2-ONNX'
const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
const DTYPE = 'q4'
const PROMPT = 'task: clustering | query: '
const DIMS = [768, 512, 256, 128]
const THRESHOLDS: Record<number, number> = { 768: 0.8, 512: 0.8, 256: 0.82, 128: 0.85 }
const TOLERANCE = 0.001 // 1 - cosine between two builds of the same profile

// Three related pairs (a/b) on unrelated subjects.
const TEXTS: Array<[string, string]> = [
  ['webrtc-a', 'Two libp2p nodes behind NAT cannot connect over WebRTC; signaling through a circuit relay works but the direct connection never upgrades.'],
  ['webrtc-b', 'Peer-to-peer WebRTC connection between agents fails to hole punch; only the relayed path through the relay node carries traffic.'],
  ['webgpu-a', 'Investigating intermittent WebGPU compute shader failures in a browser-based terrain simulation. Suspect synchronization or resource lifetime problems.'],
  ['webgpu-b', 'Compute pass in WebGPU sometimes reads stale buffer contents; looks like a missing barrier or a buffer destroyed while still in use.'],
  ['elixir-a', 'Elixir GenServer call times out under load because a slow HTTP request blocks the server process mailbox.'],
  ['elixir-b', 'BEAM process becomes a bottleneck: synchronous calls to one GenServer queue up behind a blocking external request.']
]

function arg (name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function similarity (u: ArrayLike<number>, v: ArrayLike<number>, length: number): number {
  let dot = 0; let nu = 0; let nv = 0
  for (let i = 0; i < length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i] }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(nu * nv)))
}

function agreement (label: string, mine: number[][], theirs: number[][]): boolean {
  let worst = 0
  for (let i = 0; i < mine.length; i++) {
    const gap = 1 - similarity(mine[i], theirs[i], DIMS[0])
    worst = Math.max(worst, gap)
    console.log(`  ${TEXTS[i][0].padEnd(9)} 1-cos=${gap.toExponential(2)}`)
  }
  const ok = worst <= TOLERANCE
  console.log(`${label}: worst 1-cos=${worst.toExponential(2)} (tolerance ${TOLERANCE}) -> ${ok ? 'AGREE' : 'DISAGREE'}`)
  return ok
}

async function main (): Promise<number> {
  console.log(`env: bun ${Bun.version} ${process.platform}/${process.arch} cpus=${cpus().length} (${cpus()[0]?.model ?? '?'})`)
  const t0 = performance.now()
  const { AutoConfig, AutoModel, AutoTokenizer } = await import('@huggingface/transformers')
  const config = await AutoConfig.from_pretrained(MODEL, { revision: REVISION }) as any
  config.vision_config = config.audio_config = null
  const model = await AutoModel.from_pretrained(MODEL, { config, dtype: DTYPE, revision: REVISION, device: 'cpu' })
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION })
  console.log(`load: ${((performance.now() - t0) / 1000).toFixed(1)}s (${MODEL}@${REVISION.slice(0, 8)} ${DTYPE}, cpu)`)

  const vectors: number[][] = []
  for (const [id, text] of TEXTS) {
    const t = performance.now()
    const inputs = await tokenizer([PROMPT + text], { truncation: true, max_length: 8192 })
    const { sentence_embedding: e } = await model(inputs)
    const v = Array.from(e.data as Float32Array)
    if (v.length !== DIMS[0]) throw new Error(`${id}: ${v.length} dims, expected ${DIMS[0]}`)
    vectors.push(v)
    console.log(`embed ${id.padEnd(9)} ${(performance.now() - t).toFixed(0)}ms`)
  }

  // Related pairs should clear the threshold at every length; cross-subject pairs should not.
  let separated = true
  for (const d of DIMS) {
    const row: string[] = []
    for (let i = 0; i < TEXTS.length; i++) {
      for (let j = i + 1; j < TEXTS.length; j++) {
        const s = similarity(vectors[i], vectors[j], d)
        const related = TEXTS[i][0].split('-')[0] === TEXTS[j][0].split('-')[0]
        const match = s >= THRESHOLDS[d]
        if (related !== match) separated = false
        if (related || match) row.push(`${TEXTS[i][0]}~${TEXTS[j][0]}=${s.toFixed(3)}${match ? '' : '(miss)'}`)
      }
    }
    const crossMax = Math.max(...TEXTS.flatMap((a, i) => TEXTS.slice(i + 1).map((b, k) =>
      a[0].split('-')[0] === b[0].split('-')[0] ? -1 : similarity(vectors[i], vectors[i + 1 + k], d))))
    console.log(`dims ${String(d).padStart(3)} thr ${THRESHOLDS[d]}: ${row.join('  ')}  | max unrelated=${crossMax.toFixed(3)}`)
  }
  console.log(`separation at provisional thresholds: ${separated ? 'CLEAN' : 'IMPERFECT (thresholds need tuning, TODO H3)'}`)

  let ok = true
  const out = arg('--write')
  if (out !== undefined) {
    const round = (v: number[]): number[] => v.map(x => Math.round(x * 1e6) / 1e6)
    await Bun.write(out, JSON.stringify({ model: MODEL, revision: REVISION, dtype: DTYPE, prompt: PROMPT, ids: TEXTS.map(t => t[0]), vectors: vectors.map(round) }) + '\n')
    console.log(`wrote ${out}`)
  }
  const cmp = arg('--compare')
  if (cmp !== undefined) {
    const ref = await Bun.file(cmp).json() as { vectors: number[][] }
    ok = agreement(`vs ${cmp}`, vectors, ref.vectors) && ok
  }
  const gguf = arg('--gguf')
  if (gguf !== undefined) {
    const res = await fetch(gguf, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: TEXTS.map(t => PROMPT + t[1]) }) })
    const body = await res.json() as { data: Array<{ embedding: number[] }> }
    agreement(`vs llama.cpp ${gguf} (informational)`, vectors, body.data.map(d => d.embedding))
  }
  return ok ? 0 : 1
}

main().then(code => process.exit(code), error => { console.error(`probe failed: ${error?.stack ?? error}`); process.exit(2) })
