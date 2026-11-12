// Threshold calibration for semantic matching (v5 TODO H3), using the pinned
// reference embedder of embed-probe.ts on the labelled set in
// calibration/statements.json. Pairs in the same topic are related; pairs in
// the same family but a different topic are hard negatives (shared vocabulary,
// different problem); the rest are easy negatives.
//
//   bun v6/tools/embed-calibrate.ts                         # embed, report
//   bun v6/tools/embed-calibrate.ts --vectors v.json        # reuse/save vectors
//   bun v6/tools/embed-calibrate.ts --out report.json       # also write the report
//
// For each prefix length (Matryoshka truncation, renormalized) it reports the
// similarity distributions, the provisional v5 thresholds' precision/recall,
// the F1-best threshold, and the lowest threshold reaching 99% precision. To
// expose overfitting, thresholds are also chosen on half the families and
// scored on the other half.

const MODEL = 'onnx-community/embeddinggemma-2-ONNX'
const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
const DTYPE = 'q4'
const PROMPT = process.argv.includes('--prompt') ? process.argv[process.argv.indexOf('--prompt') + 1] : 'task: clustering | query: '
const DIMS = [768, 512, 256, 128]
const PROVISIONAL: Record<number, number> = { 768: 0.8, 512: 0.8, 256: 0.82, 128: 0.85 }

interface Item { family: string; topic: string; text: string }
interface Pair { s: number; related: boolean; hard: boolean; famA: string; famB: string }
interface Score { threshold: number; precision: number; recall: number; f1: number; hardFalsePositives: number }

function arg (name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Mean of the given vectors (the centering reference). */
function meanOf (vs: number[][]): number[] {
  const m = new Array(vs[0].length).fill(0)
  for (const v of vs) for (let i = 0; i < v.length; i++) m[i] += v[i] / vs.length
  return m
}

/** Truncate to d dims, renormalize, subtract the (equally truncated, renormalized) reference mean. */
function prep (v: number[], d: number, mean?: number[]): number[] {
  const unit = (x: number[]) => { const n = Math.sqrt(x.reduce((a, b) => a + b * b, 0)); return x.map(y => y / n) }
  const u = unit(v.slice(0, d))
  if (mean === undefined) return u
  const m = unit(mean.slice(0, d))
  return u.map((x, i) => x - m[i])
}

function sim (u: number[], v: number[], d: number): number {
  let dot = 0; let nu = 0; let nv = 0
  for (let i = 0; i < d; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i] }
  return dot / Math.sqrt(nu * nv)
}

function quantile (xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]
}

function score (pairs: Pair[], t: number): Score {
  let tp = 0; let fp = 0; let fn = 0; let hardFp = 0
  for (const p of pairs) {
    const match = p.s >= t
    if (match && p.related) tp++
    else if (match) { fp++; if (p.hard) hardFp++ } else if (p.related) fn++
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  return { threshold: t, precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall), hardFalsePositives: hardFp }
}

function candidates (pairs: Pair[]): number[] {
  return [...new Set(pairs.map(p => Math.round(p.s * 1000) / 1000))].sort((a, b) => a - b)
}

function bestF1 (pairs: Pair[]): Score {
  return candidates(pairs).map(t => score(pairs, t)).reduce((a, b) => (b.f1 > a.f1 ? b : a))
}

function minForPrecision (pairs: Pair[], target: number): Score | undefined {
  return candidates(pairs).map(t => score(pairs, t)).find(s => s.precision >= target)
}

async function embedAll (items: Item[]): Promise<number[][]> {
  const { AutoConfig, AutoModel, AutoTokenizer } = await import('@huggingface/transformers')
  const config = await AutoConfig.from_pretrained(MODEL, { revision: REVISION }) as any
  config.vision_config = config.audio_config = null
  const model = await AutoModel.from_pretrained(MODEL, { config, dtype: DTYPE, revision: REVISION, device: 'cpu' })
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION })
  const out: number[][] = []
  for (const it of items) {
    const inputs = await tokenizer([PROMPT + it.text], { truncation: true, max_length: 8192 })
    const { sentence_embedding: e } = await model(inputs)
    out.push(Array.from(e.data as Float32Array))
  }
  return out
}

const fmt = (x: number) => x.toFixed(3)

