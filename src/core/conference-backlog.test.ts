import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNodeTransport } from '../net/node.ts'
import { VortexService } from './service.ts'
import type { Embedder } from '../types.ts'
import { makeProfile } from '../embed/profile.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until (check: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(50)
  }
}

const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64, truncation: 'tail',
  pooling: 'mean', normalization: 'l2', dims: [8, 4, 2], encoding: 'float32le', version: 1,
  tolerance: 0.001, thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
const table: Record<string, Float32Array> = {
  base: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]),
  exact: Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0]),
  tier8: Float32Array.from([1, 0.2, 0, 0, 1, 0.3, 0, 0])
}
const fakeEmbedder = (): Embedder => ({
  profile: () => profile,
  embed: async (text: string): Promise<Float32Array> => {
    const found = table[text]
    if (found === undefined) throw new Error(`unknown statement: ${text}`)
    return found
  }
} as Embedder)

test('late joiner receives retained history as backlog', { timeout: 60000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start()
    const infoB = await sb.start()
    const infoC = await sc.start()
    await sa.dial(infoB.addrs[0])
    await sa.dial(infoC.addrs[0])
    await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'A' })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'B' })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    await sc.joinConference({ session: 'c', ref: a.id })
    await sleep(500)
    const msgs = sc.core().read(0).events.filter(e => e.kind === 'conference_message')
    assert.ok(msgs.some(m => m.body === 'A' && m.backlog === true), 'A backlog')
    assert.ok(msgs.some(m => m.body === 'B' && m.backlog === true), 'B backlog')
    void infoA; void infoB; void infoC
  } finally {
    await sc.stop(); await sb.stop(); await sa.stop()
  }
})

test('late joiner sees a gap when history is truncated', { timeout: 60000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder(), conferences: { historyLimit: 2 } })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start()
    const infoB = await sb.start()
    const infoC = await sc.start()
    await sa.dial(infoB.addrs[0])
    await sa.dial(infoC.addrs[0])
    await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    for (const t of ['1','2','3','4']) await sa.postToConference({ session: 'a', conference: a.id, text: t })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    await sc.joinConference({ session: 'c', ref: a.id })
    await sleep(500)
    const events = sc.core().read(0).events
    const gap = events.find(e => e.type === 'vortex.history-gap')
    assert.ok(gap, 'gap event present')
    assert.match(gap.body ?? '', /2 earlier messages are not retained/)
    const msgs = events.filter(e => e.kind === 'conference_message' && e.backlog === true && e.body !== undefined && ['3','4'].includes(e.body))
    assert.equal(msgs.length, 2)
    void infoA; void infoB; void infoC
  } finally {
    await sc.stop(); await sb.stop(); await sa.stop()
  }
})
test('joiner inbox orders retained history before live messages', { timeout: 60000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start(); const infoB = await sb.start(); const infoC = await sc.start()
    await sa.dial(infoB.addrs[0]); await sa.dial(infoC.addrs[0]); await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'A' })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'B' })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    await sc.joinConference({ session: 'c', ref: a.id })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'C' })
    await sleep(1000)
    const msgs = sc.core().read(0).events.filter(e => e.kind === 'conference_message').map(e => e.body)
    const idxA = msgs.indexOf('A'); const idxB = msgs.indexOf('B'); const idxC = msgs.indexOf('C')
    assert.ok(idxA >= 0 && idxB >= 0 && idxC >= 0)
    assert.ok(idxA < idxC && idxB < idxC, 'history before live')
    void infoA; void infoB; void infoC
  } finally { await sc.stop(); await sb.stop(); await sa.stop() }
})

test('history fetch failure keeps join succeeding with unavailable notice', { timeout: 60000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start(); const infoB = await sb.start(); const infoC = await sc.start()
    await sa.dial(infoB.addrs[0]); await sa.dial(infoC.addrs[0]); await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'A' })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    // seam: make history() reject
    const engine = (sc as any).conferences
    const origHistory = engine.history.bind(engine)
    engine.history = async () => { throw new Error('boom') }
    let info: any
    try {
      info = await sc.joinConference({ session: 'c', ref: a.id })
    } finally {
      engine.history = origHistory
    }
    assert.ok(info, 'join succeeded')
    await sleep(500)
    const events = sc.core().read(0).events
    const unavail = events.find(e => e.type === 'vortex.history-unavailable')
    assert.ok(unavail, 'history-unavailable present')
    assert.equal(unavail.backlog, true)
    void infoA; void infoB; void infoC
  } finally { await sc.stop(); await sb.stop(); await sa.stop() }
})

