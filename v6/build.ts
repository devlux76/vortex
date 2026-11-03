// A3 (§8.15): bundle each plugin into its own dist/ so a copied or cached
// install needs no sibling tree. Run with `bun run v6:build`; dist/ is committed.
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '')

const targets: Array<{ plugin: string; entries: Record<string, string> }> = [
  { plugin: 'claude', entries: { 'server.js': 'plugins/claude/server.ts', 'vx.js': 'cli/vx.ts' } },
  { plugin: 'codex', entries: { 'server.js': 'plugins/codex/server.ts', 'vx.js': 'cli/vx.ts' } },
  { plugin: 'opencode', entries: { 'server.js': 'plugins/opencode/server.ts', 'ready.js': 'plugins/opencode/ready.ts' } },
]

let failed = false
for (const { plugin, entries } of targets) {
  const outdir = `${ROOT}/plugins/${plugin}/dist`
  rmSync(outdir, { recursive: true, force: true })
  for (const [out, entry] of Object.entries(entries)) {
    const result = await Bun.build({
      entrypoints: [`${ROOT}/${entry}`],
      outdir,
      naming: out,
      target: 'bun',
      format: 'esm',
      minify: false,
      sourcemap: 'none',
    })
    if (!result.success) {
      failed = true
      for (const log of result.logs) console.error(String(log))
    } else console.log(`plugins/${plugin}/dist/${out}`)
  }
}
if (failed) process.exit(1)
