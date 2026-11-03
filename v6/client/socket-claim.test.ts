// Hook-socket claim across real processes (Codex c144c44 and claim-reap race):
// the probe/unlink/bind critical section is a kernel lock (SQLite BEGIN IMMEDIATE
// on <sock>.lock), released when the holder exits or is killed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const V6 = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until (path: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!existsSync(path)) { if (Date.now() > end) throw new Error(`missing ${path}`); await sleep(5) }
}

/** A child process that takes the lock and holds it until killed. */
async function holdLock (lockPath: string): Promise<ReturnType<typeof Bun.spawn>> {
  const ready = `${lockPath}.held-${Math.random().toString(36).slice(2)}`
  const p = Bun.spawn([process.execPath, '-e',
    `const { Database } = require('bun:sqlite'); const d = new Database(${JSON.stringify(lockPath)}, { create: true }); d.run('BEGIN IMMEDIATE'); require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`],
  { stdout: 'ignore', stderr: 'inherit' })
  await until(ready)
  return p
}

function bridgeChild (root: string, sock: string, role: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, `${root}/child.ts`], { env: { ...process.env, PROBE_ROLE: role, SOCK: sock }, stdout: 'ignore', stderr: 'inherit' })
}

function connectable (path: string): Promise<boolean> {
  return new Promise(resolve => {
    const c = require('node:net').connect(path)
    c.once('connect', () => { c.destroy(); resolve(true) })
    c.once('error', () => resolve(false))
  })
}

test('cross-process shutdown (Codex socket-stop race): an old server stopping never removes a new owner socket', { timeout: 30000 }, async () => {
  const root = setupCopy(false)
  // Scheduling barrier only: pause role A inside stop(), right after its listener closes.
  const file = `${root}/v6/client/bridge-base.ts`
  const code = readFileSync(file, 'utf8')
  const anchor = '      this.server?.stop()\n      this.ownsSocket = false\n'
  assert.ok(code.includes(anchor), 'stop barrier anchor present')
  writeFileSync(file, code.replace(anchor, `${anchor}      if (process.env.PROBE_ROLE === 'A') { writeFileSync(this.sockPath + '.stopping', ''); const t = Date.now(); while (!existsSync(this.sockPath + '.stop-go') && Date.now() - t < 20000) Bun.sleepSync(5) }\n`))
  writeFileSync(`${root}/child.ts`, readFileSync(`${root}/child.ts`, 'utf8').replace('await Bun.sleep(30000)',
    `if (process.env.PROBE_ROLE === 'A') { while (!require('node:fs').existsSync(process.env.SOCK + '.stop')) await Bun.sleep(5); b.stop(); process.exit(0) }
await Bun.sleep(30000)`))
  const sock = `${root}/hook.sock`
  const kids: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    const a = bridgeChild(root, sock, 'A'); kids.push(a)
    await until(`${sock}.started-A`)
    writeFileSync(`${sock}.stop`, '')
    await until(`${sock}.stopping`)
    kids.push(bridgeChild(root, sock, 'B'))
    await until(`${sock}.started-B`, 8000)
    assert.equal(JSON.parse(readFileSync(`${sock}.started-B`, 'utf8')).ownsSocket, false, 'B cannot bind while A is stopping under the lock')
    writeFileSync(`${sock}.stop-go`, '')
    await a.exited
    const end = Date.now() + 5000
    let live = false
    while (!live && Date.now() < end) { live = await connectable(sock); if (!live) await sleep(100) }
    assert.ok(live, 'B binds after A finished, and A cleanup did not remove it')
    await sleep(300)
    assert.ok(await connectable(sock), 'B socket still live')
  } finally {
    for (const k of kids) k.kill()
    await Promise.all(kids.map(k => k.exited))
    rmSync(root, { recursive: true, force: true })
  }
})

