// Native browser harness for the durable browser identity/state foundation.
// Runs in actual Chromium IndexedDB; results on window.__browserState.
import { openBrowserState, BROWSER_STATE_VERSION } from '../src/browser/state.ts'
import { startBrowserClient } from '../src/browser/client.ts'
import { Conversations } from '../src/core/conversations.ts'
import type { Snapshot } from '../src/core/conversations.ts'

type Result = { name: string, ok: boolean, detail?: string }
const results: Result[] = []
const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const uid = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36)

function pass (name: string): void { results.push({ name, ok: true }) }
function fail (name: string, detail: unknown): void {
  results.push({ name, ok: false, detail: String((detail as Error)?.message ?? detail).slice(0, 500) })
}
async function check (name: string, fn: () => Promise<void> | void): Promise<void> {
  const status = document.getElementById('status')
  if (status) status.textContent = `running ${name}`;
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
function assert (cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
const deleteDb = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const req = indexedDB.deleteDatabase(name)
  req.onsuccess = () => { resolve() }
  req.onerror = () => { reject(req.error ?? new Error('delete failed')) }
  req.onblocked = () => { /* proceed; reopen will still work */ }
})

async function corruptSingleRecord (dbName: string): Promise<{ restored: boolean }> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error) }
  })
  try {
    const stores = [...db.objectStoreNames]
    assert(stores.length > 0, 'no object stores to corrupt')
    for (const s of stores) {
      const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
        const tx = db.transaction(s, 'readonly')
        const q = tx.objectStore(s).getAllKeys()
        q.onsuccess = () => { resolve(q.result) }
        q.onerror = () => { reject(q.error) }
      })
      if (keys.length === 0) continue
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(s, 'readwrite')
        tx.oncomplete = () => { resolve() }
        tx.onerror = () => { reject(tx.error) }
        tx.onabort = () => { reject(tx.error ?? new Error('abort')) }
        // The store uses in-line keys (keyPath id): overwrite the record by
        // value so the same primary key is corrupted in place.
        tx.objectStore(s).put({ id: keys[0], garbage: true })
      })
      return { restored: false }
    }
    throw new Error('no records to corrupt')
  } finally { db.close() }
}

async function rewriteSnapshot (dbName: string, mutate: (snap: Record<string, unknown>) => void): Promise<string> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error) }
  })
  try {
    for (const s of [...db.objectStoreNames]) {
      const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
        const tx = db.transaction(s, 'readonly')
        const q = tx.objectStore(s).getAllKeys()
        q.onsuccess = () => { resolve(q.result) }
        q.onerror = () => { reject(q.error) }
      })
      if (keys.length === 0) continue
      const current: unknown = await new Promise((resolve, reject) => {
        const tx = db.transaction(s, 'readonly')
        const q = tx.objectStore(s).get(keys[0])
        q.onsuccess = () => { resolve(q.result) }
        q.onerror = () => { reject(q.error) }
      })
      mutate((current as { snapshot: Record<string, unknown> }).snapshot)
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(s, 'readwrite')
        tx.oncomplete = () => { resolve() }
        tx.onerror = () => { reject(tx.error) }
        tx.onabort = () => { reject(tx.error ?? new Error('abort')) }
        tx.objectStore(s).put(current)
      })
      return JSON.stringify(current)
    }
    throw new Error('no records to rewrite')
  } finally { db.close() }
}

async function readFirstRaw (dbName: string): Promise<unknown> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error) }
  })
  try {
    for (const s of [...db.objectStoreNames]) {
      const vals: unknown[] = await new Promise((resolve, reject) => {
        const tx = db.transaction(s, 'readonly')
        const q = tx.objectStore(s).getAll()
        q.onsuccess = () => { resolve(q.result) }
        q.onerror = () => { reject(q.error) }
      })
      if (vals.length > 0) return vals[0]
    }
    return undefined
  } finally { db.close() }
}

