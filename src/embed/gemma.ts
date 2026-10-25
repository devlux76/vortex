import type { Embedder } from '../types.ts'
import { makeProfile } from './profile.ts'

const MODEL = 'onnx-community/embeddinggemma-2-ONNX'
/** Commit of the model repository. A profile names exact files, never a branch (Section 2.4). */
const REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
/** Weight quantization. It changes the vectors slightly, so it is part of the profile. */
const DTYPE = 'q4'
/** Both sides of a match are problem statements, so one symmetric task prompt is used for everything. */
const PROMPT = 'task: clustering | query: '
const DIMS = [768, 512, 256, 128]
const MAX_TOKENS = 8192

/**
 * The reference profile of Section 2.4. Tolerance and thresholds are
 * provisional: nothing has been measured yet (TODO H3), and whether builds
 * that agree to about 0.99 may share a namespace is open (Section 13).
 */
export const GEMMA_PROFILE = makeProfile({
  model: MODEL,
  revision: REVISION,
  weights: DTYPE,
  prompt: PROMPT,
  maxTokens: MAX_TOKENS,
  truncation: 'tail',
  pooling: 'sentence_embedding output of the text encoder',
  normalization: 'as emitted',
  dims: DIMS,
  encoding: 'float32le',
  version: 1,
  tolerance: 0.001,
  thresholds: { 768: 0.8, 512: 0.8, 256: 0.82, 128: 0.85 }
})

/**
 * Execution devices the browser benchmark may request. A subset of the model
 * loader's own device union, so values forward without assertion.
 */
export type GemmaDevice = 'webgpu' | 'wasm' | 'webnn-gpu' | 'webnn-cpu'

/**
 * Options for {@link createGemmaEmbedder}. Everything stays pinned to the
 * reference profile; only the execution provider hint is selectable.
 */
export interface GemmaEmbedderOptions {
  /**
   * Execution device forwarded to the model loader (for example 'webgpu' in
   * browsers). When omitted the runtime default is used, preserving existing
   * native behavior. Unsupported backends fail with the loader's own error;
   * there is no automatic fallback and no global state is changed.
   */
  device?: GemmaDevice
}

/**
 * Semantic embedder backed by EmbeddingGemma 2, run locally as ONNX. Only the
 * text encoder is loaded; the vision and audio encoders are left out. The
 * model is downloaded on first use and cached. The runtime is imported lazily
 * so that nothing here loads unless this embedder is created.
 */
export async function createGemmaEmbedder (options: GemmaEmbedderOptions = {}): Promise<Embedder> {
  const { AutoConfig, AutoModel, AutoTokenizer } = await import('@huggingface/transformers')
  const config = await AutoConfig.from_pretrained(MODEL, { revision: REVISION }) as any
  config.vision_config = config.audio_config = null
  const model = await AutoModel.from_pretrained(MODEL, {
    config,
    dtype: DTYPE,
    revision: REVISION,
    ...(options.device === undefined ? {} : { device: options.device })
  })
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION })
  return {
    profile: () => GEMMA_PROFILE,
    async embed (text) {
      const inputs = await tokenizer([PROMPT + text], { truncation: true, max_length: MAX_TOKENS })
      const { sentence_embedding: embedding } = await model(inputs)
      const vector = Float32Array.from(embedding.data as Float32Array)
      if (vector.length !== DIMS[0]) throw new Error(`model emitted ${vector.length} dimensions, profile says ${DIMS[0]}`)
      return vector
    }
  }
}

/** Default loader: the real model, unless a test forbids loading it. */
function defaultLoad (): Promise<Embedder> {
  const forbid = typeof process !== 'undefined' && (process as { env?: Record<string, string> }).env?.VORTEX_TEST_FORBID_MODEL_LOAD === '1'
  if (forbid) throw new Error('model load forbidden in this test')
  return createGemmaEmbedder()
}

/**
 * The profile at once with the model on first use. Concurrent first calls
 * share one load; a failed load is forgotten so the next call tries again.
 */
export function createLazyGemmaEmbedder (load: () => Promise<Embedder> = defaultLoad): Embedder {
  let loaded: Embedder | undefined
  let pending: Promise<Embedder> | undefined
  const one = (): Promise<Embedder> => {
    if (loaded !== undefined) return Promise.resolve(loaded)
    if (pending === undefined) {
      pending = load().then(
        embedder => { loaded = embedder; pending = undefined; return embedder },
        error => { pending = undefined; throw error }
      )
    }
    return pending
  }
  return {
    profile: () => GEMMA_PROFILE,
    embed: async (text: string): Promise<Float32Array> => (await one()).embed(text)
  }
}