test('dedupe: message delivered live during backfill appears once', { timeout: 120000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start(); const infoB = await sb.start(); const infoC = await sc.start()
    await sa.dial(infoB.addrs[0]); await sa.dial(infoC.addrs[0]); await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    // many pre-join messages so backfill spans multiple pages
    for (let i = 0; i < 25; i++) await sa.postToConference({ session: 'a', conference: a.id, text: 'pre' + i })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    // start join (backfill in progress), then post a live message mid-backfill
    const joinPromise = sc.joinConference({ session: 'c', ref: a.id })
    await sleep(200)
    await sa.postToConference({ session: 'a', conference: a.id, text: 'LIVE' })
    await joinPromise
    await sleep(2000)
    const events = sc.core().read(0).events.filter(e => e.kind === 'conference_message')
    const liveCount = events.filter(e => e.body === 'LIVE').length
    assert.equal(liveCount, 1, 'LIVE appears once')
    void infoA; void infoB; void infoC
  } finally { await sc.stop(); await sb.stop(); await sa.stop() }
})

test('reconnect after completed backfill does not re-deliver', { timeout: 120000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start(); const infoB = await sb.start(); const infoC = await sc.start()
    await sa.dial(infoB.addrs[0]); await sa.dial(infoC.addrs[0]); await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'A' })
    await sa.postToConference({ session: 'a', conference: a.id, text: 'B' })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    await sc.joinConference({ session: 'c', ref: a.id })
    await sc.subscribeConference({ session: 'c', conference: a.id, ttl: 300 })
    await sleep(1000)
    const before = sc.core().read(0).events.filter(e => e.kind === 'conference_message').length
    // reconnect
    const transport = (sc as any).transport
    await transport.stop()
    await sleep(500)
    await transport.start()
    await sc.dial(infoA.addrs[0])
    await sleep(3000)
    const after = sc.core().read(0).events.filter(e => e.kind === 'conference_message').length
    assert.equal(after, before, 'no re-delivery on reconnect')
    void infoA; void infoB; void infoC
  } finally { await sc.stop(); await sb.stop(); await sa.stop() }
})

test('resume of saved joined membership backfills missing history', { timeout: 120000 }, async () => {
  const ta = await createNodeTransport()
  const tbRaw = await createNodeTransport()
  let savedB: any
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tbRaw, 'b', s => { savedB = s }, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start(); const infoB = await sb.start()
    await sa.dial(infoB.addrs[0]); await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base', capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sa.postToConference({ session: 'host', conference: room.id, text: 'PRE' })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sleep(1000)
    const exported = (sb as any).transport.exportKey()
    await sb.stop()
    // force incomplete history cursor in saved snapshot
    assert.ok(savedB !== undefined)
    const restored = JSON.parse(JSON.stringify(savedB))
    if (restored.subscriptions?.[room.id]) restored.subscriptions[room.id].historyCursor = 0
    const sb2 = new VortexService(await createNodeTransport({ key: exported }), 'b', () => {}, restored, { embedder: fakeEmbedder() })
    try {
      await sb2.start()
      await sa.dial((await sb2.info()).addrs[0]).catch(() => {})
      await until(() => sb2.core().read(0).events.some(e => e.body === 'PRE'), 30000)
      const count = sb2.core().read(0).events.filter(e => e.body === 'PRE').length
      assert.equal(count, 1)
    } finally { await sb2.stop().catch(() => {}) }
    void infoA; void infoB
  } finally { await sa.stop().catch(() => {}) }
})

test('failed backfill retries on next reconnect without timer', { timeout: 180000 }, async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start(); const infoB = await sb.start(); const infoC = await sc.start()
    await sa.dial(infoB.addrs[0]); await sa.dial(infoC.addrs[0]); await sc.dial(infoA.addrs[0])
    await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    await sc.joinConference({ session: 'c', ref: a.id })
    await sc.subscribeConference({ session: 'c', conference: a.id, ttl: 300 })
    await sleep(1000)
    // disconnect subscriber so a newly posted message is missed live
    const transport = (sc as any).transport
    await transport.stop()
    await sleep(500)
    const missed = await sa.postToConference({ session: 'a', conference: a.id, text: 'MISSED' })
    // seam: history fails on the first recovery attempt only
    const engine = (sc as any).conferences
    const origHistory = engine.history.bind(engine)
    let calls = 0
    engine.history = async (req: any) => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return origHistory(req)
    }
    // first reconnect: recovery runs, history fails once
    await transport.start()
    await sc.dial(infoA.addrs[0])
    await sleep(3000)
    // second reconnect: recovery retries and delivers MISSED
    await transport.stop()
    await sleep(500)
    await transport.start()
    await sc.dial(infoA.addrs[0])
    await until(() => sc.core().read(0).events.some(e => e.message === missed.message && e.backlog === true), 30000)
    assert.ok(calls >= 2, 'history() called at least twice')
    engine.history = origHistory
    void infoA; void infoB; void infoC
  } finally { await sc.stop(); await sb.stop(); await sa.stop() }
})
