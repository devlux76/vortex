// A9 §10a content addressing (docs/v6-amendment-a9-webhub.md, as amended on
// PR #54): block ids, the index, the root, and the content id.
//
// A package's bytes are cut into fixed-size blocks, the last one zero-padded.
// A block id is the base64url SHA-256 of the full (padded) block. The raw
// 32-byte hashes of the data blocks, in order, form level 1. A list that fits
// the root goes straight into it; a longer list is packed into full index
// blocks (the last zero-padded) whose hashes form the next level, and the
// rule repeats until a list fits the root. The root is
// `[u64 size, big-endian][u8 depth]` followed by its hashes and zero padding;
// `depth` counts the index levels, the root included, and is minimal: the
// packing stops as soon as a level fits. The content id is the block id of
// the root, so it commits to every byte, to the order and to the length.
//
// Block size and fan-out are internal test parameters with the spec
// constants as defaults, so the depth-1/depth-2 boundary (16,383 and 16,384
// data blocks at spec constants) is testable at tiny sizes. The committed
// vectors in vectors/content.json pin the spec-constant behavior; the
// content id format freezes when #68 merges (§15 item 8).

import { b64url } from '../client/b64.ts'

/** Spec constants (§10a): the one block size and the index fan-out. */
export const BLOCK_SIZE = 512 * 1024
export const FANOUT = 16_384
export const HASH_LEN = 32
/** Root header: `[u64 size, big-endian][u8 depth]`. */
export const ROOT_HEADER_LEN = 9

export interface ContentParams {
  /** Block size in bytes (default 512 KiB). Must be at least header + one hash. */
  blockSize?: number
  /** Hashes packed into one full index block (default 16,384). */
  fanout?: number
}

interface Resolved {
  blockSize: number
  fanout: number
  rootMax: number
}

function resolve (p?: ContentParams): Resolved {
  const blockSize = p?.blockSize ?? BLOCK_SIZE
  const fanout = p?.fanout ?? FANOUT
  if (!Number.isInteger(blockSize) || blockSize < ROOT_HEADER_LEN + HASH_LEN) {
    throw new Error(`blockSize ${blockSize} is below the root header plus one hash`)
  }
  if (!Number.isInteger(fanout) || fanout < 1 || fanout * HASH_LEN > blockSize) {
    throw new Error(`fanout ${fanout} does not fit a ${blockSize}-byte block`)
  }
  // At most rootMax hashes fit the root beside its header; at the spec
  // constants this is 16,383.
  return { blockSize, fanout, rootMax: Math.floor((blockSize - ROOT_HEADER_LEN) / HASH_LEN) }
}

