// Scoped lint regression (#112 review). Amount values in v6/econ must move only through
// the checked helpers in amount.ts.
//
// Two rules:
// 1. Other econ source files (not tests, not amount.ts): no bare + or - on an identifier
//    that names an amount.
// 2. amount.ts itself: no binary + or - anywhere except inside the allowlisted checked
//    helpers below. Comments, string literals and regex literals are stripped first.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The only functions in amount.ts allowed to contain binary + or -. */
export const ALLOWED_HELPERS: readonly string[] = ['checkedAdd', 'checkedSub']

// An amount-named identifier, then a bare + or - (not ++, --, +=, -=).
const BARE = /\b\w*[aA]mount\w*\s*[-+](?![-+=])|(?<![-+])[-+](?![-+=])\s*\w*[aA]mount\w*\b/

// A binary + or -: an operand (identifier, number, or closing bracket) before it and an
// operand after it. Unary signs and ++/--/+=/-= do not match.
const BINARY = /[\w)\]]\s*[-+](?![-+=])\s*[\w(]/

/** Source with comments, string literals and regex literals blanked out, line by line. */
function codeLines(source: string): string[] {
  return source.split('\n').map(line => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
    return line
      .replace(/\/\/.*$/, '')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/=\s*\/[^/\n]+\/[a-z]*/g, '= //')
  })
}

/** Returns the offending lines of one source text, skipping comment-only lines. */
export function bareAmountArithmetic(source: string): string[] {
  return source.split('\n').filter(line => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
    return BARE.test(line)
  })
}

/** Line indexes (0-based) inside the bodies of the named top-level functions. */
function allowedLines(source: string, names: readonly string[]): Set<number> {
  const lines = codeLines(source)
  const allowed = new Set<number>()
  for (const name of names) {
    const start = lines.findIndex(l => new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l.trimStart()))
    if (start < 0) continue
    let depth = 0
    let opened = false
    for (let i = start; i < lines.length; i++) {
      allowed.add(i)
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; opened = true } else if (ch === '}') depth--
      }
      if (opened && depth === 0) break
    }
  }
  return allowed
}

/**
 * Lines with a binary + or - outside the allowed helpers. Returns the offending line
 * texts; an empty array means every operation is guarded.
 */
export function unguardedOperators(source: string, allow: readonly string[] = ALLOWED_HELPERS): string[] {
  const lines = codeLines(source)
  const allowed = allowedLines(source, allow)
  return lines.filter((l, i) => !allowed.has(i) && BINARY.test(l))
}

const SCOPED = readdirSync(HERE).filter(f =>
  f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'amount.ts')

describe('bare amount arithmetic detector', () => {
  test('flags bare arithmetic on amount names', () => {
    expect(bareAmountArithmetic('const x = amount + 1')).toHaveLength(1)
    expect(bareAmountArithmetic('return total - amount')).toHaveLength(1)
    expect(bareAmountArithmetic('const y = iou.faceAmount * 2')).toHaveLength(0)
  })

  test('ignores comments, increments and assignments', () => {
    expect(bareAmountArithmetic('// amount + 1 is forbidden')).toHaveLength(0)
    expect(bareAmountArithmetic('amount += 1')).toHaveLength(0)
    expect(bareAmountArithmetic('const n = checkedAdd(amount, 1, U32)')).toHaveLength(0)
  })
})

describe('unguarded operator detector (amount.ts)', () => {
  test('flags a + or - outside the allowed helpers, whatever the names', () => {
    const src = 'export function f(a: number, b: number) {\n  return a + b\n}\n'
    expect(unguardedOperators(src)).toEqual(['  return a + b'])
    expect(unguardedOperators('const d = x - 1\n')).toHaveLength(1)
  })

  test('allows operators inside the allowlisted helpers only', () => {
    const ok = 'export function checkedAdd(a: number, b: number, bound: number) {\n  return a + b\n}\n'
    expect(unguardedOperators(ok)).toEqual([])
    const sub = 'export function checkedSub(a: number, b: number) {\n  return a - b\n}\n'
    expect(unguardedOperators(sub)).toEqual([])
    // A helper with a longer name is not the allowlisted one.
    const sneaky = 'export function checkedAddAll(a: number, b: number) {\n  return a + b\n}\n'
    expect(unguardedOperators(sneaky)).toHaveLength(1)
    // An operator after the helper's closing brace is outside it.
    const after = 'export function checkedAdd(a: number, b: number) {\n  return a\n}\nconst z = a + b\n'
    expect(unguardedOperators(after)).toEqual(['const z = a + b'])
  })

  test('ignores unary signs, increments, comments, strings and regex literals', () => {
    expect(unguardedOperators('const n = -1\n')).toEqual([])
    expect(unguardedOperators('i++\nj += 2\n')).toEqual([])
    expect(unguardedOperators('// a + b\n')).toEqual([])
    expect(unguardedOperators('throw new RangeError("a + b")\n')).toEqual([])
    expect(unguardedOperators('const C = /^[1-9][0-9]*$/\n')).toEqual([])
  })

  test('amount.ts has no unguarded + or -', () => {
    const source = readFileSync(join(HERE, 'amount.ts'), 'utf8')
    expect(unguardedOperators(source)).toEqual([])
  })
})

describe('econ source uses checked helpers for amounts', () => {
  test('scoped files exist', () => {
    expect(SCOPED.length).toBeGreaterThan(0)
  })

  for (const file of SCOPED) {
    test(`${file} has no bare amount arithmetic`, () => {
      const offending = bareAmountArithmetic(readFileSync(join(HERE, file), 'utf8'))
      expect(offending).toEqual([])
    })
  }
})
