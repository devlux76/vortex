// A9 §10a acceptance tests for #68, written test-first by the reviewer side of
// the #56 pairing (Ronin). They complement content.test.ts (Stars) and cover:
// the round trip at the spec constants, tamper detection at the spec block
// size, a stable content id across two splits, the depth boundary at a second
// fan-out, and streaming (each block is consumed before the next is fetched).
// Tier 2 (the real package file) is content.test.ts's opt-in test, run with
// VORTEX_PACKAGE_FILE; tier 3 is not run here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOCK_SIZE, assemble, blockId, depthFor, split, type ContentIndex, type ContentParams } from './content.ts'

const T = { timeout: 120_000 } as const

/** Deterministic pseudo-random bytes (xorshift32), so a split is reproducible. */
const det = (n: number, seed: number): Uint8Array => {
  const out = new Uint8Array(n)
  let x = (seed | 0) || 0x9e3779b9
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

const streamOf = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({
  async * [Symbol.asyncIterator] () { yield bytes }
})

const splitAll = async (bytes: Uint8Array, p?: ContentParams): Promise<{ blocks: Uint8Array[], index: ContentIndex }> => {
  const { blocks, index } = split(streamOf(bytes), p)
  const all: Uint8Array[] = []
  for await (const b of blocks) all.push(b)
  return { blocks: all, index: await index }
}

/** Every block of a split, keyed by its id: the root, index blocks and data blocks. */
const blockMap = async (blocks: Uint8Array[], index: ContentIndex, p?: ContentParams): Promise<Map<string, Uint8Array>> => {
  const map = new Map<string, Uint8Array>([[index.contentId, index.root]])
  for (const b of index.indexBlocks) map.set(await blockId(b, p), b)
  for (const b of blocks) map.set(await blockId(b, p), b)
  return map
}

const mapGet = (map: Map<string, Uint8Array>) => async (id: string): Promise<Uint8Array> => {
  const block = map.get(id)
  if (block === undefined) throw new Error(`no block ${id}`)
  return block
}

/** assemble into one buffer, checking the root against the content id it was fetched under. */
const assembleAll = async (root: Uint8Array, get: (id: string) => Promise<Uint8Array>, contentId?: string, p?: ContentParams): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  const res = await assemble(root, get, block => { parts.push(block) }, { ...p, contentId })
  const out = new Uint8Array(res.size)
  let off = 0
  for (const part of parts) { out.set(part, off); off += part.length }
  assert.equal(off, res.size, 'the sink received exactly the package size')
  return out
}

test('round trip at the spec constants: empty, 1 byte, 512 KiB, 512 KiB + 1, multi-block', T, async () => {
  for (const size of [0, 1, BLOCK_SIZE, BLOCK_SIZE + 1, 3 * BLOCK_SIZE + 7]) {
    const bytes = det(size, size + 17)
    const { blocks, index } = await splitAll(bytes)
    assert.equal(blocks.length, Math.ceil(size / BLOCK_SIZE), `data blocks for ${size}`)
    assert.equal(index.depth, 1, `depth for ${size}`)
    const map = await blockMap(blocks, index)
    const got = await assembleAll(index.root, mapGet(map), index.contentId)
    assert.deepEqual(got, bytes, `round trip of ${size} bytes`)
  }
})

test('tamper at the spec block size: a flipped byte in a data block, or in the root, is rejected', T, async () => {
  const bytes = det(BLOCK_SIZE + 1, 5) // 2 data blocks, depth 1
  const { blocks, index } = await splitAll(bytes)

  const dataMap = await blockMap(blocks, index)
  const victim = await blockId(blocks[1]!)
  dataMap.get(victim)![123] ^= 0xff
  await assert.rejects(() => assembleAll(index.root, mapGet(dataMap), index.contentId), /does not hash to its id/)

  const cleanMap = await blockMap(blocks, index)
  const flipped = index.root.slice()
  flipped[40] ^= 0xff
  await assert.rejects(() => assembleAll(flipped, mapGet(cleanMap), index.contentId), /does not hash to the content id/)
})

