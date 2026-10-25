import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { checkPeerMemoryRecord, checkPeerMemorySubject } from '../core/peer-memory.ts'
import type { Snapshot } from '../core/conversations.ts'

/** Local IndexedDB only, never sync. One fixed record holds key + Snapshot. */
export const BROWSER_STATE_VERSION = 1

const STORE_NAME = 'vortex-state'
const RECORD_ID = 'vortex-state-v1'
const KINDS = new Set([
  'invitation', 'accepted', 'message', 'match',
  'formed', 'arrival', 'departure', 'conference_message', 'closed'
])

export interface BrowserStateStore {
  readonly dbName: string
  readonly isClosed: boolean
  key(): Uint8Array
  snapshot(): Snapshot
  save(snapshot: Snapshot): Promise<void>
  close(): Promise<void>
}

const failIdentity = (): Error => new Error('stored browser identity is invalid')
const failSnapshot = (): Error => new Error('stored browser snapshot is invalid')
const failTx = (): Error => new Error('browser state transaction failed')

function checkDbName (dbName: string): void {
  if (typeof dbName !== 'string' || dbName.length < 1 || dbName.length > 128) {
    throw new Error('database name must contain 1 to 128 characters')
  }
}

function validateKeyBytes (key: unknown): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 1) throw failIdentity()
  let type: string
  try {
    type = privateKeyFromProtobuf(key).type
  } catch {
    throw failIdentity()
  }
  if (type !== 'Ed25519') throw failIdentity()
}

function validateSnapshot (value: unknown): asserts value is Snapshot {
  if (typeof value !== 'object' || value === null) throw failSnapshot()
  const s = value as Record<string, unknown>
  if (typeof s.rooms !== 'object' || s.rooms === null || Array.isArray(s.rooms)) throw failSnapshot()
  for (const room of Object.values(s.rooms as Record<string, unknown>)) {
    if (typeof room !== 'object' || room === null) throw failSnapshot()
    const r = room as Record<string, unknown>
    if (typeof r.peer !== 'string' || r.peer.length < 1) throw failSnapshot()
    if (typeof r.localConsent !== 'boolean' || typeof r.remoteConsent !== 'boolean') throw failSnapshot()
  }
  if (!Array.isArray(s.events) || !Array.isArray(s.seen)) throw failSnapshot()
  if (!Number.isSafeInteger(s.cursor) || (s.cursor as number) < 0) throw failSnapshot()
  let maxCursor = 0
  for (const event of s.events as unknown[]) {
    if (typeof event !== 'object' || event === null) throw failSnapshot()
    const e = event as Record<string, unknown>
    if (!Number.isSafeInteger(e.cursor) || (e.cursor as number) < 1) throw failSnapshot()
    if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) throw failSnapshot()
    if (typeof e.room !== 'string' || (e.room as string).length < 1) throw failSnapshot()
    if (typeof e.peer !== 'string' || (e.peer as string).length < 1) throw failSnapshot()
    maxCursor = Math.max(maxCursor, e.cursor as number)
  }
  if ((s.cursor as number) < maxCursor) throw failSnapshot()
  if (s.acked !== undefined && (!Number.isSafeInteger(s.acked) || (s.acked as number) < 0 || (s.acked as number) > (s.cursor as number))) {
    throw failSnapshot()
  }
  if (s.handled !== undefined) {
    if (!Array.isArray(s.handled)) throw failSnapshot()
    for (const c of s.handled as unknown[]) {
      if (!Number.isSafeInteger(c) || (c as number) <= ((s.acked as number | undefined) ?? 0) || (c as number) > (s.cursor as number)) throw failSnapshot()
    }
  }
  for (const key of s.seen as unknown[]) if (typeof key !== 'string') throw failSnapshot()
  if (s.seenAt !== undefined) {
    if (typeof s.seenAt !== 'object' || s.seenAt === null || Array.isArray(s.seenAt)) throw failSnapshot()
    for (const at of Object.values(s.seenAt as Record<string, unknown>)) {
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) throw failSnapshot()
    }
  }
  if (s.subscriptions !== undefined) {
    if (typeof s.subscriptions !== 'object' || s.subscriptions === null || Array.isArray(s.subscriptions)) throw failSnapshot()
    for (const sub of Object.values(s.subscriptions as Record<string, unknown>)) {
      if (typeof sub !== 'object' || sub === null) throw failSnapshot()
      const u = sub as Record<string, unknown>
      if (!/^[0-9a-f]{32}$/.test(u.conference as string)) throw failSnapshot()
      if (typeof u.session !== 'string' || (u.session as string).length < 1 || (u.session as string).length > 128) throw failSnapshot()
      if (typeof u.host !== 'string' || (u.host as string).length < 1) throw failSnapshot()
      if (typeof u.id !== 'string' || (u.id as string).length < 1) throw failSnapshot()
      if (!Number.isSafeInteger(u.expires) || (u.expires as number) <= 0) throw failSnapshot()
      if (!Number.isSafeInteger(u.historyCursor) || (u.historyCursor as number) < 0) throw failSnapshot()
      if (u.membership !== undefined) {
        const m = u.membership as Record<string, unknown>
        if (typeof m?.descriptor !== 'string' || typeof m?.privateKey !== 'string') throw failSnapshot()
        if (!/^(?:[0-9a-f]{2})+$/.test(m.descriptor as string)) throw failSnapshot()
        if (!/^(?:[0-9a-f]{2})+$/.test(m.privateKey as string)) throw failSnapshot()
      }
      if (u.subject !== undefined) {
        try {
          checkPeerMemorySubject(u.subject as never)
        } catch {
          throw failSnapshot()
        }
      }
    }
  }
  if (s.peerMemory !== undefined) {
    if (!Array.isArray(s.peerMemory)) throw failSnapshot()
    try {
      for (const record of s.peerMemory) checkPeerMemoryRecord(record)
    } catch {
      throw failSnapshot()
    }
  }
}

