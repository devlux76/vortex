// Tests for the H3 calibration CLI (embed-calibrate.ts) on a tiny fixture.
// No model download: the fixture supplies cached vectors for the pinned
// revision, so the tool never reaches the embedder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(new URL('./embed-calibrate.ts', import.meta.url))
const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'

// Two families, four topics, two paraphrases each: eight statements.
const topics = [
  { family: 'webrtc', topic: 'nat', texts: ['peers behind NAT cannot connect', 'NAT blocks direct peer links'] },
  { family: 'webrtc', topic: 'echo', texts: ['audio echo on calls', 'calls echo the speaker back'] },
  { family: 'crdt', topic: 'merge', texts: ['merging concurrent edits', 'concurrent edits must merge'] },
  { family: 'crdt', topic: 'gc', texts: ['garbage collecting tombstones', 'tombstones pile up unbounded'] },
]
const texts = topics.flatMap(t => t.texts)

/** Deterministic 768-dim vectors: one direction per topic plus per-statement noise. */
function fixtureVectors (): number[][] {
  const out: number[][] = []
  topics.forEach((t, ti) => t.texts.forEach((_, si) => {
    const i = out.length
    out.push(Array.from({ length: 768 }, (_, k) => Math.sin((k + 1) * (ti + 1) * 0.37) + 0.4 * Math.cos((k + 1) * (i + 3) * 0.11 + si)))
  }))
  return out
}

async function run (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, TOOL, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

const MODEL = 'onnx-community/embeddinggemma-2-ONNX'
const DEFAULT_PROMPT = 'task: clustering | query: '

/** A cache written by a run with these settings (the full key, so it matches). */
function setup (prompt = DEFAULT_PROMPT) {
  const root = mkdtempSync(join(tmpdir(), 'vx-calibrate-'))
  const statements = join(root, 'statements.json')
  writeFileSync(statements, JSON.stringify({ topics }))
  const vectors = join(root, 'vectors.json')
  writeFileSync(vectors, JSON.stringify({ model: MODEL, revision: REVISION, dtype: 'q4', prompt, dims: 768, texts, vectors: fixtureVectors() }))
  return { root, statements, vectors, out: join(root, 'report.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('default run on the fixture reports uncentered and the default prompt, without embedding', async () => {
  const f = setup()
  try {
    const r = await run(['--statements', f.statements, '--vectors', f.vectors, '--out', f.out])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.stdout.includes('embedded '), 'must use cached vectors, not the embedder')
    const report = JSON.parse(readFileSync(f.out, 'utf8'))
    assert.equal(report.centered, false)
    assert.equal(report.prompt, 'task: clustering | query: ')
    assert.equal(report.statements, 8)
    assert.equal(report.topics, 4)
    assert.equal(report.families, 2)
    assert.deepEqual(Object.keys(report.dims).sort(), ['128', '256', '512', '768'])
  } finally { f.cleanup() }
})

test('--center subtracts the corpus mean and changes the similarities', async () => {
  const f = setup()
  try {
    const plain = join(f.root, 'plain.json')
    const centered = join(f.root, 'centered.json')
    assert.equal((await run(['--statements', f.statements, '--vectors', f.vectors, '--out', plain])).code, 0)
    const c = await run(['--statements', f.statements, '--vectors', f.vectors, '--center', '--out', centered])
    assert.equal(c.code, 0, c.stderr)
    const p = JSON.parse(readFileSync(plain, 'utf8'))
    const q = JSON.parse(readFileSync(centered, 'utf8'))
    assert.equal(q.centered, true)
    // The fixture shares a common component, so centering must move the related-pair similarities.
    assert.notEqual(q.dims['768'].related.median, p.dims['768'].related.median)
    // Held-out folds run in centered mode too.
    assert.equal(q.dims['768'].heldOut.length, 2)
  } finally { f.cleanup() }
})

test('--prompt is recorded in the report when the cache was made with that prompt', async () => {
  const prompt = 'task: sentence similarity | query: '
  const f = setup(prompt)
  try {
    const r = await run(['--statements', f.statements, '--vectors', f.vectors, '--prompt', prompt, '--out', f.out])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(readFileSync(f.out, 'utf8')).prompt, prompt)
  } finally { f.cleanup() }
})

test('a cache made under another prompt is refused, never silently reused', async () => {
  const f = setup(DEFAULT_PROMPT)
  try {
    const r = await run(['--statements', f.statements, '--vectors', f.vectors, '--prompt', 'task: sentence similarity | query: ', '--out', f.out])
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /does not match this run: prompt/)
    assert.equal(readFileSync(f.vectors, 'utf8').includes('"prompt":"' + DEFAULT_PROMPT + '"'), true, 'the cache is left untouched')
  } finally { f.cleanup() }
})

test('a cache with another model, dtype or dims is refused', async () => {
  const f = setup()
  try {
    const cache = JSON.parse(readFileSync(f.vectors, 'utf8'))
    for (const [key, value] of [['dtype', 'fp32'], ['dims', 512], ['model', 'other/model']] as const) {
      writeFileSync(f.vectors, JSON.stringify({ ...cache, [key]: value }))
      const r = await run(['--statements', f.statements, '--vectors', f.vectors, '--out', f.out])
      assert.notEqual(r.code, 0, key)
      assert.match(r.stderr, new RegExp(key))
    }
  } finally { f.cleanup() }
})

test('a cache without the key fields (written before this check) is refused', async () => {
  const f = setup()
  try {
    const cache = JSON.parse(readFileSync(f.vectors, 'utf8'))
    delete cache.prompt
    delete cache.dtype
    delete cache.dims
    writeFileSync(f.vectors, JSON.stringify(cache))
    const r = await run(['--statements', f.statements, '--vectors', f.vectors, '--out', f.out])
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /prompt/)
  } finally { f.cleanup() }
})
