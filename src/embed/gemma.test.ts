import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Embedder } from '../types.ts'
import { createLazyGemmaEmbedder, GEMMA_PROFILE } from './gemma.ts'

const stub = (vector = Float32Array.from([1, 2, 3])): Embedder => ({
  profile: () => GEMMA_PROFILE,
  embed: async () => vector
})

// Docs: VORTEX_v5.1.md section 2.4
test('profile is available without loading and embed loads once for concurrent calls', async () => {
  let loads = 0
  let release: () => void = () => {}
  const gate = new Promise<Embedder>(resolve => { release = () => resolve(stub()) })
  const lazy = createLazyGemmaEmbedder(() => { loads++; return gate })
  assert.equal(lazy.profile(), GEMMA_PROFILE)
  assert.equal(loads, 0)
  const first = lazy.embed('a')
  const second = lazy.embed('b')
  assert.equal(loads, 1)
  release()
  assert.deepEqual(await first, await second)
  assert.equal(loads, 1)
  await lazy.embed('c')
  assert.equal(loads, 1)
})

// Docs: VORTEX_v5.1.md section 2.4
test('a failed load is forgotten so the next call tries again', async () => {
  let loads = 0
  const lazy = createLazyGemmaEmbedder(() => {
    loads++
    return loads === 1 ? Promise.reject(new Error('no network')) : Promise.resolve(stub())
  })
  await assert.rejects(lazy.embed('a'), /no network/)
  assert.deepEqual(await lazy.embed('a'), Float32Array.from([1, 2, 3]))
  assert.equal(loads, 2)
})

const PRELOAD_STUB = [
  'import { plugin } from "bun";',
  'globalThis.__seen = { configArgs: [], modelArgs: [], tokenizerArgs: [], embedCalls: [] };',
  'globalThis.__mode = "ok";',
  'const vector768 = () => Array.from({ length: 768 }, (_, i) => (i + 1) / 768);',
  'plugin({',
  '  name: "stub-transformers",',
  '  setup(build) {',
  '    build.module("@huggingface/transformers", () => ({',
  '      loader: "object",',
  '      exports: {',
  '        AutoConfig: {',
  '          from_pretrained: async function () {',
  '            globalThis.__seen.configArgs.push(Array.from(arguments));',
  '            return {};',
  '          }',
  '        },',
  '        AutoModel: {',
  '          from_pretrained: async function () {',
  '            globalThis.__seen.modelArgs.push(Array.from(arguments));',
  '            if (globalThis.__mode === "fail") throw new Error("GatherBlockQuantized is not supported on webgpu");',
  '            const data = globalThis.__mode === "short" ? [1, 2] : vector768();',
  '            return async function () { return { sentence_embedding: { data: data } }; };',
  '          }',
  '        },',
  '        AutoTokenizer: {',
  '          from_pretrained: async function () {',
  '            globalThis.__seen.tokenizerArgs.push(Array.from(arguments));',
  '            return async function (texts, options) {',
  '              globalThis.__seen.embedCalls.push({ texts: texts, options: options });',
  '              return { input_ids: { dims: [1, 8] } };',
  '            };',
  '          }',
  '        }',
  '      }',
  '    }));',
  '  }',
  '});'
].join('\n')

const CHILD_DRIVER = [
  'const mod = await import(process.env.VORTEX_REPO_ROOT + "/src/embed/gemma.ts");',
  'const freshSeen = () => ({ configArgs: [], modelArgs: [], tokenizerArgs: [], embedCalls: [] });',
  'const out = {};',
  'globalThis.__seen = freshSeen();',
  'globalThis.__mode = "ok";',
  'const e1 = await mod.createGemmaEmbedder({ device: "webgpu" });',
  'const v1 = await e1.embed("hello");',
  'out.device = { model: globalThis.__seen.modelArgs, config: globalThis.__seen.configArgs,',
  '  tokenizer: globalThis.__seen.tokenizerArgs, calls: globalThis.__seen.embedCalls,',
  '  len: v1.length, prompt: mod.GEMMA_PROFILE.prompt, dims: mod.GEMMA_PROFILE.dims };',
  'globalThis.__seen = freshSeen();',
  'const e2 = await mod.createGemmaEmbedder();',
  'out.native = { model: globalThis.__seen.modelArgs };',
  'globalThis.__mode = "fail";',
  'try { await mod.createGemmaEmbedder({ device: "webnn-gpu" }); out.fail = "no-throw"; }',
  'catch (e) { out.fail = String((e && e.message) || e); }',
  'globalThis.__seen = freshSeen();',
  'globalThis.__mode = "short";',
  'const e3 = await mod.createGemmaEmbedder({ device: "webgpu" });',
  'try { await e3.embed("hi"); out.short = "no-throw"; }',
  'catch (e) { out.short = String((e && e.message) || e); }',
  'console.log("VORTEX-RESULT-BEGIN");',
  'console.log(JSON.stringify(out));'
].join('\n')

interface LoaderCase {
  model: unknown[][]
  config: unknown[][]
  tokenizer: unknown[][]
  calls: Array<{ texts: string[], options: unknown }>
  len: number
  prompt: string
  dims: number[]
}

// Docs: VORTEX_v5.1.md section 2.4. Runs the real gemma.ts in an isolated
// subprocess with the transformers runtime stubbed, so no model downloads and
// no mock leaks into other test files.
test('createGemmaEmbedder forwards an explicit device while keeping pinned rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vortex-gemma-'))
  try {
    writeFileSync(join(dir, 'preload.mjs'), PRELOAD_STUB)
    writeFileSync(join(dir, 'child.ts'), CHILD_DRIVER)
    const stdout = execFileSync(process.execPath, ['--preload', join(dir, 'preload.mjs'), join(dir, 'child.ts')], {
      cwd: process.cwd(),
      env: { ...process.env, VORTEX_REPO_ROOT: process.cwd() },
      timeout: 120000,
      encoding: 'utf8'
    })
    const lines = stdout.split('\n')
    const payload = lines[lines.indexOf('VORTEX-RESULT-BEGIN') + 1]
    const out = JSON.parse(payload) as { device: LoaderCase, native: { model: unknown[][] }, fail: string, short: string }
    const modelOpts = out.device.model[0][1] as Record<string, unknown>
    assert.equal(modelOpts.device, 'webgpu')
    assert.equal(modelOpts.dtype, 'q4')
    assert.match(String(modelOpts.revision), /^[0-9a-f]{40}$/)
    assert.equal((modelOpts.config as { vision_config: unknown }).vision_config, null)
    assert.equal((modelOpts.config as { audio_config: unknown }).audio_config, null)
    assert.deepEqual(out.device.config, [['onnx-community/embeddinggemma-2-ONNX', { revision: modelOpts.revision }]])
    assert.deepEqual(out.device.tokenizer, [['onnx-community/embeddinggemma-2-ONNX', { revision: modelOpts.revision }]])
    assert.equal(out.device.len, 768)
    assert.deepEqual(out.device.dims, GEMMA_PROFILE.dims)
    assert.equal(out.device.prompt, GEMMA_PROFILE.prompt)
    assert.deepEqual(out.device.calls, [{ texts: [GEMMA_PROFILE.prompt + 'hello'], options: { truncation: true, max_length: 8192 } }])
    const nativeOpts = out.native.model[0][1] as Record<string, unknown>
    assert.equal('device' in nativeOpts, false)
    assert.equal(nativeOpts.dtype, 'q4')
    assert.equal(nativeOpts.revision, modelOpts.revision)
    assert.match(out.fail, /GatherBlockQuantized/)
    assert.match(out.short, /profile says 768/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
