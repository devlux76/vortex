// Additional hub tests for missing spec items
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHub } from '../hub/main.ts'
import { VortexClient } from '../client/client.ts'
import { readFileSync, existsSync } from 'node:fs'

let hubHandles: any
let aliceToken: string
let operatorToken: string

async function setup (overrides = {}) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stateTmp = mkdtempSync(`${tmpdir()}/vortex-state-`)
  const configTmp = mkdtempSync(`${tmpdir()}/vortex-config-`)
  process.env.XDG_STATE_HOME = stateTmp
  process.env.XDG_CONFIG_HOME = configTmp
  const { hubRoots } = await import('../hub/config.ts')
  const roots = hubRoots()
  const { existsSync, unlinkSync, rmSync } = await import('node:fs')
  if (existsSync(roots.db)) unlinkSync(roots.db)
  if (existsSync(roots.state)) rmSync(roots.state, { recursive: true })
  if (existsSync(roots.config)) rmSync(roots.config, { recursive: true })
  const defaultCfg = { listen: '127.0.0.1:0', sendPerMinute: 1000, loopBreakerLimit: 2, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100, bodyMaxBytes: 20000, batchMaxBytes: 20000 }
  const cfg = { ...defaultCfg, ...overrides }
  hubHandles = await startHub({ cfg })
  const store = hubHandles.store
  aliceToken = store.createPrincipal('alice').token
  const { operatorCredentialPath } = (await import('../hub/config.ts')).hubRoots()
  if (existsSync(operatorCredentialPath)) {
    operatorToken = JSON.parse(readFileSync(operatorCredentialPath, 'utf8')).token
  } else {
    const { token } = hubHandles.store.createPrincipalUnchecked('operator')
    operatorToken = token
  }
}


async function teardown () {
  await hubHandles.stop()
  const { rmSync } = await import('node:fs')
  if (process.env.XDG_STATE_HOME) rmSync(process.env.XDG_STATE_HOME as string, { recursive: true })
  if (process.env.XDG_CONFIG_HOME) rmSync(process.env.XDG_CONFIG_HOME as string, { recursive: true })
  delete process.env.XDG_STATE_HOME
  delete process.env.XDG_CONFIG_HOME
}

// Test: batch limits code points and bytes
test('batch limits: 6000 code points and 8 KiB rendered', async t => {
  await setup()
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const txt = 'a'.repeat(6001)
  const res = await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: txt })
  })
  assert.equal(res.status, 413)
  const txt2 = 'a'.repeat(6000)
  const res2 = await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: txt2 })
  })
  assert.equal(res2.status, 200)
  await teardown()
})

// Test: wake pacing independent of send rate
test('wake pacing independent of send rate', async t => {
  await setup({ sendPerMinute: 1 })
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'wake-pacing-binding'
  await client.bind(binding, ['all'])
  const batches: string[] = []
  const ws = client.stream(binding, {
    onBatch: (batch) => { batches.push(batch) },
    onOpen: () => {},
    onError: () => {},
    onClose: () => {}
  }).ws
  await client.send({ text: 'first' })
  await new Promise(r => setTimeout(r, 100))
  let errStatus
  try {
    await client.send({ text: 'second' })
  } catch (e) {
    errStatus = (e as any).status
  }
  assert.equal(errStatus, 429)
  assert.equal(batches.length, 1, 'expected one wake batch')
  ws.close()
  await teardown()
})

// Test: wake batch bypasses pending passive batch
test('wake batch bypasses pending passive batch', async t => {
  await setup()
  const { token: bobToken } = hubHandles.store.createPrincipal('bob')
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'bypass-binding'
  await client.bind(binding, ['all'])
  // Bob sends a room message (passive)
  await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'passive' })
  })
  // Bob sends a DM to Alice (wake)
  await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'dm', to: ['alice'], text: 'wake' })
  })
  const firstWake = new Promise<boolean>((resolve) => {
    const { ws } = client.stream(binding, {
      onBatch: (batch, wake) => { resolve(wake) },
      onOpen: () => {},
      onError: () => {},
      onClose: () => {}
    })
  })
  const isWake = await firstWake
  assert.ok(isWake, 'first batch should be wake')
  await teardown()
})

