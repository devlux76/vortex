import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Announcement } from './announcement.ts'
import { OpenInterests, SeenAnnouncements } from './interests.ts'

const NOW = 1_800_000_000_000

let nextId = 0
const hexId = (): string => (nextId++).toString(16).padStart(32, '0')

/** A literal announcement: the registry never verifies, so nothing is signed. */
function makeAnnouncement (overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: hexId(),
    namespace: 'b'.repeat(64),
    profileVersion: 1,
    vector: Float32Array.from([1, 2]),
    origin: '12D3KooWtest',
    contact: Uint8Array.from([1]),
    issuedAt: NOW,
    ttl: 60,
    ...overrides
  }
}

function setup (options: { maxPerSession?: number, max?: number } = {}) {
  const clock = { now: NOW }
  const interests = new OpenInterests({ ...options, now: () => clock.now })
  const add = (overrides: Partial<Announcement> = {}, extra: { session?: string, statement?: string, replaces?: string } = {}) =>
    interests.add({
      session: extra.session ?? 's1',
      announcement: makeAnnouncement(overrides),
      bytes: Uint8Array.from([9]),
      statement: extra.statement ?? 'a problem',
      replaces: extra.replaces
    })
  return { clock, interests, add }
}

// Docs: VORTEX_v5.1.md section 4.3
test('add stores the interest with expiry from the announcement and returns it', () => {
  const { interests } = setup()
  const announcement = makeAnnouncement({ issuedAt: NOW, ttl: 90 })
  const bytes = Uint8Array.from([1, 2])
  const stored = interests.add({ session: 's1', announcement, bytes, statement: 'a problem' })
  assert.equal(stored.id, announcement.id)
  assert.equal(stored.session, 's1')
  assert.equal(stored.announcement, announcement)
  assert.equal(stored.bytes, bytes)
  assert.equal(stored.statement, 'a problem')
  assert.equal(stored.expires, NOW + 90000)
  assert.equal(interests.size, 1)
  assert.equal(interests.get(announcement.id), stored)
})

// Docs: VORTEX_v5.1.md section 4.3
test('expired interests are not live: get, list and size skip them', () => {
  const { clock, interests, add } = setup()
  const first = add()
  add({ issuedAt: NOW, ttl: 3600 })
  clock.now = NOW + 60000
  assert.equal(interests.get(first.announcement.id), undefined)
  assert.equal(interests.list().length, 1)
  assert.equal(interests.size, 1)
  // Reading them dropped them, so they stay dropped.
  clock.now = NOW
  assert.equal(interests.get(first.announcement.id), undefined)
  assert.equal(interests.size, 1)
})

// Docs: VORTEX_v5.1.md section 4.3
test('replaces removes the earlier interest of the same session in the same call', () => {
  const { interests, add } = setup()
  const first = add()
  const second = interests.add({
    session: 's1',
    announcement: makeAnnouncement(),
    bytes: Uint8Array.from([2]),
    statement: 'a revised problem',
    replaces: first.announcement.id
  })
  assert.equal(interests.get(first.announcement.id), undefined)
  assert.equal(interests.get(second.id), second)
  assert.equal(interests.size, 1)
})

// Docs: VORTEX_v5.1.md section 4.3
test('replaces of an unknown or expired id is ignored', () => {
  const { clock, interests, add } = setup()
  const old = add()
  clock.now = NOW + 60000
  const kept = add({ issuedAt: clock.now }, { replaces: old.announcement.id })
  assert.equal(interests.get(kept.announcement.id), kept)
  const more = add({ issuedAt: clock.now }, { replaces: 'f'.repeat(32) })
  assert.equal(interests.size, 2)
  assert.equal(interests.get(more.announcement.id), more)
})

// Docs: VORTEX_v5.1.md section 4.3
test('a revision needs a new id: replacing an interest with its own id is a duplicate', () => {
  const { interests, add } = setup()
  const first = add()
  assert.throws(() => interests.add({
    session: 's1',
    announcement: first.announcement,
    bytes: Uint8Array.from([2]),
    statement: 'a revised problem',
    replaces: first.announcement.id
  }), /already an open interest/)
  assert.equal(interests.get(first.announcement.id), first)
  assert.equal(first.statement, 'a problem')
})