test('a root whose size disagrees with its hash count is rejected at the spec block size', T, async () => {
  const bytes = det(BLOCK_SIZE + 1, 9) // 2 hashes in the root
  const { blocks, index } = await splitAll(bytes)
  const map = await blockMap(blocks, index)
  // Claim one block's size while the root still carries two hashes.
  const lying = index.root.slice()
  new DataView(lying.buffer).setBigUint64(0, BigInt(BLOCK_SIZE), false)
  await assert.rejects(() => assembleAll(lying, mapGet(map)), /hashes beyond its count/)
})

test('a stable content id across two splits at the spec constants, and a changed byte changes it', T, async () => {
  for (const size of [BLOCK_SIZE + 1, 3 * BLOCK_SIZE + 7]) {
    const bytes = det(size, 31)
    const first = await splitAll(bytes)
    const second = await splitAll(bytes)
    assert.equal(first.index.contentId, second.index.contentId, `stable id for ${size} bytes`)
    assert.deepEqual(first.index.dataIds, second.index.dataIds)
    assert.equal(first.index.contentId, await blockId(first.index.root), 'the content id is the root block id')

    const changed = bytes.slice()
    changed[size - 1] ^= 0x01
    assert.notEqual((await splitAll(changed)).index.contentId, first.index.contentId, 'a changed last byte changes the id')
  }
})

test('the depth boundary at fan-out 3 (block size 96, root holds 2 hashes): 1, 2, 3, 6, 7, 9, 19 data blocks give depths 1, 1, 2, 2, 3, 3, 4', T, async () => {
  // A full index block holds 3 hashes (96 bytes); the root holds (96 - 9) / 32 = 2.
  const p: ContentParams = { blockSize: 96, fanout: 3 }
  const cases: Array<[number, number]> = [[1, 1], [2, 1], [3, 2], [6, 2], [7, 3], [9, 3], [19, 4]]
  for (const [blocks, depth] of cases) {
    const size = blocks * 96
    assert.equal(depthFor(size, p), depth, `depth for ${blocks} data blocks`)
    // The minimal depth is the one assemble accepts; a package at that depth round-trips.
    const bytes = det(size, blocks + 3)
    const made = await splitAll(bytes, p)
    assert.equal(made.index.depth, depth, `split depth for ${blocks} data blocks`)
    const map = await blockMap(made.blocks, made.index, p)
    const got = await assembleAll(made.index.root, mapGet(map), made.index.contentId, p)
    assert.deepEqual(got, bytes, `round trip at depth ${depth}`)
  }
})

test('split streams: each block is produced before the next input chunk is read', T, async () => {
  const events: string[] = []
  const chunks = async function * (): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 3; i++) {
      events.push(`in ${i}`)
      yield det(BLOCK_SIZE, i + 1)
    }
  }
  const { blocks, index } = split(chunks())
  for await (const _b of blocks) events.push(`out ${events.filter(e => e.startsWith('out')).length}`)
  await index
  // Each chunk is read, its block emitted, and only then is the next chunk read.
  assert.deepEqual(events, ['in 0', 'out 0', 'in 1', 'out 1', 'in 2', 'out 2'], 'split streams block by block')
})

test('assemble streams: each block reaches the sink before the next block is fetched', T, async () => {
  const bytes = det(3 * BLOCK_SIZE + 7, 77)
  const { blocks, index } = await splitAll(bytes)
  const map = await blockMap(blocks, index)
  const events: string[] = []
  const get = async (id: string): Promise<Uint8Array> => {
    events.push(`get ${id.slice(0, 6)}`)
    return await mapGet(map)(id)
  }
  let delivered = 0
  await assemble(index.root, get, block => {
    delivered++
    events.push(`put ${delivered - 1}`)
    assert.ok(block.length <= BLOCK_SIZE)
  }, { contentId: index.contentId })
  assert.equal(delivered, blocks.length)
  // Every data block is fetched and then delivered before the next fetch.
  const puts = events.map((e, i) => (e.startsWith('put') ? i : -1)).filter(i => i >= 0)
  for (let k = 0; k < puts.length - 1; k++) {
    const nextGet = events.findIndex((e, i) => i > puts[k]! && e.startsWith('get'))
    assert.ok(nextGet === -1 || nextGet > puts[k]!, `block ${k} delivered before block ${k + 1} is fetched`)
  }
  // The root is passed in directly; only the data blocks are fetched, once each.
  assert.equal(events.filter(e => e.startsWith('get')).length, blocks.length)
})
