import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GEMMA_PROFILE } from './gemma.ts'
import { GGUF_PROFILE } from './gguf.ts'
import { makeProfile } from './profile.ts'

test('GGUF_PROFILE validates and namespace differs from GEMMA_PROFILE', () => {
  assert.notEqual(GGUF_PROFILE.id, GEMMA_PROFILE.id)
  assert.match(GGUF_PROFILE.id, /^[0-9a-f]{64}$/)
  assert.equal(GGUF_PROFILE.prompt, 'task: clustering | query: ')
  assert.deepEqual(GGUF_PROFILE.dims, [768, 512, 256, 128])
  assert.equal(GGUF_PROFILE.maxTokens, 2048)
  assert.equal(GGUF_PROFILE.encoding, 'float32le')
  assert.equal(GGUF_PROFILE.version, 1)
  assert.equal(GGUF_PROFILE.revision, '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135')
})

test('GGUF_PROFILE is frozen', () => {
  assert.equal(Object.isFrozen(GGUF_PROFILE), true)
})
