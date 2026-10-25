/**
 * Where a peer can be dialed, carried inside signed records so the signature
 * covers it (Section 4.2).
 *
 * Nothing here imports a Node built-in: the core runs in browsers.
 */
import type { PeerId } from '../types.ts'
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
    if (typeof addr !== 'string' || addr.length >= 512 || !addr.endsWith('/p2p/' + peer)) return undefined
  }
  return addrs
}
