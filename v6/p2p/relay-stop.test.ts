// Invictus QA on #3 (F6): relay.stop() closes the admission handle even when
// node.stop() rejects. The handle is observed through a wrapper on hubAdmission
// (a file-descriptor count cannot show it: SQLite shares one descriptor per
// file across connections in the same process).
import { test, mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import * as admission from './admission.ts'

test('F6: the admission handle closes even when node.stop() rejects, and the rejection propagates', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-f6-'))
  const dbPath = join(dir, 'hub.db')
  const seed = new Database(dbPath)
  seed.run('CREATE TABLE principal_keys (key_id TEXT)')
  seed.close()
  const realHubAdmission = admission.hubAdmission
  let closed = 0
  mock.module('./admission.ts', () => ({
    ...admission,
    hubAdmission: (p: string) => {
      const a = realHubAdmission(p)
      return { ...a, close: () => { closed++; a.close() } }
    }
  }))
  try {
    const { startRelay } = await import('./relay.ts')
    const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: dbPath, revocationSweepMs: 0 })
    const realStop = relay.node.stop.bind(relay.node)
    ;(relay.node as { stop: () => Promise<void> }).stop = async () => { throw new Error('node stop failed') }
    try {
      await assert.rejects(relay.stop(), /node stop failed/)
      assert.equal(closed, 1, 'the admission handle must close even though node.stop rejected')
    } finally {
      await realStop()
    }
  } finally {
    mock.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})
