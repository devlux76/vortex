// Acceptance test for audit finding F26: an MCP server must answer initialize
// with a protocol version it supports, not echo whatever the client sent.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { negotiateProtocol, SUPPORTED_PROTOCOLS } from './mcp-version.ts'

test('a supported requested version is answered as-is', () => {
  for (const v of SUPPORTED_PROTOCOLS) expect(negotiateProtocol(v)).toBe(v)
})

test('an unknown, missing or non-string version gets our latest supported one', () => {
  for (const v of ['1999-01-01', '2099-12-31', '', undefined, null, 42, {}]) {
    expect(negotiateProtocol(v)).toBe(SUPPORTED_PROTOCOLS[0])
  }
})

test('both plugin servers answer initialize through negotiateProtocol, not by echoing the client', () => {
  for (const host of ['claude', 'codex']) {
    const src = readFileSync(new URL(`../plugins/${host}/server.ts`, import.meta.url), 'utf8')
    expect(src).toContain('negotiateProtocol(')
    expect(src).not.toMatch(/protocolVersion:\s*typeof params\?\.protocolVersion === 'string' \? params\.protocolVersion/)
  }
})

test('the supported list starts with the version the servers advertised before (2025-06-18)', () => {
  expect(SUPPORTED_PROTOCOLS[0]).toBe('2025-06-18')
  expect(SUPPORTED_PROTOCOLS).toContain('2025-03-26')
  expect(SUPPORTED_PROTOCOLS).toContain('2024-11-05')
})
