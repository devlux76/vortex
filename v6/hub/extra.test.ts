// Hub tests for the remaining §8.11 items. Three principals are enrolled
// because the hub never delivers a sender's own messages to its own bindings
// (§8.2): alice sends, bob binds/streams/receives, carol is a bystander.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startHub, type HubHandles } from '../hub/main.ts'
import { hubRoots } from '../hub/config.ts'
import { VortexClient, type WireApiMessage } from '../client/client.ts'
import { fitSingle, measure, renderBatch, DEFAULT_BOUNDS } from '../client/render.ts'

interface Env { hub: HubHandles; url: string; tokens: Record<string, string>; client: (who: string) => VortexClient; stop: () => Promise<void> }

async function setup (overrides: Record<string, unknown> = {}): Promise<Env> {
  const stateTmp = mkdtempSync(`${tmpdir()}/vortex-state-`)
  const configTmp = mkdtempSync(`${tmpdir()}/vortex-config-`)
  process.env.XDG_STATE_HOME = stateTmp
  process.env.XDG_CONFIG_HOME = configTmp
  const cfg = { listen: '127.0.0.1:0', sendPerMinute: 1000, loopBreakerLimit: 100, wakeCoalesceMs: 10, wakeMinIntervalMs: 20, wakeHourlyLimit: 100, bodyMaxBytes: 20000, ...overrides }
  const hub = await startHub({ cfg: cfg as any })
  const tokens: Record<string, string> = {}
  for (const n of ['alice', 'bob', 'carol']) tokens[n] = hub.store.createPrincipal(n).token
  const opPath = hubRoots().operatorCredentialPath
  tokens.operator = JSON.parse(readFileSync(opPath, 'utf8')).token
  const url = `ws://127.0.0.1:${hub.port}`
  return {
    hub, url, tokens,
    client: who => new VortexClient({ hub: url, token: tokens[who] }),
    stop: async () => {
      await hub.stop()
      rmSync(stateTmp, { recursive: true, force: true })
      rmSync(configTmp, { recursive: true, force: true })
      delete process.env.XDG_STATE_HOME
      delete process.env.XDG_CONFIG_HOME
    },
  }
}

interface Frame { batch: string; wake: boolean; messages: WireApiMessage[]; notices: string[]; at: number }
interface Stream { ws: WebSocket; frames: Frame[]; next: (ms?: number) => Promise<Frame>; none: (ms: number) => Promise<void>; closed: Promise<number> }