function sameBytes (a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

function openDatabase (dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(dbName, BROWSER_STATE_VERSION)
    } catch {
      reject(new Error('could not open browser state'))
      return
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    req.onsuccess = () => { resolve(req.result) }
    req.onerror = () => { reject(req.error ?? new Error('could not open browser state')) }
  })
}

/** Handlers attached synchronously so no outcome is ever unobserved. */
function txDone (tx: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => { resolve() }
    tx.onerror = () => { reject(tx.error ?? failTx()) }
    tx.onabort = () => { reject(tx.error ?? failTx()) }
  })
  done.catch(() => {})
  return done
}

function checkedRecord (value: unknown): { key: Uint8Array, snapshot: Snapshot } {
  if (typeof value !== 'object' || value === null) throw failIdentity()
  const r = value as Record<string, unknown>
  if (r.id !== RECORD_ID) throw failIdentity()
  validateKeyBytes(r.key)
  validateSnapshot(r.snapshot)
  return { key: r.key as Uint8Array, snapshot: r.snapshot as Snapshot }
}

function readOne (db: IDBDatabase): Promise<unknown> {
  const tx = db.transaction(STORE_NAME, 'readonly')
  const done = txDone(tx)
  const req = tx.objectStore(STORE_NAME).get(RECORD_ID)
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      void done.then(
        () => { resolve(req.result) },
        (e: unknown) => { reject(e instanceof Error ? e : failTx()) }
      )
    }
    req.onerror = () => { reject(req.error ?? failTx()) }
  })
}