async function run (): Promise<void> {
  // 1. Independent databases have independent identities.
  await check('independent-databases-independent-identities', async () => {
    const a = `bs-ind-a-${uid()}`
    const b = `bs-ind-b-${uid()}`
    const sa = await openBrowserState(a)
    const sb = await openBrowserState(b)
    try {
      assert(hex(sa.key()) !== hex(sb.key()), 'two databases must not share an identity')
    } finally { await sa.close().catch(() => {}); await sb.close().catch(() => {}); await deleteDb(a); await deleteDb(b) }
  })

  // 2. Reopen restores the same key and snapshot.
  await check('reopen-restores-key-and-snapshot', async () => {
    const db = `bs-reopen-${uid()}`
    const s1 = await openBrowserState(db)
    const k1 = hex(s1.key())
    const snap: Snapshot = { rooms: { r1: { peer: 'p', localConsent: true, remoteConsent: true } }, events: [], seen: [], cursor: 0 }
    await s1.save(snap)
    await s1.close()
    const s2 = await openBrowserState(db)
    try {
      assert(hex(s2.key()) === k1, 'key changed across reopen')
      assert((s2.snapshot().rooms as Record<string, unknown>).r1 !== undefined, 'snapshot room lost')
    } finally { await s2.close().catch(() => {}); await deleteDb(db) }
  })

  // 3. Simultaneous first initializes keep exactly one winner.
  await check('concurrent-open-keeps-winner', async () => {
    const db = `bs-race-${uid()}`
    const opens = await Promise.all(Array.from({ length: 8 }, () => openBrowserState(db)))
    try {
      const first = hex(opens[0].key())
      for (const s of opens) assert(hex(s.key()) === first, 'concurrent opens diverged')
    } finally {
      for (const s of opens) await s.close().catch(() => {})
      await deleteDb(db)
    }
  })

  // 4. Closed saves reject and do not publish state through Conversations.
  await check('closed-save-does-not-publish', async () => {
    const db = `bs-closed-${uid()}`
    const store = await openBrowserState(db)
    try {
      const core = new Conversations('self-closed', { send: async () => {}, save: s => store.save(s) }, store.snapshot())
      const peer = 'peerA'
      const room = core.roomFor(peer)
      await core.receive(peer, { kind: 'invite', room })
      assert(core.read().events.length === 1, 'expected one invite event')
      // A rejected save must not publish: wrap the store so one save fails.
      let failOnce = true
      const flaky = new Conversations('self-flaky',
        { send: async () => {}, save: s => { if (failOnce) { failOnce = false; return Promise.reject(new Error('injected save failure')) } return store.save(s) } },
        store.snapshot())
      const room2 = flaky.roomFor('peerZ')
      const flakyBefore = flaky.read(0).cursor
      let flakyRejected = false
      try { await flaky.receive('peerZ', { kind: 'invite', room: room2 }) } catch (e) {
        flakyRejected = /injected save failure/.test(String((e as Error)?.message ?? e))
      }
      assert(flakyRejected, 'injected save failure must reject')
      assert(flaky.read(0).cursor === flakyBefore, 'rejected save published state')
      await store.close()
      let rejected = false
      try { await store.save({ rooms: {}, events: [], seen: [], cursor: 0 }) } catch { rejected = true }
      assert(rejected, 'save after close must reject')
      let opRejected = false
      try { await core.receive('peerB', { kind: 'invite', room: core.roomFor('peerB') }) } catch { opRejected = true }
      assert(opRejected, 'core op after close must reject')
      assert(core.read().events.length === 1 && core.read().events[0].room === room, 'closed save published state')
    } finally { await store.close().catch(() => {}); await deleteDb(db) }
  })

  // 5. Saves detach caller mutations at call time.
  await check('save-isolates-mutable-arguments', async () => {
    const db = `bs-isolate-${uid()}`
    const s1 = await openBrowserState(db)
    try {
      const draft: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0 }
      const p = s1.save(draft)
      ;(draft.rooms as Record<string, unknown>).evil = { peer: 'x', localConsent: true, remoteConsent: true }
      draft.cursor = 999
      await p
      await s1.close()
      const s2 = await openBrowserState(db)
      try {
        assert((s2.snapshot().rooms as Record<string, unknown>).evil === undefined, 'mutation leaked into save')
        assert(s2.snapshot().cursor === 0, 'cursor mutation leaked into save')
      } finally { await s2.close().catch(() => {}) }
    } finally { await deleteDb(db) }
  })

  // 6. Conversations backed by the store persists inbox/cursor/ack/dedup + private membership.
  await check('conversations-persist-across-reopen', async () => {
    const db = `bs-conv-${uid()}`
    const store = await openBrowserState(db)
    try {
      const self = 'browser-self'
      const core = new Conversations(self, { send: async () => {}, save: s => store.save(s) }, store.snapshot())
      const peer = 'peerDirect'
      const room = core.roomFor(peer)
      await core.receive(peer, { kind: 'invite', room })
      await core.accept(room)
      await core.receive(peer, { kind: 'message', room, id: 'm1', body: 'hello inbox' })
      const cursor = core.read().cursor
      await core.receive(peer, { kind: 'message', room, id: 'm1', body: 'hello inbox' })
      assert(core.read().cursor === cursor, 'duplicate delivery advanced the cursor')
      await core.ack(cursor)
      const conf = 'ab'.repeat(16)
      await core.setSubscription({
        conference: conf, session: 's1', host: 'hostPeer', expires: Date.now() + 60000,
        membership: { descriptor: 'ab'.repeat(16), privateKey: 'cd'.repeat(16) }
      })
      const keyHex = hex(store.key())
      await store.close()
      const reopened = await openBrowserState(db)
      try {
        assert(hex(reopened.key()) === keyHex, 'identity changed across reopen')
        const core2 = new Conversations(self, { send: async () => {}, save: s => reopened.save(s) }, reopened.snapshot())
        assert(core2.read().events.length === 0, 'acked inbox must read empty')
        assert(core2.read(0).events.length >= 2, 'history lost across reopen')
        const before = core2.read(0).cursor
        await core2.receive(peer, { kind: 'message', room, id: 'm1', body: 'hello inbox' })
        assert(core2.read(0).cursor === before, 'dedup lost across reopen')
        const stored = core2.storedSubscriptions()[conf]
        assert(stored?.membership?.descriptor === 'ab'.repeat(16), 'private membership lost')
        const pub = core2.subscriptions().find(x => x.conference === conf)
        assert(pub !== undefined && (pub as unknown as Record<string, unknown>).id === undefined, 'public leak')
        assert(!('membership' in (pub as object)), 'membership leaked to public list')
      } finally { await reopened.close().catch(() => {}) }
    } finally { await deleteDb(db) }
  })

  // 7. Malformed stored records fail closed without replacement.
  await check('malformed-record-fails-closed', async () => {
    const db = `bs-malformed-${uid()}`
    const s = await openBrowserState(db)
    await s.close()
    await corruptSingleRecord(db)
    const before = JSON.stringify(await readFirstRaw(db))
    let rejected = false
    try { await openBrowserState(db) } catch (e) {
      rejected = true
      assert(!String((e as Error)?.message ?? e).includes('ab') && !String((e as Error)?.message ?? e).includes('garbage:'),
        'error text must not echo stored content')
    }
    assert(rejected, 'malformed record must reject')
    const after = JSON.stringify(await readFirstRaw(db))
    assert(before === after, 'malformed record was replaced')
    await deleteDb(db)
  })

  // 8. Concurrent client starts are exclusive; the lock releases on stop and on failure.
  await check('client-exclusive-lock-and-release', async () => {
    const db = `bs-client-${uid()}`
    const first = await startBrowserClient({ dbName: db, allow: [], name: 'first' })
    let secondRejected = false
    try {
      await startBrowserClient({ dbName: db, allow: [], name: 'second' })
    } catch { secondRejected = true }
    assert(secondRejected, 'second concurrent client must be rejected')
    await first.stop()
    const third = await startBrowserClient({ dbName: db, allow: [], name: 'third' })
    await third.stop()
    // A failed start must also release the lock.
    let failed = false
    try {
      await startBrowserClient({ dbName: db, allow: [], name: 'bad', service: { subscriptions: { maxCount: 0 } } })
    } catch { failed = true }
    assert(failed, 'invalid client options must reject')
    const afterFail = await startBrowserClient({ dbName: db, allow: [], name: 'after-fail' })
    await afterFail.stop()
    await deleteDb(db)
  })

  // 9. Missing locks reject before any store or transport exposure.
  await check('missing-locks-rejects-before-exposure', async () => {
    const db = `bs-nolock-${uid()}`
    const nav = navigator as Navigator & { locks?: LockManager }
    const hadOwn = Object.prototype.hasOwnProperty.call(nav, 'locks')
    const original = nav.locks
    Object.defineProperty(nav, 'locks', { value: undefined, configurable: true })
    try {
      let rejected = false
      try {
        await startBrowserClient({ dbName: db, allow: [], name: 'x' })
      } catch (e) {
        rejected = /lock/i.test(String((e as Error)?.message ?? e))
      }
      assert(rejected, 'missing locks must reject')
      assert(await readFirstRaw(db) === undefined, 'store was exposed without locks')
    } finally {
      if (hadOwn) Object.defineProperty(nav, 'locks', { value: original, configurable: true })
      else delete (nav as unknown as Record<string, unknown>).locks
      await deleteDb(db)
    }
  })

  // 10. An asynchronously rejecting lock request settles promptly.
  await check('async-lock-rejection-settles', async () => {
    const db = `bs-lockrej-${uid()}`
    const mgr = navigator.locks as LockManager
    const original = mgr.request
    let calls = 0
    mgr.request = (() => {
      calls++
      return new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error('lock exploded')) }, 50) })
    }) as typeof mgr.request
    const started = performance.now()
    try {
      let rejected = false
      try {
        await startBrowserClient({ dbName: db, allow: [], name: 'x' })
      } catch { rejected = true }
      assert(rejected, 'async lock rejection must reject the start')
      assert(performance.now() - started < 5000, 'lock rejection hung acquisition')
      assert(calls === 1, 'expected one lock request')
    } finally {
      mgr.request = original
      await deleteDb(db)
    }
  })

  // 11. A forced transaction abort rolls back cleanly with no unhandled rejection.
  await check('forced-abort-rollback-clean', async () => {
    const db = `bs-abort-${uid()}`
    const store = await openBrowserState(db)
    try {
      const core = new Conversations('self-abort', { send: async () => {}, save: s => store.save(s) }, store.snapshot())
      const beforeSnap = JSON.stringify(store.snapshot())
      const beforeCursor = core.read(0).cursor
      const unhandled: string[] = []
      const onUnhandled = (e: PromiseRejectionEvent): void => { unhandled.push(String(e.reason)) }
      window.addEventListener('unhandledrejection', onUnhandled)
      const proto = IDBObjectStore.prototype
      const origPut = proto.put
      let aborted = 0
      proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
        const req = Reflect.apply(origPut, this, args) as IDBRequest
        try { this.transaction.abort() } catch { /* rejection surfaces via save */ }
        aborted++
        return req
      } as typeof proto.put
      try {
        let rejected = false
        try {
          await core.receive('peerX', { kind: 'invite', room: core.roomFor('peerX') })
        } catch { rejected = true }
        assert(rejected, 'aborted save must reject')
        assert(core.read(0).cursor === beforeCursor, 'aborted save published state')
        assert(JSON.stringify(store.snapshot()) === beforeSnap, 'in-memory snapshot changed after abort')
        await store.close()
        const reopened = await openBrowserState(db)
        try {
          assert(JSON.stringify(reopened.snapshot()) === beforeSnap, 'persisted snapshot changed after abort')
        } finally { await reopened.close().catch(() => {}) }
        await new Promise(resolve => { setTimeout(resolve, 50) })
        assert(unhandled.length === 0, `unhandled rejection: ${(unhandled[0] ?? '').slice(0, 200)}`)
        assert(aborted > 0, 'abort hook never ran')
      } finally {
        proto.put = origPut
        window.removeEventListener('unhandledrejection', onUnhandled)
      }
    } finally { await store.close().catch(() => {}); await deleteDb(db) }
  })

  // 12. Corrupt acked/seens are rejected on save and on reopen, without rewrite.
  await check('ack-corruption-rejected', async () => {
    const db = `bs-ackbad-${uid()}`
    const s = await openBrowserState(db)
    let saveRejected = false
    try {
      await s.save({ rooms: {}, events: [], seen: [], cursor: 0, acked: 999 })
    } catch (e) {
      saveRejected = true
      assert(!String((e as Error)?.message ?? e).includes('999'), 'error must not include persisted contents')
    }
    assert(saveRejected, 'acked beyond cursor must reject on save')
    await s.close()
    const corrupted = await rewriteSnapshot(db, snap => { snap.acked = 999 })
    let reopenRejected = false
    try {
      await openBrowserState(db)
    } catch (e) {
      reopenRejected = true
      assert(!String((e as Error)?.message ?? e).includes('999'), 'error must not include persisted contents')
    }
    assert(reopenRejected, 'acked beyond cursor must reject on reopen')
    assert(JSON.stringify(await readFirstRaw(db)) === corrupted, 'corrupted record was rewritten')
    await deleteDb(db)
  })

  // 12b. Head-of-line (2026-10-23): a scoped ack's handled set persists, and
  // a handled cursor at or below the watermark or beyond the cursor is corrupt.
  await check('handled-set-validated', async () => {
    const db = `bs-handled-${uid()}`
    const s = await openBrowserState(db)
    const ev = (cursor: number) => ({ cursor, kind: 'message' as const, room: 'r', peer: 'p', body: 'b', trust: 'untrusted_peer_content' as const })
    for (const handled of [[1], [4], [2.5]]) {
      let rejected = false
      try { await s.save({ rooms: {}, events: [ev(1), ev(2), ev(3)], seen: [], cursor: 3, acked: 1, handled }) } catch { rejected = true }
      assert(rejected, `handled ${JSON.stringify(handled)} must reject`)
    }
    await s.save({ rooms: {}, events: [ev(1), ev(2), ev(3)], seen: [], cursor: 3, acked: 1, handled: [3] })
    const core = new Conversations('me', { send: async () => {}, save: () => {} }, s.snapshot())
    assert(JSON.stringify(core.read().events.map(e => e.cursor)) === '[2]', 'handled event leaves the unread view after reopen')
    await s.close()
    await deleteDb(db)
  })

  // 13. Concurrent stops share one completion and release ownership once.
  await check('simultaneous-stop-shares-completion', async () => {
    const db = `bs-stop-${uid()}`
    const client = await startBrowserClient({ dbName: db, allow: [], name: 'stopper' })
    const p1 = client.stop()
    const p2 = client.stop()
    assert(p1 === p2, 'concurrent stops must share one completion')
    await p1
    await p2
    const again = await startBrowserClient({ dbName: db, allow: [], name: 'after-stop' })
    await again.stop()
    await deleteDb(db)
  })

  // 14. Aborting the initial add after request success must reject the open.
  await check('initial-add-then-abort-rejects', async () => {
    const db = `bs-initabort-${uid()}`
    const origAdd = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: unknown[]) {
      const req = Reflect.apply(origAdd, this, args) as IDBRequest
      const tx = this.transaction
      req.addEventListener('success', () => { try { tx.abort() } catch { /* rejection surfaces via open */ } })
      return req
    } as typeof IDBObjectStore.prototype.add
    try {
      let rejected = false
      try {
        const s = await openBrowserState(db)
        await s.close()
      } catch (e) {
        rejected = true
        assert(!String((e as Error)?.message ?? e).includes(db), 'error must stay generic')
      }
      assert(rejected, 'open resolved before its initial add committed')
      assert(await readFirstRaw(db) === undefined, 'aborted init left a record')
    } finally {
      IDBObjectStore.prototype.add = origAdd
      await deleteDb(db)
    }
  })

  // 15. Readwrite transactions request strict durability.
  await check('transactions-use-strict-durability', async () => {
    const db = `bs-dur-${uid()}`
    const origTx = IDBDatabase.prototype.transaction
    const seen: unknown[] = []
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: unknown[]) {
      const tx = Reflect.apply(origTx, this, args) as IDBTransaction & { durability?: unknown }
      try {
        if ((args[1] as string) === 'readwrite') seen.push(tx.durability)
      } catch { /* observation only */ }
      return tx
    } as typeof IDBDatabase.prototype.transaction
    try {
      const s = await openBrowserState(db)
      await s.save(s.snapshot())
      await s.close()
      assert(seen.length >= 2, 'expected init and save readwrite transactions')
      for (const d of seen) assert(d === 'strict', `durability was ${String(d)}`)
    } finally {
      IDBDatabase.prototype.transaction = origTx
      await deleteDb(db)
    }
  })

  // 16. A failing service.stop still drains, releases, and rejects every stop caller.
  await check('stop-failure-propagates-after-drain', async () => {
    const db = `bs-stopfail-${uid()}`
    const client = await startBrowserClient({ dbName: db, allow: [], name: 's' })
    const core = client.service.core()
    const peer = 'peerStop'
    await core.receive(peer, { kind: 'invite', room: core.roomFor(peer) })
    const cursor = core.read(0).cursor
    client.service.stop = async () => { throw new Error('induced stop failure') }
    const p1 = client.stop()
    const p2 = client.stop()
    assert(p1 === p2, 'concurrent stops must share one completion')
    let e1: unknown
    let e2: unknown
    try { await p1 } catch (e) { e1 = e }
    try { await p2 } catch (e) { e2 = e }
    assert(/induced stop failure/.test(String((e1 as Error)?.message ?? e1)), 'first stop did not reject')
    assert(/induced stop failure/.test(String((e2 as Error)?.message ?? e2)), 'second stop did not reject')
    const reopened = await openBrowserState(db)
    try {
      assert(reopened.snapshot().cursor === cursor, 'queued write was lost before lock release')
    } finally { await reopened.close().catch(() => {}) }
    const next = await startBrowserClient({ dbName: db, allow: [], name: 'after-failed-stop' })
    await next.stop()
    await deleteDb(db)
  })

  // 17. A version bump closes the open store and invalidates it.
  await check('versionchange-closes-store', async () => {
    const db = `bs-ver-${uid()}`
    const s = await openBrowserState(db)
    try {
      const bumped: IDBDatabase = await Promise.race([
        new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(db, BROWSER_STATE_VERSION + 1)
          req.onupgradeneeded = () => {}
          req.onsuccess = () => { resolve(req.result) }
          req.onerror = () => { reject(req.error ?? new Error('upgrade failed')) }
          req.onblocked = () => { reject(new Error('upgrade blocked: store did not close')) }
        }),
        new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error('upgrade timed out')) }, 15000) })
      ])
      try {
        assert(s.isClosed === true, 'store stayed open across versionchange')
        let rejected = false
        try {
          await s.save({ rooms: {}, events: [], seen: [], cursor: 0 })
        } catch { rejected = true }
        assert(rejected, 'save after versionchange must reject')
      } finally { bumped.close() }
    } finally { await s.close().catch(() => {}); await deleteDb(db) }
  })

  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  const report = { done: true, passed, failed, results }
  ;(window as unknown as { __browserState: unknown }).__browserState = report
  const pre = document.getElementById('report')
  if (pre) pre.textContent = JSON.stringify(report, null, 2)
  const status = document.getElementById('status')
  if (status) status.textContent = failed === 0 ? `pass ${passed}/${results.length}` : `fail ${failed}/${results.length}`
}

void run().catch(e => {
  const report = { done: true, passed: 0, failed: 1, results: [...results, { name: 'harness', ok: false, detail: String(e?.message ?? e).slice(0, 500) }] }
  ;(window as unknown as { __browserState: unknown }).__browserState = report
  const pre = document.getElementById('report')
  if (pre) pre.textContent = JSON.stringify(report, null, 2)
})
