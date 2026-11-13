import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('Usage: bun v6/tools/moon/fetch-models.ts <model-directory>')

const models = [
  {
    id: 'onnx-community/embeddinggemma-2-ONNX',
    revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
  },
  {
    id: 'onnx-community/LFM3-1.7B-ONNX',
    revision: 'ab9fec4c681a25bec3b48b0b97a62fc2660a2985',
    files: ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
  },
]

for (const model of models) {
  for (const file of model.files) {
    const path = resolve(root, model.id, model.revision, file)
    if ((await stat(path).catch(() => null))?.size) continue
    await mkdir(dirname(path), { recursive: true })
    const source = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`
    const response = await fetch(source, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`${response.status} downloading ${model.id}/${file}`)
    const partial = `${path}.${process.pid}.partial`
    try {
      const bytes = await Bun.write(partial, response)
      if (bytes === 0) throw new Error(`Empty response for ${model.id}/${file}`)
      await rename(partial, path)
      console.log(`${model.id}/${file} (${bytes} bytes)`)
    } finally {
      await rm(partial, { force: true })
    }
  }
}
