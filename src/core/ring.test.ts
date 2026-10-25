// Docs: VORTEX_v5.1.md §9.3; ISSUES.md I3–I8 (wake eligibility, pacing, budgets and outcomes).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Conversations } from './conversations.ts'
import { createRingPolicy, nextRing } from './ring.ts'

function setup (options: { maxPerHour?: number, minIntervalMs?: number, ownerQuietMs?: number, maxFailures?: number } = {}) {
  const clock = { now: 1_000_000 }
  const policy = createRingPolicy({ ...options, now: () => clock.now })
  const idle = { room: 'r', unread: 1, waiters: 0, running: false }
  /** One complete ring: start, then exit with the given code. */
  const ring = (code = 0, room = 'r') => { policy.started(room); policy.exited(code) }
  return { clock, policy, idle, ring }
}

test('rings only when there is unread mail and nobody is already attending to it', () => {
  const { policy, idle } = setup()
  assert.equal(policy.shouldRing(idle), true)
  assert.equal(policy.shouldRing({ ...idle, unread: 0 }), false)
  assert.equal(policy.shouldRing({ ...idle, waiters: 1 }), false)
  assert.equal(policy.shouldRing({ ...idle, running: true }), false)
})

test('keeps a minimum interval between ring starts', () => {
  const { clock, policy, idle, ring } = setup({ minIntervalMs: 30_000 })
  ring()
  assert.equal(policy.shouldRing(idle), false)
  clock.now += 29_999
  assert.equal(policy.shouldRing(idle), false)
  clock.now += 1
  assert.equal(policy.shouldRing(idle), true)
})

test('bounds ring starts per room per rolling hour', () => {
  const { clock, policy, idle, ring } = setup({ maxPerHour: 2, minIntervalMs: 0 })
  ring()
  clock.now += 60_000
  ring()
  assert.equal(policy.shouldRing(idle), false)
  assert.equal(policy.shouldRing({ ...idle, room: 'other' }), true)
  clock.now += 3_600_000 - 60_000
  assert.equal(policy.shouldRing(idle), true)
})

test('stops ringing after consecutive adapter failures', () => {
  const { policy, idle, ring } = setup({ maxFailures: 3, minIntervalMs: 0, maxPerHour: 100 })
  ring(1)
  ring(1)
  ring(0)
  ring(1)
  ring(1)
  assert.equal(policy.shouldRing(idle), true)
  ring(1)
  assert.equal(policy.shouldRing(idle), false)
})

test('an owner command clears the failure count', () => {
  const { policy, idle, ring } = setup({ maxFailures: 1, maxPerHour: 100, minIntervalMs: 0 })
  ring(1)
  assert.equal(policy.shouldRing(idle), false)
  policy.ownerActed()
  assert.equal(policy.shouldRing(idle), true)
})

test('owner activity holds off ringing, so a live session is not raced by a rung one', () => {
  const { clock, policy, idle } = setup({ ownerQuietMs: 30_000 })
  policy.ownerActed()
  assert.equal(policy.shouldRing(idle), false)
  clock.now += 30_000
  assert.equal(policy.shouldRing(idle), true)
})

test('an owner command does not refill the hourly budget, since rung agents read and ack too', () => {
  const { policy, idle, ring } = setup({ maxPerHour: 1, minIntervalMs: 0 })
  ring()
  policy.ownerActed()
  assert.equal(policy.shouldRing(idle), false)
})

test('a deferred exit restores the charged start and counts no failure', () => {
  const { policy, idle, ring } = setup({ maxPerHour: 1, minIntervalMs: 0, maxFailures: 1 })
  ring(75)
  assert.equal(policy.shouldRing(idle), true)
})

test('three deferrals neither suppress ringing nor exhaust the budget', () => {
  const { clock, policy, idle, ring } = setup({ maxPerHour: 2, minIntervalMs: 0, maxFailures: 1 })
  ring(75)
  clock.now += 1
  ring(75)
  clock.now += 1
  ring(75)
  clock.now += 1
  assert.equal(policy.shouldRing(idle), true)
})