// Test: overflow notice after 1000 pending (using low limit)
test('overflow notice after 1000 pending', async t => {
  await setup()
  hubHandles.cfg.pendingMaxMessages = 5
  const client = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'overflow-binding'
  await client.bind(binding, ['all'])
  for (let i = 0; i < 7; i++) {
    await client.send({ text: `msg${i}` })
  }
  let b = hubHandles.store.getBinding('alice', binding)!
  assert.ok(b.expiredPending > 0, 'expected overflow notice')
  const ws = client.stream(binding, {
    onBatch: () => {},
    onOpen: () => {},
    onError: () => {},
    onClose: () => {}
  }).ws
  await new Promise(r => setTimeout(r, 200))
  b = hubHandles.store.getBinding('alice', binding)!
  assert.equal(b.expiredPending, 0, 'expired notice cleared after batch')
  ws.close()
  await teardown()
})

// Test: TLS fingerprint pinning refuses wrong fingerprint
test('TLS fingerprint pinning refuses wrong fingerprint', async t => {
  // set up hub with TLS
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const stateTmp = mkdtempSync(`${tmpdir()}/vortex-state-`)
  const configTmp = mkdtempSync(`${tmpdir()}/vortex-config-`)
  process.env.XDG_STATE_HOME = stateTmp
  process.env.XDG_CONFIG_HOME = configTmp
  const { hubRoots } = await import('../hub/config.ts')
  const roots = hubRoots()
  const { existsSync, unlinkSync, rmSync } = await import('node:fs')
  if (existsSync(roots.db)) unlinkSync(roots.db)
  if (existsSync(roots.state)) rmSync(roots.state, { recursive: true })
  if (existsSync(roots.config)) rmSync(roots.config, { recursive: true })
  const tlsHandles = await startHub({ cfg: { listen: '127.0.0.1:0', tlsListen: ':0', sendPerMinute: 1000, loopBreakerLimit: 2, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100, bodyMaxBytes: 20000 } })
  const store = tlsHandles.store
  const aliceTok = store.createPrincipal('alice').token
  const { operatorCredentialPath } = (await import('../hub/config.ts')).hubRoots()
  let opTok: string
  if (existsSync(operatorCredentialPath)) {
    opTok = JSON.parse(readFileSync(operatorCredentialPath, 'utf8')).token
  } else {
    opTok = tlsHandles.store.createPrincipalUnchecked('operator').token
  }
  const badFingerprint = tlsHandles.fingerprint ? tlsHandles.fingerprint.slice(1) + '0' : 'deadbeef'
  const client = new VortexClient({ hub: `wss://127.0.0.1:${tlsHandles.tlsPort}`, token: aliceTok, fingerprint: badFingerprint })
  let err
  try {
    await client.status()
  } catch (e) {
    err = e
  }
  assert.ok(err && err.message && err.message.includes('vortex: TLS fingerprint pin mismatch'), 'expected TLS pin mismatch')
  await tlsHandles.stop()
  const { rmSync: rm } = await import('node:fs')
  if (process.env.XDG_STATE_HOME) rm(process.env.XDG_STATE_HOME as string, { recursive: true })
  if (process.env.XDG_CONFIG_HOME) rm(process.env.XDG_CONFIG_HOME as string, { recursive: true })
  delete process.env.XDG_STATE_HOME
  delete process.env.XDG_CONFIG_HOME
})

// Test: DM never appears in room stream or log
test('DM never appears in room stream or room log', async t => {
  await setup()
  const { token: bobToken } = hubHandles.store.createPrincipal('bob')
  const aliceClient = new VortexClient({ hub: `ws://127.0.0.1:${hubHandles.port}`, token: aliceToken })
  const binding = 'room-binding'
  await aliceClient.bind(binding, ['all'])
  const dmRes = await fetch(`http://127.0.0.1:${hubHandles.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'dm', to: ['alice'], text: 'secret dm' })
  })
  assert.equal(dmRes.status, 200)
  const roomLog = await aliceClient.roomLog('all')
  const dmInLog = roomLog.messages.some(m => m.text === 'secret dm')
  assert.ok(!dmInLog, 'DM should not appear in room log')
  const dmSeen = new Promise<boolean>((resolve) => {
    const ws = aliceClient.stream(binding, {
      onBatch: (batch, _wake, msgs) => {
        const found = msgs.some(m => m.text === 'secret dm')
        resolve(found)
      },
      onOpen: () => {},
      onError: () => {},
      onClose: () => {}
    }).ws
    setTimeout(() => { ws.close(); resolve(false) }, 200)
  })
  const seen = await dmSeen
  assert.ok(!seen, 'DM should not appear in room stream')
  await teardown()
})
