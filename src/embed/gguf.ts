import type { Embedder } from '../types.ts'
import { makeProfile } from './profile.ts'

/** SHA-256 of the embeddinggemma-2-Q8_0.gguf file the shared embedder pool loads. */
const REVISION = '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135'
const MODEL = 'embeddinggemma-2-Q8_0.gguf'
const WEIGHTS = 'Q8_0'
const PROMPT = 'task: clustering | query: '
const DIMS = [768, 512, 256, 128]
const MAX_TOKENS = 2048

/**
 * The profile of the shared llama.cpp embedder (llama-server /v1/embeddings
 * running embeddinggemma-2-Q8_0.gguf). Another model build, so another
 * namespace than GEMMA_PROFILE. Tolerance and thresholds are provisional,
 * copied from GEMMA_PROFILE until measured (TODO H3).
 */
export const GGUF_PROFILE = makeProfile({
  model: MODEL,
  revision: REVISION,
  weights: WEIGHTS,
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

/** What the embedder needs from a backbone connection (src/backbone.ts). */
export interface BackboneEmbedding { embed (text: string): Promise<Float32Array> }

/**
 * An Embedder that asks the wake router to embed through the machine's
 * shared llama.cpp pool, instead of loading a model in this process. The
 * profile's prompt is applied here, once.
 */
export function createBackboneEmbedder (backbone: BackboneEmbedding): Embedder {
  return {
    profile: () => GGUF_PROFILE,
    async embed (text: string): Promise<Float32Array> {
      const vector = await backbone.embed(PROMPT + text)
      if (!(vector instanceof Float32Array) || vector.length !== DIMS[0]) throw new Error(`backbone vector is not ${DIMS[0]} dimensions`)
      return vector
    }
  }
}
