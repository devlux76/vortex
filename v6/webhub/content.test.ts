// A9 §10a content addressing — tests for #68 (the code half; the acceptance
// half is Ronin's per the pairing rule on #56). The vectors in
// vectors/content.json pin the spec-constant behavior (the content id format
// freezes when #68 merges, §15 item 8, so they are reviewed specifically).
// Block size and fan-out are internal parameters with the spec constants as
// defaults, so the depth-1/depth-2 boundary is tested at tiny sizes where a
// full package fits in memory; the spec-scale tree is verified structurally.
// The opt-in real-file test at the bottom runs only when VORTEX_PACKAGE_FILE
// names a file; no fixture is committed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BLOCK_SIZE, FANOUT, assemble, blockId, buildIndex, depthFor, levelCounts, parseRoot, sha256, split, type ContentIndex, type ContentParams } from './content.ts'
import { b64url } from '../client/b64.ts'

const vectors = JSON.parse(readFileSync(new URL('./vectors/content.json', import.meta.url), 'utf8')) as {
  block_size: number
  fanout: number
  vectors: Array<{ name: string, size: number, depth: number, content_id: string, block_ids: string[] | null, input: { kind: string, bytes?: string, pattern?: string, tail?: string, hash?: string, count?: number } }>
}

const T = { timeout: 60_000 } as const

// Tiny parameters for behavior tests: blockSize 64 -> the root holds at most
// 1 hash, fan-out 2 -> a full index block carries 2 hashes. Depth 1 is one
// data block, depth 2 starts at two, depth 3 at three.
const small: ContentParams = { blockSize: 64, fanout: 2 }

const pattern = (n: number, extra = 0): Uint8Array => {
  const bytes = new Uint8Array(n + extra)
  for (let i = 0; i < n; i++) bytes[i] = i & 0xff
  if (extra) bytes[n] = 0x41
  return bytes
}
const streamOf = (bytes: Uint8Array): AsyncIterable<Uint8Array> => ({ async * [Symbol.asyncIterator] () { yield bytes } })

/** Consumes a streaming split fully: the collected blocks and the resolved index. */
const splitAll = async (bytes: Uint8Array, p?: ContentParams): Promise<{ blocks: Uint8Array[], index: ContentIndex }> => {
  const { blocks, index } = split(streamOf(bytes), p)
  const all: Uint8Array[] = []
  for await (const block of blocks) all.push(block)
  return { blocks: all, index: await index }
}

/** assemble with a collecting sink. */
const collect = async (root: Uint8Array, get: (id: string) => Promise<Uint8Array>, opts?: Parameters<typeof assemble>[3]): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  const res = await assemble(root, get, block => { parts.push(block) }, opts)
  assert.equal(res.size, parts.reduce((n, p) => n + p.length, 0))
  return concat(parts)
}
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

/** A getBlock over a split's whole tree, keyed by block id. */
const blockMap = async (blocks: Uint8Array[], index: ContentIndex): Promise<Map<string, Uint8Array>> => {
  const map = new Map<string, Uint8Array>()
  map.set(index.contentId, index.root)
  for (const b of index.indexBlocks) map.set(await blockId(b, small), b)
  for (const b of blocks) map.set(await blockId(b, small), b)
  return map
}
const mapGet = (map: Map<string, Uint8Array>) => async (id: string): Promise<Uint8Array> => {
  const block = map.get(id)
  if (block === undefined) throw new Error(`no block ${id}`)
  return block
}

// ------------------------------------------------------------- the vectors

test('vectors: every committed vector rebuilds to its committed depth and content id', T, async () => {
  assert.equal(vectors.block_size, BLOCK_SIZE)
  assert.equal(vectors.fanout, FANOUT)
  for (const v of vectors.vectors) {
    if (v.input.kind === 'data') {
      const bytes = b64url.decode(v.input.bytes ?? '')
      const { blocks, index } = await splitAll(bytes)
      assert.equal(index.size, v.size, v.name)
      assert.equal(index.depth, v.depth, v.name)
      assert.equal(index.contentId, v.content_id, v.name)
      if (v.block_ids !== null) {
        assert.deepEqual(await Promise.all(blocks.map(b => blockId(b))), v.block_ids, v.name)
      }
    } else if (v.input.kind === 'pattern') {
      const bytes = pattern(BLOCK_SIZE, v.input.tail === undefined ? 0 : 1)
      assert.equal(bytes.length, v.size, v.name)
      const { blocks, index } = await splitAll(bytes)
      assert.equal(index.depth, v.depth, v.name)
      assert.equal(index.contentId, v.content_id, v.name)
      if (v.block_ids !== null) assert.deepEqual(await Promise.all(blocks.map(b => blockId(b))), v.block_ids, v.name)
    } else if (v.input.kind === 'repeated-block') {
      const hash = b64url.decode(v.input.hash!)
      const repeated = (function * () { for (let i = 0; i < v.input.count!; i++) yield hash })()
      const index = await buildIndex(repeated, v.size)
      assert.equal(index.depth, v.depth, v.name)
      assert.equal(index.contentId, v.content_id, v.name)
    } else {
      assert.fail(`unknown vector input kind: ${v.input.kind}`)
    }
  }
})

