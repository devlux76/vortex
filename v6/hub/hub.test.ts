// Engine-level hub tests (spec §8.11). Uses the in‑process hub via startHub() and real HTTP+WS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHub } from '../hub/main.ts'
import { VortexClient } from '../client/client.ts'
import { loadCredential, saveCredential } from '../client/credential.ts'
import { logLine } from '../client/render.ts'
import { ulid } from '../client/ulid.ts'
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs'

let hubHandles: any
let aliceToken: string
let bobToken: string
let operatorToken: string

async function setup () {
  // Use temporary directories for isolation
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stateTmp = mkdtempSync(`${tmpdir()}/vortex-state-`)
  const configTmp = mkdtempSync(`${tmpdir()}/vortex-config-`)
  process.env.XDG_STATE_HOME = stateTmp
  process.env.XDG_CONFIG_HOME = configTmp
  // Ensure a clean state – delete any prior DB and config if they exist
  const { hubRoots } = await import('../hub/config.ts')
  const roots = hubRoots()
  const { existsSync, unlinkSync, rmSync } = await import('node:fs')
  if (existsSync(roots.db)) unlinkSync(roots.db)
  if (existsSync(roots.state)) rmSync(roots.state, { recursive: true })
  if (existsSync(roots.config)) rmSync(roots.config, { recursive: true })


  // assign a random free port to avoid collisions
  hubHandles = await startHub({ cfg: { listen: '127.0.0.1:0', sendPerMinute: 1000, loopBreakerLimit: 2, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100, bodyMaxBytes: 20000 } })
  // enroll alice via the store directly (no HTTP endpoint needed for test)
  const store = hubHandles.store
  const { token } = store.createPrincipal('alice')
  aliceToken = token
  bobToken = store.createPrincipal('bob').token
  // read operator token – if the credential file was not created (operator existed from previous DB), create it now.
  const { operatorCredentialPath } = (await import('../hub/config.ts')).hubRoots()
  let opCred: any
  if (existsSync(operatorCredentialPath)) {
    opCred = JSON.parse(readFileSync(operatorCredentialPath, 'utf8'))
  } else {
    const { token } = hubHandles.store.createPrincipalUnchecked('operator')
    opCred = { principal: 'operator', token }
  }
  operatorToken = opCred.token
}

async function teardown () {
  await hubHandles.stop()
  // Clean temporary directories
  const { rmSync } = await import('node:fs')
  if (process.env.XDG_STATE_HOME) rmSync(process.env.XDG_STATE_HOME as string, { recursive: true })
  if (process.env.XDG_CONFIG_HOME) rmSync(process.env.XDG_CONFIG_HOME as string, { recursive: true })
  delete process.env.XDG_STATE_HOME
  delete process.env.XDG_CONFIG_HOME
}

interface TestFrame { batch: string; wake: boolean; messages: any[]; notices: string[] }
async function openFrames (c: VortexClient, binding: string) {
  const frames: TestFrame[] = []
  const waiters: Array<() => void> = []
  let consumed = 0
  let resolveClosed!: (n: number) => void
  const closed = new Promise<number>(r => { resolveClosed = r })
  let resolveOpen!: () => void
  const opened = new Promise<void>(r => { resolveOpen = r })
  const { ws } = c.stream(binding, {
    onBatch: (batch, wake, messages, notices) => { frames.push({ batch, wake, messages, notices }); waiters.splice(0).forEach(w => w()) },
    onOpen: () => resolveOpen(),
    onClose: ({ code }) => resolveClosed(code),
  })
  await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error('ws open timeout')), 3000))])
  const next = async (ms = 3000): Promise<TestFrame> => {
    const deadline = Date.now() + ms
    while (frames.length <= consumed) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('timed out waiting for batch frame')
      await Promise.race([new Promise<void>(r => waiters.push(r)), new Promise(r => setTimeout(r, left))])
    }
    return frames[consumed++]
  }
  return { ws, frames, next, closed }
}

test('setup and teardown', async () => {
  await setup()
  await teardown()
})

test('sender assignment from token', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const { id, seq } = await client.send({ text: 'hello' })
  assert.ok(id && typeof id === 'string')
  assert.ok(seq >= 0)
  await teardown()
})

test('operator impersonation rejected (from field)', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: operatorToken })
  // send a body with a spurious from field (using raw fetch because client hides it)
  const res = await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'alice', text: 'spam' }),
  })
  assert.equal(res.status, 400)
  await teardown()
})

test('escaped single‑message rejection before storage (413)', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  // 5000+ bytes with two‑byte chars to overflow bytes but stay under code points
  const txt = '✔'.repeat(3000) // each ✔ = 3 bytes, total 9000 > default 8KiB (8192)
  const res = await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: txt }),
  })
  assert.equal(res.status, 413)
  await teardown()
})

