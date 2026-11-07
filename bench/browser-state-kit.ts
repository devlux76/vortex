import { openBrowserState, BROWSER_STATE_VERSION } from '../src/browser/state.ts'
import { startBrowserClient } from '../src/browser/client.ts'
import { Conversations } from '../src/core/conversations.ts'
import type { Snapshot } from '../src/core/conversations.ts'

export type Result = { name: string, ok: boolean, detail?: string }
export const results: Result[] = []
export const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
export const uid = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36)

export function pass (name: string): void { results.push({ name, ok: true }) }
export function fail (name: string, detail: unknown): void {
  results.push({ name, ok: false, detail: String((detail as Error)?.message ?? detail).slice(0, 500) })
}
export async function check (name: string, fn: () => Promise<void> | void): Promise<void> {
  const status = document.getElementById('status')
  if (status) status.textContent = `running ${name}`;
  try { await fn(); pass(name) } catch (e) { fail(name, e) }
}
export function assert (cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}
export const deleteDb = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const req = indexedDB.deleteDatabase(name)
  req.onsuccess = () => { resolve() }
  req.onerror = () => { reject(req.error ?? new Error('delete failed')) }
  req.onblocked = () => { /* proceed; reopen will still work */ }
})

export async function corruptSingleRecord (dbName: string): Promise<{ restored: boolean }> {
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

export async function rewriteSnapshot (dbName: string, mutate: (snap: Record<string, unknown>) => void): Promise<string> {
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

export async function readFirstRaw (dbName: string): Promise<unknown> {
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