test('vectors: the depth-1/depth-2 boundary at the spec constants is 16,383 and 16,384 data blocks', T, async () => {
  const d1 = vectors.vectors.find(v => v.name === 'depth1-16383')!
  const d2 = vectors.vectors.find(v => v.name === 'depth2-16384')!
  assert.equal(d1.depth, 1)
  assert.equal(d2.depth, 2)
  assert.notEqual(d1.content_id, d2.content_id)
  // Structure at spec scale, from the build side: depth 1 packs nothing, depth 2
  // packs the 16,384 data hashes into exactly one full index block whose single
  // hash the root carries.
  const hash = b64url.decode(d2.input.hash!)
  const repeated = (function * () { for (let i = 0; i < 16384; i++) yield hash })()
  const index = await buildIndex(repeated, d2.size)
  assert.equal(index.indexBlocks.length, 1)
  const root = parseRoot(index.root)
  assert.equal(root.size, d2.size)
  assert.equal(root.depth, 2)
  // parseRoot returns the whole hash-slot region beside the header; the real
  // count comes from the size and depth (here 1). Its first slot is the index
  // block's hash.
  assert.equal(root.hashes.length, 32 * 16383)
  assert.equal(b64url.encode(root.hashes.subarray(0, 32)), b64url.encode(await sha256(index.indexBlocks[0]!)))
  // depth 1: the root itself carries all 16,383 data hashes, no index blocks.
  const hash1 = b64url.decode(d1.input.hash!)
  const repeated1 = (function * () { for (let i = 0; i < 16383; i++) yield hash1 })()
  const index1 = await buildIndex(repeated1, d1.size)
  assert.equal(index1.indexBlocks.length, 0)
  assert.equal(parseRoot(index1.root).hashes.length, 32 * 16383)
  // The data ids name the same repeated block, in order.
  assert.equal(index.dataIds.length, 16384)
  assert.ok(index.dataIds.every(id => id === d2.input.hash))
})

// ------------------------------------------------- round trips, test params

test('split then assemble round-trips bytes at every boundary size (test parameters)', T, async () => {
  for (const size of [0, 1, 5, 63, 64, 65, 127, 128, 129, 200]) {
    const bytes = pattern(size, 0)
    const { blocks, index } = await splitAll(bytes, small)
    const expectedBlocks = size === 0 ? 0 : Math.ceil(size / 64)
    assert.equal(blocks.length, expectedBlocks, `size ${size}`)
    if (blocks.length > 0) assert.equal(blocks[blocks.length - 1]!.length, 64, 'every block is full size')
    const map = await blockMap(blocks, index)
    const got = await collect(index.root, mapGet(map), { ...small, contentId: index.contentId })
    assert.deepEqual(got, bytes, `size ${size}`)
  }
})

test('the content id is the root\'s block id and is stable across a rebuild', T, async () => {
  const bytes = pattern(129)
  const a = await splitAll(bytes, small)
  const b = await splitAll(bytes, small)
  assert.equal(await blockId(a.index.root, small), a.index.contentId)
  assert.equal(a.index.contentId, b.index.contentId)
  assert.equal(a.index.size, bytes.length)
})

test('dataIds name every data block in order: data block i starts at offset i times the block size', T, async () => {
  const { blocks, index } = await splitAll(pattern(192), small)
  assert.equal(index.dataIds.length, 3)
  for (let i = 0; i < blocks.length; i++) assert.equal(index.dataIds[i], await blockId(blocks[i]!, small))
})