/** Open a binding stream and await the real open event; frames queue for `next`. */
async function openStream (client: VortexClient, binding: string): Promise<Stream> {
  const frames: Frame[] = []
  const waiters: Array<() => void> = []
  let consumed = 0
  let resolveClosed!: (c: number) => void
  const closed = new Promise<number>(r => { resolveClosed = r })
  let resolveOpen!: () => void
  const opened = new Promise<void>(r => { resolveOpen = r })
  const { ws } = client.stream(binding, {
    onBatch: (batch, wake, messages, notices) => { frames.push({ batch, wake, messages, notices, at: Date.now() }); waiters.splice(0).forEach(w => w()) },
    onOpen: () => resolveOpen(),
    onClose: ({ code }) => resolveClosed(code),
  })
  await Promise.race([opened, closed.then(c => { throw new Error(`stream closed ${c} before open`) }), timeout(3000, 'ws open')])
  const next = async (ms = 3000): Promise<Frame> => {
    const deadline = Date.now() + ms
    while (frames.length <= consumed) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for batch frame (${ms} ms)`)
      await Promise.race([new Promise<void>(r => waiters.push(r)), sleep(left)])
    }
    return frames[consumed++]
  }
  const none = async (ms: number): Promise<void> => {
    await sleep(ms)
    assert.equal(frames.length, consumed, 'unexpected batch frame arrived')
  }
  return { ws, frames, next, none, closed }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function timeout (ms: number, what: string): Promise<never> {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms))
}

async function post (env: Env, who: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${env.hub.port}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.tokens[who]}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Largest n such that n copies of ch fit the rendered bounds for alice's room post. */
function maxFit (ch: string, bounds = DEFAULT_BOUNDS): number {
  const fits = (n: number) => fitSingle({ id: 'x', seq: 0, ts: 0, from: 'alice', scope: 'room', room: 'all', to: [], text: ch.repeat(n), human: false }, bounds).fits
  let lo = 1
  let hi = 20000
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid; else hi = mid - 1
  }
  return lo
}

test('batch limits: 6000 code points and 8 KiB rendered', async () => {
  const env = await setup()
  try {
    // Code point bound: 'a' is 1 byte, so the 6000 code point limit binds first
    // and the rendered wrapper (peer-data line, header, tags) counts against it.
    const nA = maxFit('a')
    assert.ok(nA < 6000, `wrapper must count toward the bound (fit ${nA})`)
    assert.equal((await post(env, 'alice', { text: 'a'.repeat(nA) })).status, 200)
    const over = await post(env, 'alice', { text: 'a'.repeat(nA + 1) })
    assert.equal(over.status, 413)
    assert.match(((await over.json()) as any).error, /rendered/)
    // Byte bound: 3-byte characters hit 8 KiB long before 6000 code points.
    const nB = maxFit('✔')
    assert.ok(nB < 6000 && nB * 3 < 8192, `byte bound should bind (fit ${nB})`)
    assert.equal((await post(env, 'alice', { text: '✔'.repeat(nB) })).status, 200)
    assert.equal((await post(env, 'alice', { text: '✔'.repeat(nB + 1) })).status, 413)
    // Escaping expands '<' to '&lt;': a body under every raw limit is refused.
    const nE = maxFit('<')
    assert.equal((await post(env, 'alice', { text: '<'.repeat(nE + 1) })).status, 413)
    // 413s were rejected before storage: only the two accepted posts exist.
    assert.equal(env.hub.store.seqHead(), 2)

    // Delivered batches never exceed the bounds even when several large
    // messages queue: each batch is measured as actually rendered.
    const bob = env.client('bob')
    await bob.bind('b1', ['all'])
    const s = await openStream(bob, 'b1')
    const big = 'x'.repeat(2500)
    for (let i = 0; i < 4; i++) assert.equal((await post(env, 'alice', { text: big + i, to: ['bob'] })).status, 200)
    const seen: string[] = []
    while (seen.length < 4) {
      const f = await s.next()
      const m = measure({ batch: f.batch, scope: 'room', room: 'all', notices: f.notices, messages: f.messages }, DEFAULT_BOUNDS)
      assert.ok(m.fits, `delivered batch exceeded bounds: ${m.codePoints} cp / ${m.bytes} B`)
      for (const msg of f.messages) seen.push(msg.text)
      bob.delivered(s.ws, f.batch, 'host-accepted')
    }
    assert.deepEqual(seen.map(t => t.slice(-1)), ['0', '1', '2', '3'])
    // 4 x ~2500 cp cannot share one 6000 cp batch.
    assert.ok(s.frames.length >= 2, 'large messages must split across batches')
    s.ws.close()
  } finally { await env.stop() }
})

test('wake pacing independent of send rate', async () => {
  // (a) the send limiter is a separate gate: 429 stores nothing.
  const limited = await setup({ sendPerMinute: 1 })
  try {
    assert.equal((await post(limited, 'alice', { text: 'one', to: ['bob'] })).status, 200)
    assert.equal((await post(limited, 'alice', { text: 'two', to: ['bob'] })).status, 429)
    assert.equal(limited.hub.store.seqHead(), 1)
  } finally { await limited.stop() }

  // (b) with the send limiter wide open, wake delivery is still paced:
  // coalesce window, minimum interval between wakes, hourly budget.
  const env = await setup({ wakeCoalesceMs: 150, wakeMinIntervalMs: 600, wakeHourlyLimit: 2 })
  try {
    const bob = env.client('bob')
    await bob.bind('p1', ['all'])
    const s = await openStream(bob, 'p1')
    for (let i = 0; i < 3; i++) assert.equal((await post(env, 'alice', { text: `burst${i}`, to: ['bob'] })).status, 200)
    const first = await s.next()
    assert.ok(first.wake)
    assert.deepEqual(first.messages.map(m => m.text), ['burst0', 'burst1', 'burst2'], 'burst coalesced into one wake')
    bob.delivered(s.ws, first.batch, 'host-accepted')
    // next wake: acked slot is free but the 600 ms interval is not
    await post(env, 'alice', { text: 'second', to: ['bob'] })
    await s.none(300)
    const second = await s.next()
    assert.ok(second.at - first.at >= 590, `wakes spaced >= minInterval (${second.at - first.at} ms)`)
    assert.deepEqual(second.messages.map(m => m.text), ['second'])
    bob.delivered(s.ws, second.batch, 'host-accepted')
    // hourly budget (2) is spent: the third wake waits and status shows it
    await post(env, 'alice', { text: 'third', to: ['bob'] })
    await s.none(900)
    const st = await bob.status()
    assert.equal(st.bindings.find((b: any) => b.name === 'p1').waitingWake, 1)
    s.ws.close()
  } finally { await env.stop() }
})

test('wake batch bypasses pending passive batch', async () => {
  const env = await setup()
  try {
    const bob = env.client('bob')
    await bob.bind('w1', ['all'])
    // passive backlog first, then a wake, all before any stream exists
    await post(env, 'alice', { text: 'passive-1' })
    await post(env, 'alice', { text: 'passive-2', to: ['carol'] })
    await post(env, 'alice', { text: 'wake-1', to: ['bob'] })
    const s = await openStream(bob, 'w1')
    const wake = await s.next()
    assert.ok(wake.wake, 'first batch is the wake')
    assert.deepEqual(wake.messages.map(m => m.text), ['wake-1'], 'wake does not drain the passive backlog')
    // passive arrives only on pull, and stays outstanding unacknowledged
    bob.pull(s.ws)
    const passive = await s.next()
    assert.equal(passive.wake, false)
    assert.deepEqual(passive.messages.map(m => m.text), ['passive-1', 'passive-2'])
    // a new wake is pushed while the passive batch is still unacknowledged
    await post(env, 'alice', { text: 'wake-2', to: ['bob'] })
    bob.delivered(s.ws, wake.batch, 'host-accepted')
    const wake2 = await s.next()
    assert.ok(wake2.wake)
    assert.deepEqual(wake2.messages.map(m => m.text), ['wake-2'])
    // acking the wake never consumed the passive batch, and vice versa
    assert.equal(env.hub.store.pendingMessages('bob', 'w1', 'passive').length, 2)
    bob.delivered(s.ws, passive.batch, 'hook-returned')
    await sleep(100)
    assert.equal(env.hub.store.pendingMessages('bob', 'w1', 'passive').length, 0)
    assert.equal(env.hub.store.pendingMessages('bob', 'w1', 'wake').length, 1, 'wake-2 still pending')
    s.ws.close()
  } finally { await env.stop() }
})

test('overflow notice after 1000 pending', async () => {
  // The 1000 / 4 MiB bound is configurable; shrink it so the test is small.
  const env = await setup({ pendingMaxMessages: 5 })
  try {
    const bob = env.client('bob')
    await bob.bind('o1', ['all'])
    for (let i = 0; i < 8; i++) assert.equal((await post(env, 'alice', { text: `msg${i}` })).status, 200)
    assert.equal(env.hub.store.pendingStats('bob', 'o1').count, 5)
    assert.equal(env.hub.store.getBinding('bob', 'o1')!.expiredPending, 3)
    const s = await openStream(bob, 'o1')
    bob.pull(s.ws)
    const f = await s.next()
    assert.deepEqual(f.notices, ['[vx: 3 older messages expired; vx log all]'])
    assert.deepEqual(f.messages.map(m => m.text), ['msg3', 'msg4', 'msg5', 'msg6', 'msg7'], 'oldest dropped, order kept')
    const rendered = renderBatch({ batch: f.batch, scope: 'room', room: 'all', notices: f.notices, messages: f.messages })
    assert.equal(rendered.split('\n')[1], '[vx: 3 older messages expired; vx log all]')
    // the notice is one-shot: cleared once the batch exists
    assert.equal(env.hub.store.getBinding('bob', 'o1')!.expiredPending, 0)
    // and it is replayed with the same batch on reconnect
    s.ws.close()
    await s.closed
    const s2 = await openStream(bob, 'o1')
    const again = await s2.next()
    assert.equal(again.batch, f.batch)
    assert.deepEqual(again.notices, f.notices)
    s2.ws.close()
  } finally { await env.stop() }
})

test('TLS fingerprint pinning refuses wrong fingerprint', async () => {
  const env = await setup({ tlsListen: '127.0.0.1:0' })
  try {
    const fp = env.hub.fingerprint!
    assert.match(fp, /^[0-9a-f]{64}$/)
    const wss = `wss://127.0.0.1:${env.hub.tlsPort}`
    const bad = fp.slice(1) + (fp[0] === '0' ? '1' : '0')
    const wrong = new VortexClient({ hub: wss, token: env.tokens.bob, fingerprint: bad })
    await assert.rejects(wrong.status(), /TLS fingerprint pin mismatch/)
    await assert.rejects(wrong.pin(), /TLS fingerprint pin mismatch/)
    assert.throws(() => wrong.stream('x', { onBatch: () => {} }), /pin/)
    // the correct pin works for HTTP and for a real wss stream
    const good = new VortexClient({ hub: wss, token: env.tokens.bob, fingerprint: fp.toUpperCase().match(/../g)!.join(':') })
    const st = await good.status()
    assert.ok(Array.isArray(st.bindings))
    await good.bind('t1', ['all'])
    await post(env, 'alice', { text: 'over tls', to: ['bob'] })
    const s = await openStream(good, 't1')
    const f = await s.next()
    assert.deepEqual(f.messages.map(m => m.text), ['over tls'])
    s.ws.close()
    // a certificate without the pin is not trusted at all
    const unpinned = new VortexClient({ hub: wss, token: env.tokens.bob })
    await assert.rejects(unpinned.status())
    assert.ok(existsSync(`${hubRoots().state}/cert.pem`))
  } finally { await env.stop() }
})