export async function sha256 (bytes: Uint8Array): Promise<Uint8Array> {
  const Bun_ = (globalThis as { Bun?: { CryptoHasher?: new (algo: string) => { update (b: Uint8Array): unknown; digest (): Uint8Array } } }).Bun
  if (Bun_?.CryptoHasher !== undefined) {
    const h = new Bun_.CryptoHasher('sha256')
    h.update(bytes)
    return new Uint8Array(h.digest())
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** The block id of one full, already-padded block: base64url SHA-256 of its bytes. */
export async function blockId (block: Uint8Array, p?: ContentParams): Promise<string> {
  const { blockSize } = resolve(p)
  if (block.length !== blockSize) throw new Error(`a block is ${blockSize} bytes, got ${block.length}`)
  return b64url.encode(await sha256(block))
}

function ceilDiv (a: number, b: number): number {
  return Math.floor((a + b - 1) / b)
}

/** The number of data blocks a package of `size` bytes is cut into. */
export function dataBlockCount (size: number, p?: ContentParams): number {
  const { blockSize } = resolve(p)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`size ${size} is not a safe non-negative integer`)
  return ceilDiv(size, blockSize)
}

/** Minimal depth for `size`: the packing stops as soon as a level fits the root. */
export function depthFor (size: number, p?: ContentParams): number {
  const r = resolve(p)
  let count = dataBlockCount(size, p)
  let depth = 1
  while (count > r.rootMax) {
    count = ceilDiv(count, r.fanout)
    depth++
  }
  return depth
}

/** Block counts per level for `size`: counts[1] is the data blocks, counts[d] the hashes the root holds. */
export function levelCounts (size: number, depth: number, p?: ContentParams): number[] {
  const r = resolve(p)
  const counts: number[] = [0, dataBlockCount(size, p)]
  for (let level = 2; level <= depth; level++) counts[level] = ceilDiv(counts[level - 1]!, r.fanout)
  return counts
}

export interface ContentIndex {
  /** The package's length in bytes. */
  size: number
  /** Number of index levels, the root included (1 for a root holding the data hashes). */
  depth: number
  /** The padded root block: `[u64 size][u8 depth]` + hashes + zero padding. */
  root: Uint8Array
  /** The intermediate index blocks, in creation order (empty at depth 1). */
  indexBlocks: Uint8Array[]
  /** The block id of the root — the content id of the whole package. */
  contentId: string
}

/**
 * Builds the index, the root and the content id from an ITERATOR of data-block
 * hashes, not the data, so a huge package needs no huge buffer. The hash count
 * must be exactly the data blocks `size` cuts into, so a size that disagrees
 * with the block count is refused here too.
 */
export async function buildIndex (
  blockHashes: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  size: number,
  p?: ContentParams,
): Promise<ContentIndex> {
  const r = resolve(p)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`size ${size} is not a safe non-negative integer`)
  const level: Uint8Array[] = []
  for await (const hash of blockHashes) {
    if (hash.length !== HASH_LEN) throw new Error(`a data-block hash is ${HASH_LEN} bytes, got ${hash.length}`)
    level.push(hash)
  }
  const expected = ceilDiv(size, r.blockSize)
  if (level.length !== expected) {
    throw new Error(`size ${size} cuts into ${expected} blocks, got ${level.length} hashes`)
  }

  const indexBlocks: Uint8Array[] = []
  let depth = 1
  while (level.length > r.rootMax) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += r.fanout) {
      const real = Math.min(r.fanout, level.length - i)
      const block = new Uint8Array(r.blockSize)
      for (let j = 0; j < real; j++) block.set(level[i + j]!, j * HASH_LEN)
      indexBlocks.push(block)
      next.push(await sha256(block))
    }
    level.length = 0
    level.push(...next)
    depth++
  }

  const root = new Uint8Array(r.blockSize)
  const dv = new DataView(root.buffer)
  dv.setBigUint64(0, BigInt(size), false)
  root[8] = depth
  let off = ROOT_HEADER_LEN
  for (const hash of level) {
    root.set(hash, off)
    off += HASH_LEN
  }
  return { size, depth, root, indexBlocks, contentId: b64url.encode(await sha256(root)) }
}

/** Reads a root's header without verifying it: size, depth and the hash count it carries. */
export function parseRoot (root: Uint8Array, p?: ContentParams): { size: number, depth: number, hashes: Uint8Array } {
  const { blockSize } = resolve(p)
  if (root.length !== blockSize) throw new Error(`a root block is ${blockSize} bytes, got ${root.length}`)
  const dv = new DataView(root.buffer, root.byteOffset, root.byteLength)
  const big = dv.getBigUint64(0, false)
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`root size ${big} exceeds a safe integer`)
  const size = Number(big)
  const depth = root[8]!
  const count = Math.floor((root.length - ROOT_HEADER_LEN) / HASH_LEN)
  return { size, depth, hashes: root.subarray(ROOT_HEADER_LEN, ROOT_HEADER_LEN + count * HASH_LEN) }
}

function zeros (bytes: Uint8Array, from: number): boolean {
  for (let i = from; i < bytes.length; i++) if (bytes[i] !== 0) return false
  return true
}

/**
 * Walks a package from its root and yields every data block's real bytes in
 * order, verifying every hash, the size and the depth on the way. `getBlock`
 * fetches one block by id; `contentId`, when given, pins the root to the id
 * the client fetched it under (§10a: a client checks the root hashes to the
 * content id). Every fetched block is exactly one block long, its hash must
 * match the id that named it, and all zero padding — in the root, in the last
 * index block of each level, in the last data block — must be zeros.
 */