test('the depth-1/depth-2/depth-3 boundary at test parameters is 1, 2 and 3 data blocks', T, async () => {
  // blockSize 64: the root holds at most 1 hash; fan-out 2: a full index block
  // carries 2. One data block fits the root (depth 1); two force one index
  // block (depth 2); three force two index levels (depth 3).
  for (const [n, depth, indexBlocks] of [[1, 1, 0], [2, 2, 1], [3, 3, 3]] as const) {
    const { blocks, index } = await splitAll(pattern(n * 64), small)
    assert.equal(blocks.length, n)
    assert.equal(index.depth, depth, `${n} data blocks`)
    assert.equal(index.indexBlocks.length, indexBlocks, `${n} data blocks`)
    assert.equal(depthFor(n * 64, small), depth)
  }
  // The root of the depth-2 tree carries one hash; the depth-3 tree carries
  // one hash over two index blocks carrying the three data hashes.
  const counts3 = levelCounts(3 * 64, 3, small)
  assert.deepEqual(counts3, [0, 3, 2, 1])
})

test('the empty package is a root with size 0, no hashes, depth 1 (reading flagged on #68)', T, async () => {
  const { blocks, index } = await splitAll(new Uint8Array(0), small)
  assert.equal(blocks.length, 0)
  assert.equal(index.depth, 1)
  const root = parseRoot(index.root, small)
  assert.equal(root.size, 0)
  assert.equal(root.depth, 1)
  // one zero-filled hash slot beside the header; no real hashes
  assert.equal(root.hashes.length, 32)
  assert.ok(root.hashes.every(b => b === 0))
  assert.equal(index.dataIds.length, 0)
  const got = await collect(index.root, async () => { throw new Error('an empty package fetches nothing') }, small)
  assert.equal(got.length, 0)
})

// ------------------------------------------------------------- streaming

test('split emits blocks as the source streams; the index resolves only after full consumption', T, async () => {
  const { blocks, index } = split(streamOf(pattern(192)), small)
  const seen: number[] = []
  for await (const block of blocks) seen.push(block.length)
  assert.deepEqual(seen, [64, 64, 64])
  const idx = await index
  assert.equal(idx.size, 192)
})

test('abandoning the block stream rejects the index promise (misuse fails loudly)', T, async () => {
  const { blocks, index } = split(streamOf(pattern(192)), small)
  for await (const _block of blocks) break // consumed one block of three
  await assert.rejects(() => index, /not consumed fully/)
})

// ---------------------------------------------------------------- rejections

test('a flipped byte in a data block is rejected', T, async () => {
  const { blocks, index } = await splitAll(pattern(192), small) // 3 data blocks, depth 3
  const map = await blockMap(blocks, index)
  const victim = await blockId(blocks[1]!, small)
  map.get(victim)![10] ^= 0xff
  await assert.rejects(() => collect(index.root, mapGet(map), small), /does not hash to its id/)
})

test('a flipped byte in an index block is rejected', T, async () => {
  const { blocks, index } = await splitAll(pattern(192), small)
  const map = await blockMap(blocks, index)
  const victim = await blockId(index.indexBlocks[0]!, small)
  map.get(victim)![0] ^= 0xff
  await assert.rejects(() => collect(index.root, mapGet(map), small), /does not hash to its id/)
})

test('a flipped byte in the root is rejected against the content id the client fetched it under', T, async () => {
  const { blocks, index } = await splitAll(pattern(192), small)
  const map = await blockMap(blocks, index)
  const flipped = index.root.slice()
  flipped[20] ^= 0xff
  await assert.rejects(() => collect(flipped, mapGet(map), { ...small, contentId: index.contentId }), /does not hash to the content id/)
})

test('a root whose size disagrees with its block count is rejected', T, async () => {
  const { blocks, index } = await splitAll(pattern(128), small) // 2 data blocks, depth 2
  const map = await blockMap(blocks, index)
  const lying = index.root.slice()
  new DataView(lying.buffer).setBigUint64(0, BigInt(128 + 64), false) // claims 3 data blocks
  await assert.rejects(() => collect(lying, mapGet(map), small))
  const shrunk = index.root.slice()
  new DataView(shrunk.buffer).setBigUint64(0, BigInt(64), false) // claims 1 data block
  await assert.rejects(() => collect(shrunk, mapGet(map), small))
})

