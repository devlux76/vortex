// Amendment A4 (docs/v6-amendment-a4-pacing.md, bug:e79eb06): automatic
// cooldown, LRS fairness, persistent rolling wake budget. Small injected
// timings; real hub over loopback HTTP+WS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { startHub, type HubHandles } from './main.ts'
import { VortexClient, type WireApiMessage } from '../client/client.ts'

const BASE = { listen: '127.0.0.1:0', sendPerMinute: 10_000, bodyMaxBytes: 20000, wakeCoalesceMs: 5, wakeMinIntervalMs: 0, wakeHourlyLimit: 10_000, loopBreakerLimit: 3, cooldownBaseMs: 300, cooldownMaxMs: 1200, cooldownDecayMs: 600 }

interface Env { hub: HubHandles; dir: string; tokens: Record<string, string>; cfg: Record<string, unknown>; client: (w: string) => VortexClient; restart: () => Promise<void>; stop: () => Promise<void> }

async function setup (over: Record<string, unknown> = {}, dir?: string): Promise<Env> {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'vx-pacing-'))
  const cfg = { ...BASE, ...over }
  const start = () => startHub({ stateDir: join(root, 'state'), configDir: join(root, 'config'), cfg: cfg as any })
  const env: Env = {
    hub: await start(), dir: root, tokens: {}, cfg,
    client: w => new VortexClient({ hub: `ws://127.0.0.1:${env.hub.port}`, token: env.tokens[w] }),
    restart: async () => { await env.hub.stop(); env.hub = await start() },
    stop: async () => { await env.hub.stop(); rmSync(root, { recursive: true, force: true }) },
  }
  for (const n of ['alice', 'bob', 'carol']) {
    try { env.tokens[n] = env.hub.store.createPrincipal(n).token } catch { /* reused dir */ }
  }
  const op = Bun.file(join(root, 'config', 'vortex', 'operator.json'))
  env.tokens.operator = (await op.json()).token
  return env
}

interface Frame { batch: string; wake: boolean; messages: WireApiMessage[]; notices: string[]; at: number }

