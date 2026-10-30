// ULID (crockford base32): 48-bit ms timestamp + 80 bits of randomness.
// v6 hub message and batch identifiers must be stable, sortable and opaque
// to the model (docs/v6-proposal.md §8.2, §8.10 ref = last 6 chars).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

export function ulid (now = Date.now()): string {
  let time = ''
  let t = now
  for (let i = TIME_LEN; i > 0; i--) {
    time = ENCODING[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time + randomPart()
}

function randomPart (): string {
  const bytes = new Uint8Array(RANDOM_LEN) // 16 * 5 bits = 80 bits
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i] % 32]
  return out
}

const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/
export function isUlid (id: unknown): id is string {
  return typeof id === 'string' && id.length === 26 && ULID_RE.test(id)
}

/** Monotonicity within one millisecond: bump the random part above `after`. */
export function ulidAfter (after: string, now = Date.now()): string {
  let id = ulid(Math.max(now, decodeTime(after)))
  if (id > after) return id
  return ulid(now + 1)
}

export function decodeTime (id: string): number {
  let t = 0
  for (let i = 0; i < TIME_LEN; i++) t = t * 32 + ENCODING.indexOf(id[i])
  return t
}