// Docs: VORTEX_v5.1.md section 4.3
test('replaces of another session interest throws and changes nothing', () => {
  const { interests, add } = setup()
  const first = add({}, { session: 's1' })
  assert.throws(() => interests.add({
    session: 's2',
    announcement: makeAnnouncement(),
    bytes: Uint8Array.from([2]),
    statement: 'a problem',
    replaces: first.announcement.id
  }), /interest belongs to another session/)
  assert.equal(interests.get(first.announcement.id), first)
  assert.equal(interests.size, 1)
})

// Docs: VORTEX_v5.1.md sections 3.2 and 4.3
test('add at the session limit throws and changes nothing', () => {
  const { interests, add } = setup({ maxPerSession: 2 })
  const first = add()
  add()
  assert.throws(() => add(), /session holds the most open interests allowed/)
  assert.equal(interests.size, 2)
  assert.equal(interests.get(first.announcement.id), first)
})

// Docs: VORTEX_v5.1.md sections 3.2 and 4.3
test('add at the service limit throws and changes nothing', () => {
  const { interests, add } = setup({ max: 2 })
  add({}, { session: 's1' })
  add({}, { session: 's2' })
  assert.throws(() => add({}, { session: 's3' }), /service holds the most open interests allowed/)
  assert.equal(interests.size, 2)
})

// Docs: VORTEX_v5.1.md section 4.3
test('replaces is counted before limits: a revision fits a full session', () => {
  const { interests, add } = setup({ maxPerSession: 1, max: 1 })
  const first = add()
  const second = interests.add({
    session: 's1',
    announcement: makeAnnouncement(),
    bytes: Uint8Array.from([2]),
    statement: 'a revised problem',
    replaces: first.announcement.id
  })
  assert.equal(interests.size, 1)
  assert.equal(interests.get(second.id), second)
})

// Docs: VORTEX_v5.1.md section 4.3
test('add refuses a duplicate id, an expired announcement and empty session or statement', () => {
  const { clock, interests, add } = setup()
  const first = add()
  assert.throws(() => interests.add({
    session: 's1',
    announcement: { ...first.announcement },
    bytes: Uint8Array.from([2]),
    statement: 'a problem'
  }), /announcement is already an open interest/)
  assert.throws(() => add({}, { session: '' }), /session and statement are required/)
  assert.throws(() => add({}, { statement: '' }), /session and statement are required/)
  assert.equal(interests.size, 1)
  clock.now = NOW + 60000
  assert.throws(() => interests.add({
    session: 's1',
    announcement: first.announcement,
    bytes: Uint8Array.from([2]),
    statement: 'a problem'
  }), /announcement has expired/)
  assert.equal(interests.size, 0)
})

// Docs: VORTEX_v5.1.md section 4.3
test('withdraw removes only a live interest of the asking session', () => {
  const { clock, interests, add } = setup()
  const first = add({}, { session: 's1' })
  assert.equal(interests.withdraw('s2', first.announcement.id), false)
  assert.equal(interests.withdraw('s1', 'f'.repeat(32)), false)
  assert.equal(interests.withdraw('s1', first.announcement.id), true)
  assert.equal(interests.withdraw('s1', first.announcement.id), false)
  const second = add({}, { session: 's1' })
  clock.now = NOW + 60000
  assert.equal(interests.withdraw('s1', second.announcement.id), false)
  assert.equal(interests.size, 0)
})

// Docs: VORTEX_v5.1.md section 4.3
test('endSession removes every interest of that session oldest first', () => {
  const { interests, add } = setup()
  const a = add({}, { session: 's1' })
  add({}, { session: 's2' })
  const b = add({}, { session: 's1' })
  assert.deepEqual(interests.endSession('s1'), [a.announcement.id, b.announcement.id])
  assert.equal(interests.size, 1)
  assert.deepEqual(interests.endSession('s1'), [])
  assert.deepEqual(interests.endSession('unknown'), [])
})