test('at‑least‑once replay after reconnect (same batch id)', async t => {
  await setup()
  const alice = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const bob = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: bobToken })
  const binding = 'replay-binding'
  await bob.bind(binding, ['all'])
  const first = await openFrames(bob, binding)
  await alice.send({ text: 'msg1', to: ['bob'] })
  const b1 = await first.next()
  assert.deepEqual(b1.messages.map(m => m.text), ['msg1'])
  // close without acknowledging, then reconnect
  first.ws.close()
  await first.closed
  const second = await openFrames(bob, binding)
  const b2 = await second.next()
  assert.equal(b2.batch, b1.batch, 'replayed batch id matches original')
  assert.deepEqual(b2.messages.map(m => m.text), ['msg1'])
  // after the ack it is gone: a third connection replays nothing
  bob.delivered(second.ws, b2.batch, 'host-accepted')
  await new Promise(r => setTimeout(r, 100))
  second.ws.close()
  await second.closed
  const third = await openFrames(bob, binding)
  await new Promise(r => setTimeout(r, 150))
  assert.equal(third.frames.length, 0, 'acknowledged batch is not replayed')
  third.ws.close()
  await teardown()
})

test('second stream on same binding returns 4409', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'dup-binding'
  await client.bind(binding, ['all'])
  const ws1 = client.stream(binding, { onBatch: () => {}, onOpen: () => {}, onError: () => {}, onClose: () => {} }).ws
  const closePromise = new Promise<number>((resolve) => {
    const ws2 = client.stream(binding, {
      onBatch: () => {},
      onOpen: () => {},
      onError: () => {},
      onClose: ({ code }) => { resolve(code) },
    }).ws
    // ws2 will be closed by hub with 4409
  })
  const code = await closePromise
  assert.equal(code, 4409)
  ws1.close()
  await teardown()
})

test('late ack after takeover rejected', async t => {
  await setup()
  const alice = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const bob = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: bobToken })
  const opClient = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: operatorToken })
  const binding = 'takeover-binding'
  await bob.bind(binding, ['all'])
  const s1 = await openFrames(bob, binding)
  await alice.send({ text: 'msg1', to: ['bob'] })
  const b1 = await s1.next()
  // operator release is the only takeover: the old stream is closed 4409
  assert.ok((await opClient.release('bob', binding)).ok)
  assert.equal(await s1.closed, 4409)
  const s2 = await openFrames(bob, binding)
  const b2 = await s2.next()
  assert.equal(b2.batch, b1.batch, 'takeover replays the same batch')

  // Engine level: an acknowledgment from the superseded connection is
  // rejected and cannot consume the replacement binding's work.
  const sent: any[] = []
  const stale = { send: (f: any) => { sent.push(f) }, close: (c: number) => { sent.push({ closed: c }) } }
  const accepted = hubHandles.delivery.handleDelivered(stale, 'bob', binding, b2.batch, 'host-accepted')
  assert.equal(accepted, false)
  assert.ok(sent.some(f => f.type === 'error' && /stale/.test(f.reason)), 'stale ack gets an error frame')
  assert.equal(hubHandles.store.pendingMessages('bob', binding, 'wake').length, 1, 'stale ack consumed nothing')

  // The current owner's ack works and clears the work.
  bob.delivered(s2.ws, b2.batch, 'host-accepted')
  await new Promise(r => setTimeout(r, 150))
  assert.equal(hubHandles.store.pendingMessages('bob', binding, 'wake').length, 0, 'pending cleared by the new owner')
  s2.ws.close()
  await teardown()
})

test('batch limits: max 20 messages per batch', async t => {
  await setup()
  const alice = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const bob = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: bobToken })
  const binding = 'limit-binding'
  await bob.bind(binding, ['all'])
  // 25 passive messages (to nobody), pulled by bob
  for (let i = 0; i < 25; i++) await alice.send({ text: `msg${i}` })
  const s = await openFrames(bob, binding)
  bob.pull(s.ws)
  const first = await s.next()
  assert.equal(first.messages.length, 20, 'a batch holds at most 20 messages')
  assert.equal(first.wake, false)
  bob.delivered(s.ws, first.batch, 'hook-returned')
  await new Promise(r => setTimeout(r, 100))
  bob.pull(s.ws)
  const second = await s.next()
  assert.deepEqual(second.messages.map(m => m.text), ['msg20', 'msg21', 'msg22', 'msg23', 'msg24'])
  bob.delivered(s.ws, second.batch, 'hook-returned')
  await new Promise(r => setTimeout(r, 100))
  assert.equal(hubHandles.store.pendingMessages('bob', binding, 'passive').length, 0)
  s.ws.close()
  await teardown()
});

test('loop breaker pauses after limit and resumes on operator message', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'loop'
  await client.bind(binding, ['all'])
  const ws = client.stream(binding, { onBatch: () => {}, onOpen: () => {}, onError: () => {}, onClose: () => {} }).ws
  // send enough automatic messages to hit loopBreakerLimit (2)
  await client.send({ text: 'a' })
  await client.send({ text: 'b' })
  // next automatic message should be paused; status API should show paused conversation
  const status = await client.status()
  const paused = status.pausedConversations.find((c:any) => c.conv.includes('room:all'))
  assert.ok(paused, 'conversation paused')
  // send operator message to resume
  const opClient = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: operatorToken })
  await opClient.send({ text: 'operator resume', scope: 'room', room: 'all' })
  const status2 = await client.status()
  const paused2 = status2.pausedConversations.find((c:any) => c.conv.includes('room:all'))
  assert.ok(!paused2, 'conversation resumed')
  ws.close()
  await teardown()
})
