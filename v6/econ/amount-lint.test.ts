// Scoped lint regression (#112 review). Amount values in v6/econ must move only through
// the checked helpers in amount.ts.
//
// Two rules:
// 1. Other econ source files (not tests, not amount.ts): no bare + or - on an identifier
//    that names an amount (line-based, as before).
// 2. amount.ts itself: a small tokenizer scans the whole source as one string. A + or -
//    is binary when the previous token is an identifier, number, ')' or ']'. Binary
//    + and -, and += -= ++ --, are flagged unless their offset lies inside an allowed
//    helper's body (matched by brace depth on the token stream).
//
// Tokenizer choices: // and /* */ comments are skipped. '…' and "…" strings are skipped.
// Template literals are skipped whole, including any ${…} contents, so an operator inside
// ${…} is NOT checked. A regex literal is recognised after an operator, punctuation other
// than ')' ']' '}', or a keyword, and is skipped.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The only functions in amount.ts allowed to contain binary + or -. */
export const ALLOWED_HELPERS: readonly string[] = ['checkedAdd', 'checkedSub']

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

type Tok = { kind: 'id' | 'num' | 'op' | 'punct' | 'lit'; text: string; at: number }

const KEYWORDS = new Set(['return', 'typeof', 'throw', 'case', 'void', 'delete', 'in', 'of', 'new', 'else', 'do', 'yield', 'await', 'instanceof'])
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/y
const NUMBER = /\d[\w.]*(?:[eE][+-]\d+)?/y
const IDENT = /[A-Za-z_$][\w$]*/y

/** Single-pass tokenizer over the whole source; comments are dropped, literals become 'lit'. */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  const at = (re: RegExp, i: number) => { re.lastIndex = i; return re.exec(src) }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue }
    const prev = toks[toks.length - 1]
    const regexOk = !prev || prev.kind === 'op' || (prev.kind === 'punct' && !')]}'.includes(prev.text))
      || (prev.kind === 'id' && KEYWORDS.has(prev.text))
    if (c === '/' && regexOk) {
      let j = i + 1, inClass = false
      while (j < src.length && (src[j] !== '/' || inClass)) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        j++
      }
      j++
      while (j < src.length && /[a-z]/.test(src[j])) j++
      toks.push({ kind: 'lit', text: src.slice(i, j), at: i }); i = j; continue
    }
    const lit = at(LITERAL, i)
    if (lit) { toks.push({ kind: 'lit', text: lit[0], at: i }); i += lit[0].length; continue }
    const id = at(IDENT, i)
    if (id) { toks.push({ kind: 'id', text: id[0], at: i }); i += id[0].length; continue }
    const num = at(NUMBER, i)
    if (num) { toks.push({ kind: 'num', text: num[0], at: i }); i += num[0].length; continue }
    const two = src.slice(i, i + 2)
    if (['++', '--', '+=', '-='].includes(two)) { toks.push({ kind: 'op', text: two, at: i }); i += 2; continue }
    toks.push({ kind: /[+-]/.test(c) ? 'op' : 'punct', text: c, at: i }); i++
  }
  return toks
}

/** Offset spans [start, end) of each allowed helper's body, found by brace depth. */
function helperSpans(toks: Tok[], names: readonly string[]): [number, number][] {
  const spans: [number, number][] = []
  toks.forEach((t, idx) => {
    if (t.kind !== 'id') return
    const named = names.some(n =>
      (t.text === 'function' && toks[idx + 1]?.text === n) ||
      (t.text === 'const' && toks[idx + 1]?.text === n && toks[idx + 2]?.text === '='))
    if (!named) return
    let open = idx
    while (open < toks.length && toks[open].text !== '{') open++
    let depth = 0
    for (let k = open; k < toks.length; k++) {
      if (toks[k].text === '{') depth++
      else if (toks[k].text === '}' && --depth === 0) { spans.push([t.at, toks[k].at + 1]); break }
    }
  })
  return spans
}

/**
 * Binary + and -, and += -= ++ --, outside the allowed helpers. Returns `line:col op` for
 * each hit; an empty array means every operation is guarded.
 */
export function unguardedOperators(source: string, allow: readonly string[] = ALLOWED_HELPERS): string[] {
  const toks = tokenize(source)
  const spans = helperSpans(toks, allow)
  const hits: string[] = []
  toks.forEach((t, idx) => {
    if (t.kind !== 'op') return
    const prev = toks[idx - 1]
    const incOrCompound = t.text !== '+' && t.text !== '-'
    const binary = !!prev && (prev.kind === 'num' || (prev.kind === 'id' && !KEYWORDS.has(prev.text))
      || prev.text === ')' || prev.text === ']')
    if (!incOrCompound && !binary) return
    if (spans.some(([s, e]) => t.at >= s && t.at < e)) return
    const before = source.slice(0, t.at)
    const line = before.split('\n').length
    const col = t.at - before.lastIndexOf('\n')
    hits.push(`${line}:${col} ${t.text}`)
  })
  return hits
}

const SCOPED = readdirSync(HERE).filter(f =>
  f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'amount.ts')

describe('bare amount arithmetic detector', () => {
  test('flags bare arithmetic on amount names', () => {
    expect(bareAmountArithmetic('const x = amount + 1')).toHaveLength(1)
    expect(bareAmountArithmetic('return total - amount')).toHaveLength(1)
    expect(bareAmountArithmetic('const y = iou.faceAmount * 2')).toHaveLength(0)
  })
})

describe('unguarded operator detector (amount.ts, tokenizer)', () => {
  test('catches Hollis multiline unchecked return, reported with line:col', () => {
    const src = 'export function sneaky(a: number, b: number) {\n  return (\n    a +\n    b )\n}\n'
    expect(unguardedOperators(src)).toEqual(['3:7 +'])
  })

  test('flags compound assignment x += 1', () => {
    expect(unguardedOperators('let x = 0\nx += 1\n')).toEqual(['2:3 +='])
  })

  test('does not flag unary -a, including after return', () => {
    expect(unguardedOperators('const n = -a\n')).toEqual([])
    expect(unguardedOperators('function f(a) {\n  return -a\n}\n')).toEqual([])
  })

  test('does not flag operators inside strings or comments', () => {
    expect(unguardedOperators('const s = "a+b"\n// a + b\n/* c - d */\n')).toEqual([])
  })

  test('allows operators inside the allowlisted helpers only', () => {
    const ok = 'export function checkedAdd(a: number, b: number, bound: number) {\n  return a + b\n}\n'
    expect(unguardedOperators(ok)).toEqual([])
    const sub = 'export function checkedSub(a: number, b: number) {\n  return a - b\n}\n'
    expect(unguardedOperators(sub)).toEqual([])
    const sneaky = 'export function checkedAddAll(a: number, b: number) {\n  return a + b\n}\n'
    expect(unguardedOperators(sneaky)).toHaveLength(1)
  })

  test('flags an operator after a helper closing brace', () => {
    const after = 'export function checkedAdd(a: number, b: number) {\n  return a\n}\nconst z = a + b\n'
    expect(unguardedOperators(after)).toEqual(['4:13 +'])
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
