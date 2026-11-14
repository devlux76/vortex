// Scoped lint regression (#112 review). Amount values in v6/econ must move only through
// the checked helpers in amount.ts. This test scans the econ source files (not tests, not
// amount.ts itself) for bare + or - applied to an identifier that names an amount.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// An amount-named identifier, then a bare + or - (not ++, --, +=, -=).
const BARE = /\b\w*[aA]mount\w*\s*[-+](?![-+=])|(?<![-+])[-+](?![-+=])\s*\w*[aA]mount\w*\b/

/** Returns the offending lines of one source text, skipping comment-only lines. */
export function bareAmountArithmetic(source: string): string[] {
  return source.split('\n').filter(line => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
    return BARE.test(line)
  })
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