export async function * assemble (
  root: Uint8Array,
  getBlock: (id: string) => Promise<Uint8Array>,
  opts: ContentParams & { contentId?: string } = {},
): AsyncGenerator<Uint8Array, void, unknown> {
  const r = resolve(opts)
  if (root.length !== r.blockSize) throw new Error(`a root block is ${r.blockSize} bytes, got ${root.length}`)
  if (opts.contentId !== undefined && (await blockId(root, opts)) !== opts.contentId) {
    throw new Error(`the root does not hash to the content id ${opts.contentId}`)
  }
  const { size, depth } = parseRoot(root, opts)
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`root size ${size} is not a safe non-negative integer`)
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`root depth ${depth} is below 1`)
  if (depth !== depthFor(size, opts)) {
    throw new Error(`root depth ${depth} is not the minimal depth ${depthFor(size, opts)} for size ${size}`)
  }
  const counts = levelCounts(size, depth, opts)
  const rootCount = counts[depth]!
  if (rootCount > r.rootMax) throw new Error(`the root carries ${rootCount} hashes, more than fit beside its header`)
  if (!zeros(root, ROOT_HEADER_LEN + rootCount * HASH_LEN)) throw new Error('the root carries hashes beyond its count, or non-zero padding')

  const fetchBlock = async (id: Uint8Array, what: string): Promise<Uint8Array> => {
    const block = await getBlock(b64url.encode(id))
    if (block.length !== r.blockSize) throw new Error(`${what} ${b64url.encode(id)} is ${block.length} bytes, not one block`)
    if (b64url.encode(await sha256(block)) !== b64url.encode(id)) throw new Error(`${what} ${b64url.encode(id)} does not hash to its id`)
    return block
  }

  const lastDataBytes = size === 0 ? 0 : size - (counts[1]! - 1) * r.blockSize
  let emitted = 0 // data blocks yielded so far, across the whole traversal

  const emit = async function * (ids: Uint8Array[], level: number): AsyncGenerator<Uint8Array, void, unknown> {
    if (level === 1) {
      if (emitted + ids.length > counts[1]!) throw new Error('the tree yields more data blocks than the size allows')
      for (let i = 0; i < ids.length; i++) {
        const block = await fetchBlock(ids[i]!, 'data block')
        // The package's last data block is the last one overall, not the last
        // of one branch of the tree.
        const real = emitted === counts[1]! - 1 ? lastDataBytes : r.blockSize
        if (!zeros(block, real)) throw new Error('the last data block carries non-zero padding')
        emitted++
        yield block.subarray(0, real)
      }
      return
    }
    for (let i = 0; i < ids.length; i++) {
      const block = await fetchBlock(ids[i]!, 'index block')
      const real = Math.min(r.fanout, counts[level - 1]! - i * r.fanout)
      if (!zeros(block, real * HASH_LEN)) throw new Error('an index block carries hashes beyond its count, or non-zero padding')
      const child: Uint8Array[] = []
      for (let j = 0; j < real; j++) child.push(block.slice(j * HASH_LEN, (j + 1) * HASH_LEN))
      yield * emit(child, level - 1)
    }
  }

  const rootIds: Uint8Array[] = []
  for (let i = 0; i < rootCount; i++) rootIds.push(root.slice(ROOT_HEADER_LEN + i * HASH_LEN, ROOT_HEADER_LEN + (i + 1) * HASH_LEN))
  yield * emit(rootIds, depth)
}

/**
 * Cuts a stream of package bytes into full, zero-padded data blocks and builds
 * the index over them. Practical sizes only: unlike buildIndex, this holds the
 * blocks in memory.
 */
export async function split (
  stream: AsyncIterable<Uint8Array>,
  p?: ContentParams,
): Promise<{ blocks: Uint8Array[], index: ContentIndex }> {
  const { blockSize } = resolve(p)
  const blocks: Uint8Array[] = []
  let cur = new Uint8Array(blockSize)
  let fill = 0
  let size = 0
  for await (const chunk of stream) {
    let off = 0
    while (off < chunk.length) {
      const n = Math.min(blockSize - fill, chunk.length - off)
      cur.set(chunk.subarray(off, off + n), fill)
      fill += n
      off += n
      size += n
      if (fill === blockSize) {
        blocks.push(cur)
        cur = new Uint8Array(blockSize)
        fill = 0
      }
    }
  }
  if (fill > 0) blocks.push(cur) // the tail of `cur` is already zeros
  const hashes: Uint8Array[] = []
  for (const b of blocks) hashes.push(await sha256(b))
  return { blocks, index: await buildIndex(hashes, size, p) }
}
