// Acceptance test for the v6 criterion "one install command per harness"
// (docs/v6-proposal.md acceptance table: setup takes several steps per harness).
// On the hub host, `vx install <principal>` replaces "enroll, copy the printed
// token into <principal>.json by hand".
import { test, expect, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubStore } from '../hub/store.ts'
import { installPrincipal } from './install.ts'

let config = ''
let state = ''

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'vx-install-'))
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  process.env.XDG_STATE_HOME = join(root, 'state')
  config = join(root, 'config', 'vortex')
  state = join(root, 'state', 'vortex')
  mkdirSync(state, { recursive: true })
  new HubStore(join(state, 'hub.db')).close() // the hub has run once on this host
})

test('enrolls the principal and writes its credential file (0600) with the local hub address', async () => {
  const result = await installPrincipal('codex')
  const path = join(config, 'codex.json')
  expect(result.credentialPath).toBe(path)
  const cred = JSON.parse(readFileSync(path, 'utf8'))
  expect(cred.hub).toBe('ws://127.0.0.1:7900')
  expect(cred.principal).toBe('codex')
  expect(typeof cred.token).toBe('string')
  expect(cred.token.length).toBeGreaterThan(20)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // the token works: the hub knows it as codex
  const store = new HubStore(join(state, 'hub.db'))
  expect(store.verifyToken(cred.token)).toBe('codex')
  store.close()
})

test('uses the configured listen port from hub.json', async () => {
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'hub.json'), JSON.stringify({ listen: '127.0.0.1:7910' }))
  await installPrincipal('claude')
  expect(JSON.parse(readFileSync(join(config, 'claude.json'), 'utf8')).hub).toBe('ws://127.0.0.1:7910')
})

test('refuses: an existing credential (never overwritten), reserved or invalid names, no hub database', async () => {
  await installPrincipal('opencode')
  const before = readFileSync(join(config, 'opencode.json'), 'utf8')
  await expect(installPrincipal('opencode')).rejects.toThrow()
  expect(readFileSync(join(config, 'opencode.json'), 'utf8')).toBe(before)
  for (const bad of ['operator', 'hub', 'Bad', '']) await expect(installPrincipal(bad)).rejects.toThrow()
  process.env.XDG_STATE_HOME = join(state, 'nowhere')
  await expect(installPrincipal('other')).rejects.toThrow(/hub database/)
  expect(existsSync(join(config, 'other.json'))).toBe(false)
})