test('real failures still suppress after deferrals', () => {
  const { policy, idle, ring } = setup({ maxPerHour: 100, minIntervalMs: 0, maxFailures: 2 })
  ring(75)
  ring(1)
  assert.equal(policy.shouldRing(idle), true)
  ring(1)
  assert.equal(policy.shouldRing(idle), false)
})

test('a deferral retains minimum pacing between starts', () => {
  const { clock, policy, idle, ring } = setup({ minIntervalMs: 30_000 })
  ring(75)
  assert.equal(policy.shouldRing(idle), false)
  clock.now += 30_000
  assert.equal(policy.shouldRing(idle), true)
})

test('an accepted unacknowledged ring keeps its charge without counting as a failure', () => {
  const healthy = setup({ maxPerHour: 100, maxFailures: 1, minIntervalMs: 0 })
  healthy.ring(76)
  assert.equal(healthy.policy.shouldRing(healthy.idle), true)
  const charged = setup({ maxPerHour: 1, minIntervalMs: 0 })
  charged.ring(76)
  charged.policy.ownerActed()
  assert.equal(charged.policy.shouldRing(charged.idle), false)
})

/** A core with mutual consent in the rooms of peers 'a' and 'b', and nothing unread. */
async function consented () {
  const core = new Conversations('self', { send: async () => {}, save: () => {} })
  for (const peer of ['a', 'b']) {
    const room = await core.invite(peer)
    await core.receive(peer, { kind: 'accept', room })
  }
  await core.ack(core.read().cursor)
  const message = async (peer: string, id: string) => { await core.receive(peer, { kind: 'message', room: core.roomFor(peer), id, body: 'x' }) }
  return { core, message }
}

test('a room that has spent its budget does not starve a later room', async () => {
  const { policy, ring } = setup({ maxPerHour: 1, minIntervalMs: 0 })
  const { core, message } = await consented()
  await message('a', '1')
  await message('b', '1')
  assert.deepEqual(nextRing(policy, core, false), { room: core.roomFor('a'), unread: 2 })
  ring(0, core.roomFor('a'))
  assert.deepEqual(nextRing(policy, core, false), { room: core.roomFor('b'), unread: 2 })
  ring(0, core.roomFor('b'))
  assert.equal(nextRing(policy, core, false), undefined)
})

test('mail in a consented room is found behind more than a page of other events', async () => {
  const { policy } = setup()
  const { core, message } = await consented()
  for (let i = 0; i < 150; i++) await core.receive(`stranger${i}`, { kind: 'invite', room: core.roomFor(`stranger${i}`) })
  assert.equal(nextRing(policy, core, false), undefined)
  await message('b', '1')
  assert.deepEqual(nextRing(policy, core, false), { room: core.roomFor('b'), unread: 1 })
})

test('no ring is chosen while a waiter is attached or an adapter is running', async () => {
  const { policy } = setup()
  const { core, message } = await consented()
  await message('a', '1')
  assert.equal(nextRing(policy, core, true), undefined)
  const waiting = core.wait(core.read().cursor, 50)
  assert.equal(nextRing(policy, core, false), undefined)
  await assert.rejects(waiting, /timed out/)
})

test('a control-only room is skipped in favor of a data room', () => {
  const policy = createRingPolicy({ minIntervalMs: 0 })
  const core = {
    read: (after?: number) => ({ events: after === undefined ? [
      { room: 'control-room', kind: 'match' },
      { room: 'data-room', kind: 'message' },
    ] : [], cursor: 2 }),
    rooms: () => ({ 'control-room': { localConsent: true, remoteConsent: true }, 'data-room': { localConsent: true, remoteConsent: true } }),
    waiters: () => 0,
  }
  const result = nextRing(policy, core as any, false)
  assert.ok(result, 'a data room rings')
  assert.equal(result!.room, 'data-room')
})
