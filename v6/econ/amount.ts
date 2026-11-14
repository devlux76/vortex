// u32 amount primitive (#109). Scope fence: this module and its tests only.
// No field names, no era plumbing, no integration into iou.ts, ledger.ts or policy.ts.
//
// Reconciled readings (see the test file header):
// - parseAmount takes the raw JSON scalar, so a string-typed "1" is refused because
//   its JS type survives the call.
// - canonicalAmount checks the raw text, because JS collapses 1.0 and 1e3 into 1 and
//   only the text layer can refuse them.

/** An amount is a positive integer no larger than the u32 bound. */
export type Amount = number

/** The u32 bound for amounts. */
export const AMOUNT_MAX = 4294967295

/** The 2^53 - 1 bound for totals. */
export const TOTAL_MAX = Number.MAX_SAFE_INTEGER

const CANONICAL = /^[1-9][0-9]*$/

/**
 * Accepts a raw value as an amount: a JS number that is a safe integer in
 * [1, AMOUNT_MAX]. Anything else (strings, booleans, null, objects, fractions,
 * zero, negatives, -0, NaN, Infinity, out-of-range) throws.
 */
export function parseAmount(value: unknown): Amount {
  if (typeof value !== 'number') throw new RangeError('amount must be a JSON number')
  if (!Number.isSafeInteger(value)) throw new RangeError('amount must be a safe integer')
  if (value < 1 || value > AMOUNT_MAX) throw new RangeError('amount out of u32 range')
  return value
}

/**
 * Accepts raw decimal text only if it is its own canonical encoding: [1-9][0-9]*
 * with no sign, leading zero, decimal point or exponent, within the u32 bound.
 * Returns the text unchanged; throws otherwise.
 */
export function canonicalAmount(text: string): string {
  if (typeof text !== 'string') throw new TypeError('amount text must be a string')
  if (!CANONICAL.test(text)) throw new RangeError('amount text is not canonical decimal')
  if (Number(text) > AMOUNT_MAX) throw new RangeError('amount text out of u32 range')
  return text
}

function checkBound(bound: number): void {
  if (!Number.isSafeInteger(bound) || bound < 0) throw new RangeError('bound must be a non-negative safe integer')
}

function checkOperand(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('operand must be a non-negative safe integer')
}

/** a + b, refused if the sum exceeds `bound` (inclusive). */
export function checkedAdd(a: number, b: number, bound: number): number {
  checkBound(bound)
  checkOperand(a)
  checkOperand(b)
  const sum = a + b
  if (sum > bound) throw new RangeError('sum exceeds bound')
  return sum
}

/** a - b, refused if it goes below zero or exceeds `bound` (inclusive). */
export function checkedSub(a: number, b: number, bound: number): number {
  checkBound(bound)
  checkOperand(a)
  checkOperand(b)
  if (b > a) throw new RangeError('difference below zero')
  const diff = a - b
  if (diff > bound) throw new RangeError('difference exceeds bound')
  return diff
}
