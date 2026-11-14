import { describe, expect, test } from 'bun:test'
import { aliasOf, assertPostable, buildPrompt, parseTags, squash } from './clerk.ts'

describe('aliasOf', () => {
  test('reads the bold signature at the start of the body', () => {
    expect(aliasOf('**Hollis**\n\nbody')).toBe('Hollis')
    expect(aliasOf('  **Wren** — ballot')).toBe('Wren')
  })

  test('falls back to operator when there is no signature', () => {
    expect(aliasOf('no signature here')).toBe('operator')
    expect(aliasOf('text first **Ellis** later')).toBe('operator')
  })
})

describe('squash', () => {
  test('writes alias and timestamp, then the body, oldest first', () => {
    const out = squash([
      { user: 'a', created_at: '2026-11-14T09:00:00Z', body: '**Ellis**\n\nfirst' },
      { user: 'b', created_at: '2026-11-14T10:00:00Z', body: 'second, no signature' },
    ])
    expect(out).toBe(
      '[Ellis] [2026-11-14T09:00:00Z]\n**Ellis**\n\nfirst\n\n' +
      '[operator] [2026-11-14T10:00:00Z]\nsecond, no signature\n',
    )
  })
})

describe('buildPrompt', () => {
  const comments = Array.from({ length: 4 }, (_, i) => ({
    user: 'u', created_at: `t${i}`, body: `**A${i}**\n${'x'.repeat(10)}`,
  }))

  test('keeps everything when it fits', () => {
    const p = buildPrompt('sys', 'issue', comments, 'go')
    expect(p.kept).toBe(4)
    expect(p.dropped).toBe(0)
    expect(p.user).toContain('Issue body:\nissue')
    expect(p.chars).toBe('sys'.length + p.user.length)
  })

  test('is measured in characters and keeps the body when it trims', () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({
      user: 'u', created_at: `t${i}`, body: `**A**\n${'y'.repeat(100)}`,
    }))
    const p = buildPrompt('sys', 'the body', big, 'go', 120_000)
    expect(p.dropped).toBeGreaterThan(0)
    expect(p.kept + p.dropped).toBe(2000)
    expect(p.chars).toBeLessThanOrEqual(120_000 + 10)
    expect(p.user).toContain('Issue body:\nthe body')
    // the newest comment is the one that survives
    expect(p.user).toContain('t1999')
    expect(p.user).not.toContain('[A] [t0]')
  })
})

describe('parseTags', () => {
  test('reads comment, noop and answer tags', () => {
    const text = [
      'pre',
      '<comment issue="110">**Wren**\n\nhello *markdown*</comment>',
      '<noop reason="nothing new"/>',
      '<answer>Fix: 3/3</answer>',
    ].join('\n')
    const p = parseTags(text)
    expect(p.comments).toEqual([{ issue: 110, body: '**Wren**\n\nhello *markdown*' }])
    expect(p.noops).toEqual(['nothing new'])
    expect(p.answers).toEqual(['Fix: 3/3'])
  })

  test('returns empty lists for text with no tags', () => {
    expect(parseTags('just prose, no tags')).toEqual({ comments: [], noops: [], answers: [] })
  })

  test('takes multiline answers and ignores JSON', () => {
    const p = parseTags('<answer>\nA\nB\n</answer>{"comments": []}')
    expect(p.answers).toEqual(['A\nB'])
    expect(p.comments).toEqual([])
  })
})

describe('assertPostable', () => {
  test('accepts a body that begins **Wren**', () => {
    expect(() => assertPostable('**Wren**\n\nok')).not.toThrow()
  })

  test('refuses any other opening', () => {
    expect(() => assertPostable('Wren: ok')).toThrow('must begin **Wren**')
    expect(() => assertPostable('ok **Wren**')).toThrow()
  })
})
