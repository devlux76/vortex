/**
 * Where a peer can be dialed, carried inside signed records so the signature
 * covers it (Section 4.2).
 *
 * Nothing here imports a Node built-in: the core runs in browsers.
 */
import type { PeerId } from '../types.ts'
import { multiaddr } from '@multiformats/multiaddr'
import { Contact } from './proto/discovery.ts'

/** The bytes of a Contact naming where a peer can be dialed (Section 4.2). */
export function encodeContact (addrs: string[]): Uint8Array {
  return Contact.encode({ addrs })
}

/**
 * Decode a contact and check every address names `peer`.
 * Returns the addresses, or undefined when invalid.
 */
export function openContact (contact: Uint8Array, peer: PeerId): string[] | undefined {
  let addrs: string[]
  try {
    addrs = Contact.decode(contact).addrs
  } catch {
    return undefined
  }
  if (addrs.length < 1 || addrs.length > 8) return undefined
  for (const addr of addrs) {
    if (typeof addr !== 'string' || addr.length >= 512) return undefined
    try {
      const parsed = multiaddr(addr)
      void parsed.bytes // multiaddr parses lazily; reading bytes validates every component
      const last = parsed.getComponents().at(-1)
      if (last?.name !== 'p2p' || last.value !== peer) return undefined
    } catch {
      return undefined
    }
  }
  return addrs
}