test('a root with a non-minimal or sub-1 depth is rejected', T, async () => {
  const { blocks, index } = await splitAll(pattern(64), small) // 1 data block, depth 1
  const map = await blockMap(blocks, index)
  const inflated = index.root.slice()
  inflated[8] = 2
  await assert.rejects(() => collect(inflated, mapGet(map), small), /minimal depth/)
  const zero = index.root.slice()
  zero[8] = 0
  await assert.rejects(() => collect(zero, mapGet(map), small), /below 1/)
})

test('a truncated root and a buildIndex size/hash-count disagreement are refused', T, async () => {
  const { index } = await splitAll(pattern(128), small)
  await assert.rejects(() => collect(index.root.subarray(0, 63), async () => { throw new Error('unreachable') }, small), /root block is 64 bytes/)
  await assert.rejects(() => buildIndex((function * () { yield new Uint8Array(32) })(), 256, small), /cuts into 4 blocks, got 1/)
  await assert.rejects(() => buildIndex((function * () { yield new Uint8Array(32) })(), 0, small), /cuts into 0 blocks, got 1/)
})

test('blockId refuses a block that is not exactly one block long', T, async () => {
  await assert.rejects(() => blockId(new Uint8Array(BLOCK_SIZE - 1)), /a block is 524288 bytes, got 524287/)
  await assert.rejects(() => blockId(new Uint8Array(64), { blockSize: 40 }), /blockSize 40 is below/)
})

test('a buildIndex fan-out that does not fit the block is refused', T, async () => {
  await assert.rejects(() => buildIndex((function * () {})(), 0, { blockSize: 64, fanout: 3 }), /does not fit/)
})

// ------------------------------------------- real package file, opt-in only

// Tiers 2 and 3 of the operator's test plan on #68: run against a real model
// file. `VORTEX_PACKAGE_FILE=/path bun test v6/webhub/content` — skipped when
// the variable is unset, and never part of the default suite. No fixture file
// is committed. The test checks: split -> the content id is stable across two
// runs -> assemble from a block source reading file ranges -> the SHA-256 of
// the output equals the input's.
const pkgFile = process.env.VORTEX_PACKAGE_FILE

test('real package file: streaming split is stable and assembles back to the same SHA-256', { timeout: 900_000, skip: pkgFile === undefined ? 'set VORTEX_PACKAGE_FILE=/path to run against a real package file' : false }, async () => {
  const path = pkgFile!
  const { stat, open } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const size = (await stat(path)).size

  const chunks = async function * (chunkSize = 1 << 20): AsyncGenerator<Uint8Array> {
    const f = await open(path, 'r')
    try {
      const buf = new Uint8Array(chunkSize)
      for (;;) {
        const { bytesRead } = await f.read(buf, 0, chunkSize, null)
        if (bytesRead === 0) return
        yield buf.subarray(0, bytesRead)
      }
    } finally { await f.close() }
  }
  const hashOf = async (): Promise<Buffer> => {
    const h = createHash('sha256')
    for await (const chunk of chunks()) h.update(chunk)
    return h.digest()
  }

  const splitFile = async (): Promise<ContentIndex> => {
    const { blocks, index } = split(chunks())
    for await (const _block of blocks) { void _block } // emitted and dropped: streaming
    return await index
  }
  const inputHash = await hashOf()
  const run1 = await splitFile()
  const run2 = await splitFile()
  assert.equal(run1.contentId, run2.contentId, 'the content id is stable across two runs')
  assert.deepEqual(run1.dataIds, run2.dataIds)
  assert.equal(run1.size, size)

  // Assemble from a block source reading file ranges: block i is offset i
  // times the block size, zero-padded to full size. No block store needed.
  const positions = new Map(run1.dataIds.map((id, i) => [id, i]))
  const f = await open(path, 'r')
  const getBlock = async (id: string): Promise<Uint8Array> => {
    const i = positions.get(id)
    if (i === undefined) throw new Error(`no block ${id} in the source file`)
    const start = i * BLOCK_SIZE
    const len = Math.min(BLOCK_SIZE, size - start)
    const buf = new Uint8Array(BLOCK_SIZE)
    await f.read(buf, 0, len, start)
    return buf
  }
  const out = createHash('sha256')
  let bytes = 0
  const res = await assemble(run1.root, getBlock, b => { out.update(b); bytes += b.length }, { contentId: run1.contentId })
  await f.close()
  assert.equal(res.size, size)
  assert.equal(bytes, size)
  assert.deepEqual(out.digest(), inputHash, 'the reassembled output hashes to the input')
})