function setupCopy (barrier: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'vortex-claim-'))
  cpSync(V6, `${root}/v6`, { recursive: true, filter: src => !src.includes('/dist/') && !src.includes('node_modules') })
  if (barrier) {
    // Scheduling barrier only: pause role A inside the critical section, right after its socket probe.
    const file = `${root}/v6/client/bridge-base.ts`
    const code = readFileSync(file, 'utf8')
    const anchor = '          if (await this.socketLive()) { this.busy = true; return }'
    assert.ok(code.includes(anchor), 'barrier anchor present')
    writeFileSync(file, code.replace(anchor, `          const live = await this.socketLive()
          writeFileSync(this.sockPath + '.in-' + process.env.PROBE_ROLE, '')
          if (process.env.PROBE_ROLE === 'A') while (!existsSync(this.sockPath + '.a-go')) await Bun.sleep(5)
          if (live) { this.busy = true; return }`))
  }
  writeFileSync(`${root}/child.ts`, `import { Bridge } from './v6/plugins/claude/bridge.ts'
import { writeFileSync } from 'node:fs'
const b = new Bridge({ credential: { hub: 'ws://127.0.0.1:1', token: 'test' }, binding: 'race', socketPath: process.env.SOCK!, stateFile: process.env.SOCK + '.state-' + process.env.PROBE_ROLE, notify: async () => {}, hostPid: process.pid })
await b.start()
writeFileSync(process.env.SOCK + '.started-' + process.env.PROBE_ROLE, JSON.stringify({ busy: b.busy, ownsSocket: (b as any).ownsSocket }))
await Bun.sleep(30000)`)
  return root
}

test('cross-process: a second starter cannot enter while the first holds the critical section; the socket is never replaced', { timeout: 30000 }, async () => {
  const root = setupCopy(true)
  const sock = `${root}/hook.sock`
  writeFileSync(sock, '') // stale file from a crash
  const kids: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    kids.push(bridgeChild(root, sock, 'A'))
    await until(`${sock}.in-A`)
    kids.push(bridgeChild(root, sock, 'B'))
    await sleep(500)
    assert.equal(existsSync(`${sock}.in-B`), false, 'B never enters while A holds the lock')
    writeFileSync(`${sock}.a-go`, '')
    await until(`${sock}.started-A`)
    const inode = statSync(sock).ino
    await until(`${sock}.started-B`)
    const a = JSON.parse(readFileSync(`${sock}.started-A`, 'utf8'))
    const b = JSON.parse(readFileSync(`${sock}.started-B`, 'utf8'))
    assert.deepEqual(a, { busy: false, ownsSocket: true })
    assert.deepEqual(b, { busy: true, ownsSocket: false })
    assert.equal(statSync(sock).ino, inode, 'the winner socket was not replaced')
  } finally {
    for (const k of kids) k.kill()
    await Promise.all(kids.map(k => k.exited))
    rmSync(root, { recursive: true, force: true })
  }
})

test('cross-process: a holder killed inside the critical section releases the lock; a live holder is waited for, never reported busy', { timeout: 30000 }, async () => {
  const root = setupCopy(false)
  const kids: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    // Killed holder: the kernel releases its lock.
    const s1 = `${root}/killed.sock`
    writeFileSync(s1, '')
    const dead = await holdLock(`${s1}.lock`)
    dead.kill('SIGKILL'); await dead.exited
    const t0 = Date.now()
    kids.push(bridgeChild(root, s1, 'K'))
    await until(`${s1}.started-K`)
    assert.deepEqual(JSON.parse(readFileSync(`${s1}.started-K`, 'utf8')), { busy: false, ownsSocket: true })
    assert.ok(Date.now() - t0 < 5000)
    // Live holder: no bind and no busy until it lets go, then the background retry binds.
    const s2 = `${root}/held.sock`
    writeFileSync(s2, '')
    const holder = await holdLock(`${s2}.lock`)
    kids.push(holder)
    kids.push(bridgeChild(root, s2, 'L'))
    await until(`${s2}.started-L`, 8000)
    assert.deepEqual(JSON.parse(readFileSync(`${s2}.started-L`, 'utf8')), { busy: false, ownsSocket: false })
    holder.kill('SIGKILL'); await holder.exited
    const end = Date.now() + 5000
    let bound = false
    while (!bound && Date.now() < end) {
      bound = await new Promise<boolean>(resolve => {
        const c = require('node:net').connect(s2)
        c.once('connect', () => { c.destroy(); resolve(true) })
        c.once('error', () => resolve(false))
      })
      if (!bound) await sleep(100)
    }
    assert.ok(bound, 'bound by the background retry after the holder exited')
  } finally {
    for (const k of kids) k.kill()
    await Promise.all(kids.map(k => k.exited))
    rmSync(root, { recursive: true, force: true })
  }
})
