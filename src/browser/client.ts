import { createBrowserTransport } from '../net/browser.ts'
import { VortexService } from '../core/service.ts'
import type { ServiceOptions } from '../core/service.ts'
import type { BaseTransportOptions } from '../net/common.ts'
import type { Multiaddr, TransportInfo } from '../types.ts'
import { openBrowserState } from './state.ts'

/** Binds the IndexedDB store to the existing browser transport and service. */
export interface BrowserClientOptions {
  dbName: string
  allow: Multiaddr[]
  name: string
  transport?: Omit<BaseTransportOptions, 'key'>
  service?: ServiceOptions
}

export interface BrowserClient {
  service: VortexService
  info: TransportInfo
  stop(): Promise<void>
}

const heldDatabases = new Set<string>()
const lockName = (dbName: string): string => `vortex-browser-state:${dbName}`

async function acquireExclusive (dbName: string): Promise<() => Promise<void>> {
  if (heldDatabases.has(dbName)) throw new Error('another browser client owns this database')
  const nav = globalThis.navigator as Navigator & { locks?: LockManager }
  const locks = nav.locks
  if (locks === undefined) throw new Error('browser locks are unavailable')
  let releaseHold!: () => void
  const hold = new Promise<void>(resolve => { releaseHold = resolve })
  let settleAcquired!: (granted: boolean) => void
  const acquired = new Promise<boolean>(resolve => { settleAcquired = resolve })
  let pending: Promise<boolean>
  try {
    pending = locks.request(lockName(dbName), { mode: 'exclusive', ifAvailable: true }, async (lock: Lock | null) => {
      if (lock === null || heldDatabases.has(dbName)) {
        settleAcquired(false)
        return false
      }
      heldDatabases.add(dbName)
      settleAcquired(true)
      await hold
      return true
    })
  } catch {
    throw new Error('another browser client owns this database')
  }
  pending.then(() => {}, () => { settleAcquired(false) })
  if (!await acquired) {
    try { await pending } catch { /* grant already reported */ }
    throw new Error('another browser client owns this database')
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    releaseHold()
    try { await pending } catch { /* release never fails */ }
    heldDatabases.delete(dbName)
  }
}

async function drain (service: VortexService): Promise<void> {
  try { await service.core().flush() } catch { /* drained if possible */ }
}

export async function startBrowserClient (options: BrowserClientOptions): Promise<BrowserClient> {
  const { dbName, allow, name } = options
  if (typeof dbName !== 'string' || dbName.length < 1 || dbName.length > 128) {
    throw new Error('database name must contain 1 to 128 characters')
  }
  if (!Array.isArray(allow)) throw new Error('allow must be an array of multiaddrs')
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
    throw new Error('name must contain 1 to 64 characters')
  }
  const release = await acquireExclusive(dbName)
  const owned = await openBrowserState(dbName).catch(async (e: unknown) => {
    await release()
    throw e
  })
  try {
    const key = owned.key()
    let transport
    try {
      transport = await createBrowserTransport({ ...(options.transport ?? {}), allow: [...allow], key })
    } finally {
      key.fill(0)
    }
    let service: VortexService
    try {
      service = new VortexService(transport, name, (s) => owned.save(s), owned.snapshot(), options.service ?? {})
    } catch (e) {
      await transport.stop().catch(() => {})
      throw e
    }
    try {
      const info = await service.start()
      let stopPromise: Promise<void> | undefined
      const stop = (): Promise<void> => {
        stopPromise ??= (async () => {
          try {
            await service.stop()
          } catch (e) {
            await drain(service)
            throw e
          } finally {
            await owned.close().catch(() => {})
            await release()
          }
        })()
        return stopPromise
      }
      return { service, info, stop }
    } catch (e) {
      await service.stop().catch(() => {})
      await drain(service)
      throw e
    }
  } catch (e) {
    await owned.close().catch(() => {})
    await release()
    throw e
  }
}
