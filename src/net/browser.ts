import { webSockets } from '@libp2p/websockets'
import { createBaseTransport, type BaseTransport, type BaseTransportOptions } from './common.ts'
import type { Multiaddr } from '../types.ts'

/**
 * Browser transport: the same `Transport` contract as the desktop node, but
 * the peer dials service bridges over WebSocket and is never dialed. It has
 * no listen addresses and refuses every dial outside `allow`.
 *
 * Browser-bound: this file and everything it imports use no Node built-in
 * and no `Bun` global, so it can be bundled for an extension.
 */

export interface BrowserTransportOptions extends BaseTransportOptions {
  /** The service WebSocket addresses this peer may dial. Every other address is refused. */
  allow: Multiaddr[]
}

export interface BrowserTransport extends BaseTransport {}

/**
 * Exact string match on the full multiaddr (including `/p2p/<id>`): only the
 * configured bridge addresses may be dialed. Anything else, including other
 * loopback and private addresses, is denied.
 */
export function isAllowedDial (allow: Multiaddr[], addr: { toString(): string }): boolean {
  const s = addr.toString()
  return allow.some(a => a === s)
}

export async function createBrowserTransport (options: BrowserTransportOptions): Promise<BrowserTransport> {
  const allow = [...options.allow]
  return createBaseTransport(options, {
    transports: [webSockets()],
    denyDialMultiaddr: (addr) => !isAllowedDial(allow, addr),
  })
}
