// u32 amount primitive, test-first from the fenced task in issue #109 (Wren's spec):
// a parseAmount that accepts only [1-9][0-9]* up to 4,294,967,295, checkedAdd/checkedSub
// taking the bound as an argument (u32 for amounts, 2^53-1 for totals), and a check that
// an amount's original text equals its canonical re-encoding.
//
// Two readings flagged for reconciliation with Sorrel (posted on #109):
// (a) parseAmount takes the raw JSON scalar (unknown), because string-typed numbers
//     like "1" are only refusable if the JSON type survives the call;
// (b) the canonical re-encoding check is its own function over the raw text
//     (canonicalAmount), because JS collapses 1.0 and 1e3 into 1 — only the raw
//     text layer can refuse 1.0, 1e3 and 01.
// The bare +/- lint rule over amounts is Sorrel's to implement in the module's own
// file; it is not asserted from here.
import { describe, expect, test } from 'bun:test'
import { checkedAdd, checkedSub, canonicalAmount, parseAmount } from './amount.ts'

const U32 = 4294967295
const MAX_SAFE = 9007199254740991 // 2^53 - 1

const throws = (fn: () => unknown) => expect(fn).toThrow()

describe('parseAmount', () => {
  test('accepts positive integers up to the u32 bound', () => {
    expect(parseAmount(1)).toBe(1)
    expect(parseAmount(22)).toBe(22)
    expect(parseAmount(18000)).toBe(18000)
    expect(parseAmount(U32)).toBe(U32)
  })

  test('refuses zero and negatives', () => {
    throws(() => parseAmount(0))
    throws(() => parseAmount(-1))
    throws(() => parseAmount(-0))
  })

  test('refuses values above the u32 bound', () => {
    throws(() => parseAmount(4294967296))
    throws(() => parseAmount(Number.MAX_SAFE_INTEGER))
  })

  test('refuses non-integers', () => {
    throws(() => parseAmount(1.5))
    throws(() => parseAmount(NaN))
    throws(() => parseAmount(Infinity))
  })

  test('refuses non-numbers, including string-typed amounts', () => {
    throws(() => parseAmount('1'))
    throws(() => parseAmount(''))
    throws(() => parseAmount(null))
    throws(() => parseAmount(undefined))
    throws(() => parseAmount(true))
    throws(() => parseAmount({}))
  })
})

describe('canonicalAmount', () => {
  // Raw-text layer: this is what refuses the shapes the JS number type cannot
  // distinguish from valid ones.
  test('accepts canonical decimal text', () => {
    expect(canonicalAmount('1')).toBe('1')
    expect(canonicalAmount('22')).toBe('22')
    expect(canonicalAmount('4294967295')).toBe('4294967295')
  })

  test('refuses non-canonical encodings of valid values', () => {
    throws(() => canonicalAmount('01')) // leading zero
    throws(() => canonicalAmount('1.0')) // decimal point
    throws(() => canonicalAmount('1e3')) // exponent form
    throws(() => canonicalAmount('1e0'))
    throws(() => canonicalAmount('+1'))
    throws(() => canonicalAmount('1.'))
  })

  test('refuses zero, negatives and out-of-range text', () => {
    throws(() => canonicalAmount('0'))
    throws(() => canonicalAmount('-1'))
    throws(() => canonicalAmount('-0'))
    throws(() => canonicalAmount('4294967296'))
    throws(() => canonicalAmount(''))
  })

  test('original text equals its canonical re-encoding for accepted amounts', () => {
    for (const text of ['1', '7', '18000', '50000', '4294967295']) {
      expect(text === canonicalAmount(text)).toBe(true)
    }
  })
})

describe('checkedAdd', () => {
  test('returns the sum when it fits the bound, bound inclusive', () => {
    expect(checkedAdd(5, 3, U32)).toBe(8)
    expect(checkedAdd(U32 - 1, 1, U32)).toBe(U32)
    expect(checkedAdd(1, 2, MAX_SAFE)).toBe(3)
    expect(checkedAdd(MAX_SAFE - 1, 1, MAX_SAFE)).toBe(MAX_SAFE)
  })

  test('refuses sums above the u32 bound', () => {
    throws(() => checkedAdd(U32, 1, U32))
    throws(() => checkedAdd(U32, U32, U32))
  })

  test('refuses totals above the 2^53-1 bound', () => {
    throws(() => checkedAdd(MAX_SAFE, 1, MAX_SAFE))
  })
})

describe('checkedSub', () => {
  test('returns the difference when it stays at or above zero', () => {
    expect(checkedSub(5, 3, U32)).toBe(2)
    expect(checkedSub(U32, 1, U32)).toBe(U32 - 1)
    expect(checkedSub(MAX_SAFE, 1, MAX_SAFE)).toBe(MAX_SAFE - 1)
    expect(checkedSub(7, 7, U32)).toBe(0)
  })

  test('refuses results below zero', () => {
    throws(() => checkedSub(3, 5, U32))
    throws(() => checkedSub(0, 1, MAX_SAFE))
  })

  // Reading flagged to Sorrel: `bound` also caps the result of checkedSub
  // (a difference is an amount and must obey the same upper bound).
  test('refuses results above the bound (flagged reading)', () => {
    throws(() => checkedSub(U32, 1, 100))
  })
})