async function main (): Promise<void> {
  const data = await Bun.file(new URL('./calibration/statements.json', import.meta.url)).json() as { topics: Array<{ family: string; topic: string; texts: string[] }> }
  const items: Item[] = data.topics.flatMap(t => t.texts.map(text => ({ family: t.family, topic: t.topic, text })))
  const vecPath = arg('--vectors')
  let vectors: number[][] | undefined
  if (vecPath !== undefined && await Bun.file(vecPath).exists()) {
    const saved = await Bun.file(vecPath).json() as { model: string; revision: string; texts: string[]; vectors: number[][] }
    if (saved.revision === REVISION && saved.texts.length === items.length && saved.texts.every((t, i) => t === items[i].text)) vectors = saved.vectors
  }
  if (vectors === undefined) {
    const t0 = performance.now()
    vectors = await embedAll(items)
    console.log(`embedded ${items.length} statements in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    if (vecPath !== undefined) await Bun.write(vecPath, JSON.stringify({ model: MODEL, revision: REVISION, texts: items.map(i => i.text), vectors }) + '\n')
  }
  const families = [...new Set(items.map(i => i.family))]
  // --center: subtract a mean vector. For the full-set numbers the mean is the
  // whole corpus; for the held-out folds it is computed from the training fold
  // only, so the held-out score has no leakage.
  const center = process.argv.includes('--center')
  const report: Record<string, unknown> = { model: MODEL, revision: REVISION, prompt: PROMPT, centered: center, statements: items.length, topics: data.topics.length, families: families.length, dims: {} }

  const fold = (f: string) => families.indexOf(f) % 2
  const pairsFor = (d: number, mean?: number[]): Pair[] => {
    const pv = vectors!.map(v => prep(v, d, mean))
    const pairs: Pair[] = []
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]; const b = items[j]
        const related = a.topic === b.topic
        pairs.push({ s: sim(pv[i], pv[j], d), related, hard: !related && a.family === b.family, famA: a.family, famB: b.family })
      }
    }
    return pairs
  }
  for (const d of DIMS) {
    const pairs = pairsFor(d, center ? meanOf(vectors) : undefined)
    const pos = pairs.filter(p => p.related).map(p => p.s)
    const hard = pairs.filter(p => p.hard).map(p => p.s)
    const easy = pairs.filter(p => !p.related && !p.hard).map(p => p.s)
    const prov = score(pairs, PROVISIONAL[d])
    const f1 = bestF1(pairs)
    const p99 = minForPrecision(pairs, 0.99)
    // Two-fold by family: choose on one half, evaluate on the other.
    // A pair belongs to a fold only when both statements' families do.
    const inFold = (p: Pair, side: number) => fold(p.famA) === side && fold(p.famB) === side
    const held = [0, 1].map(k => {
      const ps = center ? pairsFor(d, meanOf(vectors!.filter((_, i) => fold(items[i].family) === k))) : pairs
      return score(ps.filter(p => inFold(p, 1 - k)), bestF1(ps.filter(p => inFold(p, k))).threshold)
    })
    console.log(`\ndims ${d}`)
    console.log(`  related   n=${pos.length}  min=${fmt(Math.min(...pos))} p05=${fmt(quantile(pos, 0.05))} median=${fmt(quantile(pos, 0.5))}`)
    console.log(`  hard neg  n=${hard.length}  median=${fmt(quantile(hard, 0.5))} p95=${fmt(quantile(hard, 0.95))} p99=${fmt(quantile(hard, 0.99))} max=${fmt(Math.max(...hard))}`)
    console.log(`  easy neg  n=${easy.length}  median=${fmt(quantile(easy, 0.5))} p99=${fmt(quantile(easy, 0.99))} max=${fmt(Math.max(...easy))}`)
    console.log(`  provisional ${PROVISIONAL[d]}: precision=${fmt(prov.precision)} recall=${fmt(prov.recall)} f1=${fmt(prov.f1)} hardFP=${prov.hardFalsePositives}`)
    console.log(`  best F1   ${fmt(f1.threshold)}: precision=${fmt(f1.precision)} recall=${fmt(f1.recall)} f1=${fmt(f1.f1)} hardFP=${f1.hardFalsePositives}`)
    console.log(p99 === undefined ? '  99% precision: unreachable' : `  99% prec  ${fmt(p99.threshold)}: precision=${fmt(p99.precision)} recall=${fmt(p99.recall)} hardFP=${p99.hardFalsePositives}`)
    console.log(`  held-out F1 (2-fold by family): ${held.map(h => `${fmt(h.f1)}@${fmt(h.threshold)}`).join(', ')}`)
    ;(report.dims as Record<number, unknown>)[d] = {
      related: { n: pos.length, min: Math.min(...pos), p05: quantile(pos, 0.05), median: quantile(pos, 0.5) },
      hardNegative: { n: hard.length, median: quantile(hard, 0.5), p95: quantile(hard, 0.95), p99: quantile(hard, 0.99), max: Math.max(...hard) },
      easyNegative: { n: easy.length, median: quantile(easy, 0.5), p99: quantile(easy, 0.99), max: Math.max(...easy) },
      provisional: prov, bestF1: f1, precision99: p99 ?? null, heldOut: held,
    }
  }
  const out = arg('--out')
  if (out !== undefined) { await Bun.write(out, JSON.stringify(report, null, 2) + '\n'); console.log(`\nwrote ${out}`) }
}

main().catch(e => { console.error(`calibration failed: ${e?.stack ?? e}`); process.exit(2) })