test('DM never appears in room stream or room log', async () => {
  const env = await setup()
  try {
    const bob = env.client('bob')
    const carol = env.client('carol')
    await bob.bind('d1', ['all'])
    await carol.bind('d1', ['all'])
    const sb = await openStream(bob, 'd1')
    const sc = await openStream(carol, 'd1')
    const dm = await post(env, 'alice', { scope: 'dm', to: ['bob'], text: 'secret dm' })
    assert.equal(dm.status, 200)
    // marker room post proves carol's stream is live and ordered after the DM
    assert.equal((await post(env, 'alice', { text: 'public marker', to: ['carol'] })).status, 200)
    // bob (the recipient) gets the DM as a DM-scoped wake batch
    const fb = await sb.next()
    assert.deepEqual(fb.messages.map(m => [m.text, m.scope, m.room]), [['secret dm', 'dm', undefined]])
    assert.ok(fb.wake)
    // carol sees only the room marker, never the DM
    const fc = await sc.next()
    assert.deepEqual(fc.messages.map(m => m.text), ['public marker'])
    bob.pull(sb.ws)
    carol.pull(sc.ws)
    await sc.none(200)
    for (const f of sc.frames) assert.ok(!f.messages.some(m => m.text === 'secret dm'))
    // room logs (carol member, bob member, operator) never contain the DM
    for (const who of ['carol', 'bob', 'operator']) {
      const res = await fetch(`http://127.0.0.1:${env.hub.port}/v1/rooms/all/log`, { headers: { authorization: `Bearer ${env.tokens[who]}` } })
      assert.equal(res.status, 200)
      const log = (await res.json() as any).messages as WireApiMessage[]
      assert.deepEqual(log.map(m => m.text), ['public marker'], `${who} room log`)
    }
    // carol cannot read the DM through recent or the operator DM log either
    const recent = await env.client('carol').recent()
    assert.ok(!recent.messages.some(m => m.text === 'secret dm'))
    await assert.rejects(env.client('carol').dmLog(), /403/)
    // and cannot reply into it
    const id = (await (await post(env, 'alice', { scope: 'dm', to: ['bob'], text: 'again' })).json() as any).id
    assert.equal((await post(env, 'carol', { scope: 'dm', to: ['alice'], text: 'peek', reply_to: id })).status, 403)
    sb.ws.close(); sc.ws.close()
  } finally { await env.stop() }
})

