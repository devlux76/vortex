// vx uninstall <principal>: remove that agent's local files on this machine —
// its credential and the per-binding state the plugins keep — so an uninstall
// leaves nothing behind (docs/v6-proposal.md acceptance table, "clean
// uninstall"). The hub's own files and other principals' files are never touched.
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PRINCIPAL_RE } from '../hub/config.ts'

// operator.json and hub.json share the credential naming scheme
const RESERVED = new Set(['operator', 'hub'])
const STATE_SUFFIXES = ['.batches.json', '.turns.json', '.unused.json']

function matching (dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(keep).map(name => join(dir, name))
}

export function uninstallFiles (principal: string, roots: { config: string, state: string }): string[] {
  if (!PRINCIPAL_RE.test(principal) || RESERVED.has(principal)) {
    throw new Error(`not an agent principal: ${JSON.stringify(principal)}`)
  }
  const prefix = `${principal}-`
  const files = [
    ...matching(roots.config, name =>
      name === `${principal}.json` ||
      (principal === 'codex' && name.startsWith('codex-thread-') && name.endsWith('.json'))),
    ...matching(roots.state, name =>
      name.startsWith(prefix) && STATE_SUFFIXES.some(s => name.endsWith(s))),
  ].sort()
  for (const f of files) rmSync(f, { force: true })
  return files
}