// Docs: VORTEX_v5.1.md section 4.3
test('sweep removes expired interests and nextExpiry names the earliest live one', () => {
  const { clock, interests, add } = setup()
  const a = add({ ttl: 60 })
  const b = add({ ttl: 3600 })
  const c = add({ ttl: 120 })
  assert.equal(interests.nextExpiry(), NOW + 60000)
  clock.now = NOW + 120000
  assert.deepEqual(interests.sweep(), [a.announcement.id, c.announcement.id])
  assert.equal(interests.size, 1)
  assert.equal(interests.nextExpiry(), NOW + 3600000)
  clock.now = NOW + 3600000
  assert.deepEqual(interests.sweep(), [b.announcement.id])
  assert.equal(interests.nextExpiry(), undefined)
  assert.deepEqual(interests.sweep(), [])
})

// Docs: VORTEX_v5.1.md section 4.3
test('list is oldest first, filters by session and returns a fresh array', () => {
  const { interests, add } = setup()
  const a = add({}, { session: 's1' })
  const other = add({}, { session: 's2' })
  const b = add({}, { session: 's1' })
  assert.deepEqual(interests.list().map(interest => interest.id),
    [a.announcement.id, other.announcement.id, b.announcement.id])
  assert.deepEqual(interests.list('s1').map(interest => interest.id), [a.announcement.id, b.announcement.id])
  const listed = interests.list()
  listed.pop()
  listed.length = 0
  assert.equal(interests.size, 3)
})

// Docs: VORTEX_v5.1.md sections 3.2 and 4.3
test('seen ids are held until expiry, then add of them is new again', () => {
  const clock = { now: NOW }
  const seen = new SeenAnnouncements({ now: () => clock.now })
  assert.equal(seen.add('a', NOW + 1000), true)
  assert.equal(seen.has('a'), true)
  assert.equal(seen.add('a', NOW + 2000), false)
  assert.equal(seen.size, 1)
  clock.now = NOW + 1000
  assert.equal(seen.has('a'), false)
  assert.equal(seen.size, 0)
  assert.equal(seen.add('a', NOW + 2000), true)
  assert.equal(seen.has('a'), true)
})

// Docs: VORTEX_v5.1.md sections 3.2 and 4.3
test('an id that is already expired is never held', () => {
  const clock = { now: NOW }
  const seen = new SeenAnnouncements({ now: () => clock.now })
  assert.equal(seen.add('a', NOW), true)
  assert.equal(seen.has('a'), false)
  assert.equal(seen.size, 0)
})

// Docs: VORTEX_v5.1.md sections 3.2 and 4.3
test('a full memory drops expired ids first, then the earliest expiry, oldest added on ties', () => {
  const clock = { now: NOW }
  const seen = new SeenAnnouncements({ capacity: 3, now: () => clock.now })
  seen.add('old', NOW + 5000)
  seen.add('gone', NOW + 1000)
  seen.add('tie-a', NOW + 9000)
  clock.now = NOW + 1000
  // Full, but `gone` has expired, so it goes and nothing live is lost.
  assert.equal(seen.add('fresh', NOW + 2000), true)
  assert.equal(seen.has('gone'), false)
  assert.equal(seen.has('old'), true)
  assert.equal(seen.size, 3)
  // Still full and nothing expired: the earliest expiry goes.
  assert.equal(seen.add('newer', NOW + 6000), true)
  assert.equal(seen.has('fresh'), false)
  assert.equal(seen.has('newer'), true)
  assert.equal(seen.size, 3)
  // Ties on expiry drop the one added first.
  const tied = new SeenAnnouncements({ capacity: 2, now: () => clock.now })
  tied.add('first', NOW + 5000)
  tied.add('second', NOW + 5000)
  assert.equal(tied.add('third', NOW + 5000), true)
  assert.equal(tied.has('first'), false)
  assert.equal(tied.has('second'), true)
  assert.equal(tied.has('third'), true)
})

// Docs: VORTEX_v5.1.md sections 3.2 and 4.3
test('adding a held id returns false and keeps its earlier expiry', () => {
  const clock = { now: NOW }
  const seen = new SeenAnnouncements({ now: () => clock.now })
  seen.add('a', NOW + 1000)
  assert.equal(seen.add('a', NOW + 9000), false)
  clock.now = NOW + 1000
  assert.equal(seen.has('a'), false)
})

// Docs: VORTEX_v5.1.md section 3.2
test('a capacity below 1 throws', () => {
  assert.throws(() => new SeenAnnouncements({ capacity: 0 }), /capacity/)
  assert.equal(new SeenAnnouncements().size, 0)
})