test('send is crash-atomic: failed recipient enqueue stores nothing', async () => {
  const env = await setup()
  try {
    const bob = env.client('bob')
    const carol = env.client('carol')
    await bob.bind('o1', ['all'])
    await carol.bind('c1', ['all'])
    const store = env.hub.store as any
    const real = store.enqueuePending.bind(store)
    // Simulate a crash mid-fan-out: bob's row is written, then carol's fails.
    store.enqueuePending = (p: string, b: string, m: unknown, k: 'wake' | 'passive') => {
      if (p === 'carol') throw new Error('simulated crash during enqueue')
      return real(p, b, m, k)
    }
    const head = store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages').get().m as number
    const failed = await post(env, 'alice', { text: 'lost?', to: ['bob'] })
    assert.equal(failed.status, 500)
    assert.equal(env.hub.store.pendingStats('bob', 'o1').count, 0, 'bob row rolled back with the message')
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text = 'lost?'").get().c, 0, 'no orphan message')
    store.enqueuePending = real
    const ok = await post(env, 'alice', { text: 'kept', to: ['bob'] })
    assert.equal(ok.status, 200)
    const { seq } = await ok.json() as { seq: number }
    assert.equal(seq, head + 1, 'seq not consumed by the rolled-back send')
    assert.equal(env.hub.store.pendingStats('bob', 'o1').count, 1)
    assert.equal(env.hub.store.pendingStats('carol', 'c1').count, 1)
  } finally { await env.stop() }
})