/** Serialized readwrite transactions make get/add atomic; add failures are real errors. */
async function insertOne (db: IDBDatabase, candidate: Uint8Array): Promise<{ key: Uint8Array, snapshot: Snapshot }> {
  const tx = db.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
  const done = txDone(tx)
  try {
    const result = await new Promise<{ key: Uint8Array, snapshot: Snapshot }>((resolve, reject) => {
      let req: IDBRequest
      try {
        req = tx.objectStore(STORE_NAME).get(RECORD_ID)
      } catch {
        try { tx.abort() } catch { /* settled via done */ }
        reject(failTx())
        return
      }
      req.onsuccess = () => {
        if (req.result !== undefined) {
          try {
            resolve(checkedRecord(req.result))
          } catch (e) {
            try { tx.abort() } catch { /* settled via done */ }
            reject(e instanceof Error ? e : failIdentity())
          }
          return
        }
        const fresh = { id: RECORD_ID, key: candidate, snapshot: { rooms: {}, events: [], seen: [], cursor: 0 } }
        let add: IDBRequest
        try {
          add = tx.objectStore(STORE_NAME).add(fresh)
        } catch {
          try { tx.abort() } catch { /* settled via done */ }
          reject(failTx())
          return
        }
        add.onsuccess = () => { resolve({ key: candidate, snapshot: structuredClone(fresh.snapshot) }) }
        add.onerror = () => {
          try { tx.abort() } catch { /* settled via done */ }
          reject(add.error ?? failTx())
        }
      }
      req.onerror = () => {
        try { tx.abort() } catch { /* settled via done */ }
        reject(req.error ?? failTx())
      }
    })
    await done
    return result
  } catch (e) {
    try { await done } catch { /* commit outcome observed */ }
    throw e
  }
}

export async function openBrowserState (dbName: string): Promise<BrowserStateStore> {
  checkDbName(dbName)
  const db = await openDatabase(dbName)
  try {
    const found = await readOne(db)
    if (found !== undefined) {
      const rec = checkedRecord(found)
      return makeStore(db, dbName, rec.key, rec.snapshot)
    }
    const candidate = privateKeyToProtobuf(await generateKeyPair('Ed25519'))
    try {
      const rec = await insertOne(db, candidate)
      if (!sameBytes(rec.key, candidate)) candidate.fill(0)
      return makeStore(db, dbName, rec.key, rec.snapshot)
    } catch (e) {
      candidate.fill(0)
      throw e
    }
  } catch (e) {
    try { db.close() } catch { /* ignore */ }
    throw e
  }
}

function makeStore (db: IDBDatabase, dbName: string, key: Uint8Array, snapshot: Snapshot): BrowserStateStore {
  let closed = false
  const keyBytes = new Uint8Array(key)
  key.fill(0)
  let held = structuredClone(snapshot)
  const invalidate = (): void => {
    if (closed) return
    closed = true
    try { keyBytes.fill(0) } catch { /* best effort */ }
    try { db.close() } catch { /* closing never fails */ }
  }
  db.onversionchange = () => { invalidate() }
  return {
    dbName,
    get isClosed () { return closed },
    key () {
      if (closed) throw new Error('browser state is closed')
      return new Uint8Array(keyBytes)
    },
    snapshot () {
      if (closed) throw new Error('browser state is closed')
      return structuredClone(held)
    },
    async save (next: Snapshot): Promise<void> {
      if (closed) throw new Error('browser state is closed')
      const detached = structuredClone(next)
      validateSnapshot(detached)
      const tx = db.transaction(STORE_NAME, 'readwrite', { durability: 'strict' })
      const done = txDone(tx)
      try {
        await new Promise<void>((resolve, reject) => {
          let req: IDBRequest
          try {
            req = tx.objectStore(STORE_NAME).get(RECORD_ID)
          } catch {
            try { tx.abort() } catch { /* settled via done */ }
            reject(failTx())
            return
          }
          req.onsuccess = () => {
            try {
              if (req.result === undefined) throw new Error('browser state is missing')
              const current = checkedRecord(req.result)
              if (!sameBytes(current.key, keyBytes)) throw new Error('browser state identity changed')
              const put = tx.objectStore(STORE_NAME).put({ id: RECORD_ID, key: new Uint8Array(keyBytes), snapshot: detached })
              put.onsuccess = () => { resolve() }
              put.onerror = () => {
                try { tx.abort() } catch { /* settled via done */ }
                reject(put.error ?? failTx())
              }
            } catch (e) {
              try { tx.abort() } catch { /* settled via done */ }
              reject(e instanceof Error ? e : failTx())
            }
          }
          req.onerror = () => {
            try { tx.abort() } catch { /* settled via done */ }
            reject(req.error ?? failTx())
          }
        })
        await done
        held = structuredClone(detached)
      } catch (e) {
        try { await done } catch { /* commit outcome observed */ }
        throw e
      }
    },
    async close (): Promise<void> {
      invalidate()
    }
  }
}