/** bob's auto-acking stream: every batch is acknowledged at once (host-accepted). */
async function stream (env: Env, who = 'bob', binding = 'o1', ack = true) {
  const c = env.client(who)
  await c.bind(binding, ['all'])
  const frames: Frame[] = []
  let ws!: WebSocket
  let empties = 0
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('stream open timeout')), 3000)
    ws = c.stream(binding, {
      onOpen: () => { clearTimeout(t); resolve() },
      onBatch: (batch, wake, messages, notices) => {
        frames.push({ batch, wake, messages, notices, at: Date.now() })
        if (ack) c.delivered(ws, batch, 'host-accepted')
      },
    }).ws
    ws.addEventListener('message', ev => { try { if (JSON.parse(String(ev.data)).type === 'empty') empties++ } catch {} })
  })
  return { c, ws, frames, texts: (wake?: boolean) => frames.filter(f => wake === undefined || f.wake === wake).flatMap(f => f.messages.map(m => m.text)), empties: () => empties, close: () => ws.close() }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until (pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5) }
}
async function post (env: Env, who: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${env.hub.port}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${env.tokens[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
const dm = (env: Env, from: string, to: string, text: string) => post(env, from, { scope: 'dm', to: [to], text })
const conv = (a: string, b: string) => `dm:${[a, b].sort().join('|')}`
const row = (env: Env, c: string) => env.hub.store.conversationRow(c)!

test('A4-1 no-traffic expiry releases held addressed mail as one wake; never passive before', async () => {
  const env = await setup()
  const bob = await stream(env)
  try {
    for (const t of ['m1', 'm2']) { assert.equal((await dm(env, 'alice', 'bob', t)).status, 200); await until(() => bob.texts(true).includes(t)) }
    assert.equal((await dm(env, 'alice', 'bob', 'm3')).status, 200) // reaches T=3 → cooling
    const entered = Date.now()
    await dm(env, 'alice', 'bob', 'm4'); await dm(env, 'alice', 'bob', 'm5')
    assert.ok(row(env, conv('alice', 'bob')).coolingUntil! > Date.now())
    bob.c.pull(bob.ws) // held rows are wake rows: a passive pull must not see them
    await until(() => bob.empties() > 0, 2000, 'empty passive reply')
    await sleep(150)
    assert.deepEqual(bob.texts(), ['m1', 'm2'], 'nothing released early')
    await until(() => bob.texts().includes('m5'), 3000, 'release at expiry')
    const release = bob.frames[bob.frames.length - 1]
    assert.equal(release.wake, true)
    assert.deepEqual(release.messages.map(m => m.text), ['m3', 'm4', 'm5'], 'one wake batch, FIFO')
    assert.ok(release.at - entered >= 280, `released after cooldown (${release.at - entered} ms)`)
    assert.ok(release.notices.some(n => n.includes('cooled down')), 'per-binding notice rides the release batch')
  } finally { bob.close(); await env.stop() }
})

test('A4-2 passive mail during and after cooldown never wakes', async () => {
  const env = await setup()
  const bob = await stream(env)
  try {
    for (let i = 0; i < 3; i++) await post(env, 'alice', { text: `room-auto-${i}` }) // unaddressed room posts; room conv reaches T
    await sleep(500) // spans the cooldown
    await post(env, 'alice', { text: 'room-after' })
    await sleep(100)
    assert.equal(bob.frames.filter(f => f.wake).length, 0, 'zero wake batches for passive mail')
    bob.c.pull(bob.ws)
    await until(() => bob.texts(false).includes('room-after'))
  } finally { bob.close(); await env.stop() }
})

async function reachThreshold (env: Env, bob: Awaited<ReturnType<typeof stream>>, tag: string): Promise<number> {
  for (let i = 1; i <= 3; i++) assert.equal((await dm(env, 'alice', 'bob', `${tag}-${i}`)).status, 200)
  const r = row(env, conv('alice', 'bob'))
  assert.ok(r.coolingUntil !== null && r.coolingUntil > Date.now(), `${tag}: cooling`)
  return r.coolingUntil! - Date.now()
}
const drained = (env: Env) => env.hub.store.pendingCountByKind('bob', 'o1').wake === 0

test('A4-3 backoff: C_base first, doubling to cap; forced silence never decays; genuine idle decays', async () => {
  const env = await setup()
  const bob = await stream(env)
  try {
    const c1 = await reachThreshold(env, bob, 'a'); assert.ok(c1 > 200 && c1 <= 300, `first entry is C_base (${c1})`)
    assert.equal(row(env, conv('alice', 'bob')).level, 1)
    await until(() => row(env, conv('alice', 'bob')).coolingUntil === null && drained(env), 2000, 'expiry 1')
    const c2 = await reachThreshold(env, bob, 'b'); assert.ok(c2 > 500 && c2 <= 600, `doubles (${c2})`)
    await until(() => row(env, conv('alice', 'bob')).coolingUntil === null && drained(env), 2000, 'expiry 2')
    const c3 = await reachThreshold(env, bob, 'c'); assert.ok(c3 > 1100 && c3 <= 1200, `capped (${c3})`)
    // Forced silence: nothing is sent during the 1.2 s capped cooldown (> D = 0.6 s).
    await until(() => row(env, conv('alice', 'bob')).coolingUntil === null && drained(env), 3000, 'expiry 3')
    const c4 = await reachThreshold(env, bob, 'd'); assert.ok(c4 > 1100, `forced silence did not decay (${c4})`)
    assert.equal(row(env, conv('alice', 'bob')).level, 4)
    await until(() => row(env, conv('alice', 'bob')).coolingUntil === null && drained(env), 3000, 'expiry 4')
    await sleep(700) // genuine quiet ≥ D after release and drain
    const c5 = await reachThreshold(env, bob, 'e'); assert.ok(c5 > 200 && c5 <= 300, `genuine idle decays to C_base (${c5})`)
    assert.equal(row(env, conv('alice', 'bob')).level, 1)
  } finally { bob.close(); await env.stop() }
})

test('A4-3b held work blocks decay even after D', async () => {
  const env = await setup()
  try {
    // bob is bound but not connected: released rows stay pending (undelivered work).
    await env.client('bob').bind('o1', ['all'])
    for (let i = 1; i <= 3; i++) await dm(env, 'alice', 'bob', `h-${i}`)
    assert.equal(row(env, conv('alice', 'bob')).level, 1)
    await until(() => row(env, conv('alice', 'bob')).coolingUntil === null || row(env, conv('alice', 'bob')).coolingUntil! < Date.now(), 2000)
    await sleep(700)
    for (let i = 4; i <= 6; i++) await dm(env, 'alice', 'bob', `h-${i}`)
    assert.equal(row(env, conv('alice', 'bob')).level, 2, 'pending wake rows are not quiet')
  } finally { await env.stop() }
})

test('A4-4 operator override ends cooldown; peer human_turn does not; other conversations unaffected', async () => {
  const env = await setup({ cooldownBaseMs: 5000, cooldownMaxMs: 5000 })
  const bob = await stream(env)
  try {
    for (let i = 1; i <= 3; i++) await post(env, 'alice', { text: `r${i}`, to: ['bob'] }) // addressed room posts → room:all cooling
    await dm(env, 'carol', 'bob', 'carol-dm') // other conversation
    await until(() => bob.texts(true).includes('carol-dm'), 2000, 'other conversation unaffected')
    assert.ok(row(env, 'room:all').coolingUntil! > Date.now())
    assert.equal((await post(env, 'alice', { text: 'r4', to: ['bob'], human_turn: true })).status, 200)
    assert.ok(row(env, 'room:all').coolingUntil! > Date.now(), 'peer human_turn does not reset')
    await sleep(100); assert.ok(!bob.texts().includes('r3'), 'still held')
    assert.equal((await post(env, 'operator', { text: 'resume', scope: 'room', room: 'all' })).status, 200)
    await until(() => bob.texts().includes('r4'), 2000, 'operator override releases at once')
    const r = row(env, 'room:all'); assert.equal(r.coolingUntil, null); assert.equal(r.level, 0); assert.equal(r.count, 0)
  } finally { bob.close(); await env.stop() }
})

test('A4-5 fairness: a cooling conversation never blocks another; LRS serves Y within 2 pushes of an X backlog', async () => {
  const env = await setup({ loopBreakerLimit: 10_000 })
  try {
    await env.client('bob').bind('o1', ['all']) // bound, not yet streaming: the backlog accumulates
    for (let i = 0; i < 60; i++) await dm(env, 'alice', 'bob', `x${i}`)
    await dm(env, 'carol', 'bob', 'y0')
    const bob = await stream(env)
    try {
      await until(() => bob.texts().includes('y0') && bob.texts().length === 61, 3000, 'all delivered')
      const firstY = bob.frames.findIndex(f => f.messages.some(m => m.text === 'y0'))
      assert.ok(firstY <= 1, `Y served in push ${firstY + 1}`)
      assert.ok(bob.frames.every(f => f.messages.length <= 20), 'batch bound')
      assert.deepEqual(bob.texts().filter(t => t.startsWith('x')), Array.from({ length: 60 }, (_, i) => `x${i}`), 'X order preserved')
    } finally { bob.close() }
  } finally { await env.stop() }
})

test('A4-6 rolling budget: non-default limit > 60 is honoured; exhaustion waits then recovers; replay costs no permit', async () => {
  const env = await setup({ loopBreakerLimit: 10_000, wakeHourlyLimit: 70, wakeWindowMs: 800 })
  const bob = await stream(env)
  try {
    for (let i = 0; i < 70; i++) { await dm(env, 'alice', 'bob', `b${i}`); await until(() => bob.texts().includes(`b${i}`), 2000, `push ${i}`) }
    assert.equal(bob.frames.length, 70, '70 permits used, beyond any fixed 60')
    const t0 = Date.now()
    await dm(env, 'alice', 'bob', 'over')
    await sleep(100)
    assert.ok(!bob.texts().includes('over'), 'over budget waits')
    const st = await env.client('bob').status()
    const b = st.bindings.find((x: any) => x.name === 'o1')
    assert.ok(typeof b.eligibleAt === 'number' && b.eligibleAt > Date.now(), 'status shows eligibleAt')
    await until(() => bob.texts().includes('over'), 3000, 'recovers when the window frees')
    assert.ok(Date.now() - t0 < 1500)
  } finally { bob.close(); await env.stop() }
})

test('A4-6b replaying an outstanding batch consumes no permit', async () => {
  const env = await setup({ loopBreakerLimit: 10_000 })
  try {
    const s1 = await stream(env, 'bob', 'o1', false) // no ack: the batch stays outstanding
    await dm(env, 'alice', 'bob', 'once')
    await until(() => s1.frames.length === 1)
    const before = env.hub.store.wakePushCount('bob', 'o1', 0)
    s1.close(); await sleep(50)
    const s2 = await stream(env, 'bob', 'o1', true)
    await until(() => s2.frames.length >= 1)
    assert.equal(s2.frames[0].batch, s1.frames[0].batch, 'same batch replayed')
    assert.equal(env.hub.store.wakePushCount('bob', 'o1', 0), before, 'no new permit')
    s2.close()
  } finally { await env.stop() }
})

test('A4-7 restart: cooldown and budget persist, expired-while-down releases, migration is idempotent', async () => {
  const env = await setup({ cooldownBaseMs: 800, cooldownMaxMs: 800, wakeHourlyLimit: 2, wakeWindowMs: 60_000, loopBreakerLimit: 3 })
  try {
    // Budget: two pushes used before restart.
    let bob = await stream(env)
    await dm(env, 'carol', 'bob', 'p1'); await until(() => bob.texts().includes('p1'))
    await dm(env, 'carol', 'bob', 'p2'); await until(() => bob.texts().includes('p2'))
    // Cooldown: alice reaches T (her rows are held, and over budget anyway).
    for (let i = 1; i <= 3; i++) await dm(env, 'alice', 'bob', `c${i}`)
    const until1 = row(env, conv('alice', 'bob')).coolingUntil!
    bob.close()
    await env.restart()
    assert.equal(row(env, conv('alice', 'bob')).coolingUntil, until1, 'cooldown persisted')
    bob = await stream(env)
    await sleep(100)
    assert.equal(bob.frames.length, 0, 'budget not reset by restart (limit 2 already used)')
    const st = await env.client('bob').status()
    assert.ok(st.bindings.find((x: any) => x.name === 'o1').eligibleAt > Date.now())
    bob.close()
    // Migration idempotence: an old-style paused row migrates once.
    await env.hub.stop()
    const db = new Database(join(env.dir, 'state', 'vortex', 'hub.db'))
    db.run(`INSERT INTO conversations (conv, auto_count, paused, notice_pending) VALUES ('room:legacy', 12, 1, 1)
            ON CONFLICT(conv) DO UPDATE SET paused = 1`)
    db.close()
    env.hub = await startHub({ stateDir: join(env.dir, 'state'), configDir: join(env.dir, 'config'), cfg: env.cfg as any })
    const m1 = row(env, 'room:legacy')
    assert.ok(m1.coolingUntil !== null && m1.level === 1, 'legacy pause migrated to a cooldown')
    await env.restart()
    assert.equal(row(env, 'room:legacy').coolingUntil, m1.coolingUntil, 'second restart does not re-apply')
  } finally { await env.stop() }
})

test('A4-7b a cooldown that expired while the hub was down releases right after startup', async () => {
  const env = await setup({ cooldownBaseMs: 300 })
  try {
    await env.client('bob').bind('o1', ['all'])
    for (let i = 1; i <= 3; i++) await dm(env, 'alice', 'bob', `d${i}`)
    await env.hub.stop()
    await sleep(500)
    env.hub = await startHub({ stateDir: join(env.dir, 'state'), configDir: join(env.dir, 'config'), cfg: env.cfg as any })
    assert.equal(row(env, conv('alice', 'bob')).coolingUntil, null, 'expired at startup')
    const bob = await stream(env)
    await until(() => bob.texts().includes('d3'), 2000, 'released after startup')
    assert.equal(bob.texts().filter(t => t === 'd3').length, 1, 'no duplicate')
    bob.close()
  } finally { await env.stop() }
})

test('A4-8 burst bound: held backlog releases in ≤20-message batches at the minimum interval', async () => {
  const env = await setup({ cooldownBaseMs: 200, cooldownMaxMs: 200, wakeMinIntervalMs: 100, loopBreakerLimit: 3 })
  const bob = await stream(env)
  try {
    for (let i = 0; i < 45; i++) await dm(env, 'alice', 'bob', `k${i}`)
    await until(() => bob.texts().length === 45, 4000, 'all released')
    assert.ok(bob.frames.every(f => f.messages.length <= 20))
    for (let i = 1; i < bob.frames.length; i++) assert.ok(bob.frames[i].at - bob.frames[i - 1].at >= 90, 'min interval between wakes')
  } finally { bob.close(); await env.stop() }
})

test('A4-9 crash atomicity: failure entering cooldown stores neither the message nor the cooldown', async () => {
  const env = await setup()
  try {
    await dm(env, 'alice', 'bob', 'z1'); await dm(env, 'alice', 'bob', 'z2')
    const store = env.hub.store as any
    const real = store.recordCooldownNotices.bind(store)
    store.recordCooldownNotices = () => { throw new Error('simulated crash entering cooldown') }
    assert.equal((await dm(env, 'alice', 'bob', 'z3')).status, 500)
    store.recordCooldownNotices = real
    const r = row(env, conv('alice', 'bob'))
    assert.equal(r.count, 2); assert.equal(r.coolingUntil, null); assert.equal(r.level, 0)
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text = 'z3'").get().c, 0)
  } finally { await env.stop() }
})

test('A4-10 inline expiry by a new message releases held rows on EVERY binding (not only the new recipient)', async () => {
  const env = await setup({ cooldownBaseMs: 300 })
  const bob = await stream(env, 'bob', 'o1')
  const alice = await stream(env, 'alice', 'a1')
  try {
    for (const t of ['s1', 's2']) { await dm(env, 'alice', 'bob', t); await until(() => bob.texts().includes(t)) }
    await dm(env, 'alice', 'bob', 's3') // T=3 → cooling; s3 held in bob/o1
    const d = env.hub.delivery as any
    clearTimeout(d.coolingTimer); d.coolingTimer = undefined; d.coolingAt = undefined // the expiry timer has not fired yet
    await sleep(400) // past cooling_until
    assert.ok(!bob.texts().includes('s3'), 'still held (timer suppressed)')
    await dm(env, 'bob', 'alice', 'reply') // inline expiry happens on bob's message, recipient is alice
    await until(() => alice.texts().includes('reply'), 2000, 'reply to alice')
    await until(() => bob.texts().includes('s3'), 2000, "bob's held row released by the inline expiry")
  } finally { bob.close(); alice.close(); await env.stop() }
})

test('A4-11 operator DM reply resets exactly its REFERENCED direct conversation and releases its held rows', async () => {
  const env = await setup({ cooldownBaseMs: 60_000, cooldownMaxMs: 60_000 })
  const bob = await stream(env)
  try {
    let original = ''
    for (let i = 0; i < 3; i++) original = (await (await dm(env, 'alice', 'bob', `a${i}`)).json() as { id: string }).id
    for (let i = 0; i < 3; i++) await dm(env, 'carol', 'bob', `c${i}`)
    assert.ok(row(env, conv('alice', 'bob')).coolingUntil! > Date.now())
    assert.ok(row(env, conv('bob', 'carol')).coolingUntil! > Date.now())
    // A peer's human_turn reply never resets (self-reported).
    assert.equal((await post(env, 'bob', { scope: 'dm', to: ['alice'], reply_to: original, text: 'peer', human_turn: true })).status, 200)
    assert.ok(row(env, conv('alice', 'bob')).coolingUntil! > Date.now(), 'peer human_turn does not reset')
    const held = bob.texts()
    assert.equal((await post(env, 'operator', { scope: 'dm', to: ['alice'], reply_to: original, text: 'resume this exchange' })).status, 200)
    const target = row(env, conv('alice', 'bob'))
    assert.equal(target.coolingUntil, null, 'referenced DM conversation reset')
    assert.equal(target.level, 0); assert.equal(target.count, 0)
    assert.ok(row(env, conv('bob', 'carol')).coolingUntil! > Date.now(), 'unrelated pair still cooling')
    await until(() => bob.texts().length > held.length && bob.texts().some(t => t.startsWith('a')), 2000, "bob's held alice rows released")
    assert.ok(!bob.texts().includes('c2'), 'carol rows still held')
  } finally { bob.close(); await env.stop() }
})
