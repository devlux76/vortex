import { tcp } from '@libp2p/tcp'
import { createBaseTransport, type BaseTransport, type BaseTransportOptions } from './common.ts'
import type { Multiaddr } from '../types.ts'

export interface NodeTransportOptions extends BaseTransportOptions {
  /** Defaults to an ephemeral TCP port on loopback. */
  listen?: Multiaddr[]
}

export interface NodeTransport extends BaseTransport {}

export async function createNodeTransport (options: NodeTransportOptions = {}): Promise<NodeTransport> {
  return createBaseTransport(options, {
    transports: [tcp()],
    listen: options.listen ?? ['/ip4/127.0.0.1/tcp/0'],
  })
}
