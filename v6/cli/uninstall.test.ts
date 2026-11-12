// Acceptance test for the v6 criterion "clean uninstall" (docs/v6-proposal.md
// acceptance table: uninstall leaves credential and batch-state files).
import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uninstallFiles } from './uninstall.ts'

function fixture () {
  const root = mkdtempSync(join(tmpdir(), 'vx-uninstall-'))
  const config = join(root, 'config', 'vortex')
  const state = join(root, 'state', 'vortex')
  mkdirSync(config, { recursive: true })
  mkdirSync(state, { recursive: true })
  const files = [
    join(config, 'codex.json'),
    join(config, 'codex-thread-default.json'),
    join(state, 'codex-default.batches.json'),
    join(state, 'codex-default.turns.json'),
    join(state, 'codex-work.batches.json'),
    // must survive: other principals, the hub's own files, look-alike names
    join(config, 'claude.json'),
    join(config, 'codex2.json'),
    join(config, 'operator.json'),
    join(config, 'hub.json'),
    join(state, 'hub.db'),
    join(state, 'claude-default.batches.json'),
    join(state, 'opencode-x.unused.json'),
  ]
  for (const f of files) writeFileSync(f, '{}')
  return { roots: { config, state }, files }
}

test('removes exactly the principal\'s credential, thread binding and state files', () => {
  const { roots, files } = fixture()
  const removed = uninstallFiles('codex', roots)
  expect(removed).toEqual([...files.slice(0, 5)].sort())
  for (const f of files.slice(0, 5)) expect(existsSync(f)).toBe(false)
  for (const f of files.slice(5)) expect(existsSync(f)).toBe(true)
})

test('is idempotent and tolerates missing directories', () => {
  const { roots } = fixture()
  uninstallFiles('codex', roots)
  expect(uninstallFiles('codex', roots)).toEqual([])
  expect(uninstallFiles('codex', { config: '/nonexistent/vx/config', state: '/nonexistent/vx/state' })).toEqual([])
})

test('claude and opencode state files go with their principal', () => {
  const { roots } = fixture()
  expect(uninstallFiles('claude', roots).map(p => p.split('/').pop())).toEqual(['claude.json', 'claude-default.batches.json']) // sorted by full path: config/ before state/
  expect(uninstallFiles('opencode', roots).map(p => p.split('/').pop())).toEqual(['opencode-x.unused.json'])
})

test('refuses names that are not principals (never deletes operator or hub files)', () => {
  const { roots } = fixture()
  for (const bad of ['operator', 'hub', '', '../x', 'Codex']) expect(() => uninstallFiles(bad, roots)).toThrow()
})
