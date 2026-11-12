import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('plugins build and run standalone checks from a checkout containing spaces and URL-reserved characters', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'vortex-build-path-'))
  const root = join(temp, 'checkout with space # % 雪', 'v6')
  try {
    cpSync(fileURLToPath(new URL('./', import.meta.url)), root, { recursive: true })
    // Run from the checkout root, as `bun v6/build.ts` is run, so the bundles'
    // cwd-relative source comments match the committed ones.
    const proc = Bun.spawn([process.execPath, join(root, 'build.ts')], { cwd: join(root, '..'), stdout: 'ignore', stderr: 'pipe' })
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    assert.equal(code, 0, err)
    for (const [plugin, files] of [
      ['claude', ['server.js', 'vx.js']], ['codex', ['server.js', 'vx.js']],
      ['opencode', ['server.js', 'ready.js']], ['qoder', ['server.js']],
    ] as const) {
      for (const file of files) {
        const built = readFileSync(join(root, 'plugins', plugin, 'dist', file))
        assert.ok(built.length > 0)
        // The committed bundle is what hosts install (A3, §8.15): it must be
        // exactly what the current sources build, or a fix never ships.
        const committed = readFileSync(fileURLToPath(new URL(`./plugins/${plugin}/dist/${file}`, import.meta.url)))
        assert.ok(built.equals(committed), `v6/plugins/${plugin}/dist/${file} is stale; run bun v6/build.ts and commit the result`)
      }
    }
    const checks = Bun.spawn([process.execPath, 'test', join(root, 'plugins', 'bundle.test.ts')], { stdout: 'ignore', stderr: 'pipe' })
    const [checked, errors] = await Promise.all([checks.exited, new Response(checks.stderr).text()])
    assert.equal(checked, 0, errors)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
