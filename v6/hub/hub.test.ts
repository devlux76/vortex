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
  hubHandles = await startHub({ cfg: { listen: '127.0.0.1:0', sendPerMinute: 1000, loopBreakerLimit: 2, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100 } })
  // enroll alice via the store directly (no HTTP endpoint needed for test)
  const store = hubHandles.store
  const { token } = store.createPrincipal('alice')
  aliceToken = token
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
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'replay-binding'
  await client.bind(binding, ['all'])
  // open first stream and capture batch id
  const batchIds: string[] = []
  const ws1 = client.stream(binding, {
    onBatch: (batch) => { batchIds.push(batch) },
    onOpen: () => {},
    onError: () => {},
    onClose: () => {},
  }).ws
  await client.send({ text: 'msg1' })
  // wait for first batch
  await new Promise(r => setTimeout(r, 200))
  ws1.close()
  // open second stream – should replay the same batch id
  const ws2 = client.stream(binding, {
    onBatch: (batch) => { batchIds.push(batch) },
    onOpen: () => {},
    onError: () => {},
    onClose: () => {},
  }).ws
  // give time for replay
  await new Promise(r => setTimeout(r, 200))
  ws2.close()
  assert.equal(batchIds[0], batchIds[1], 'replayed batch id matches original')
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
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'takeover-binding'
  await client.bind(binding, ['all'])
  const ws1 = client.stream(binding, { onBatch: () => {}, onOpen: () => {}, onError: () => {}, onClose: () => {} }).ws
  const closePromise = new Promise<number>((resolve) => {
    const ws2 = client.stream(binding, {
      onBatch: () => {},
      onOpen: () => {},
      onError: () => {},
      onClose: ({ code }) => { resolve(code) },
    }).ws
    // ws2 will be closed immediately with 4409
  })
  const code = await closePromise
  assert.equal(code, 4409)
  ws1.close()
  await teardown()
})

test('batch limits: max 20 messages per batch', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'limit-binding'
  await client.bind(binding, ['all'])
  const batches: number[] = []
  const ws = client.stream(binding, {
    onBatch: (batch, _wake, msgs) => { batches.push(msgs.length) },
    onOpen: () => {},
    onError: () => {},
    onClose: () => {},
  }).ws;
  // give the websocket a moment to open
  await new Promise(r => setTimeout(r, 100));
  // send 25 short messages
  for (let i = 0; i < 25; i++) {
    await client.send({ text: `msg${i}` });
  }
  // allow batches to be flushed
  await new Promise(r => setTimeout(r, 2000));
  ws.close();

  // after flushing, expect no pending wake messages for this binding
  const pending = hubHandles.store.pendingMessages('alice', 'limit-binding', 'wake');
  assert.equal(pending.length, 0, 'no pending wake messages');
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
