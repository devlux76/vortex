/**
 * The GossipSub topic names for announcements (Sections 2.2 and 11.5). The
 * protocol version appears in every topic, so incompatible versions exchange
 * nothing. Nothing here imports a Node built-in: the core runs in browsers.
 */

/** Version of the announcement wire format. Appears in every topic name, so incompatible versions exchange nothing. */
export const PROTOCOL_VERSION = 1

const NAMESPACE_PATTERN = /^[0-9a-f]{64}$/

/** The broadcast topic for one namespace: `/vortex/<protocol version>/announce/<namespace>`. */
export function announceTopic (namespace: string): string {
  if (!NAMESPACE_PATTERN.test(namespace)) throw new Error('namespace must be 64 lowercase hexadecimal characters')
  return `/vortex/${PROTOCOL_VERSION}/announce/${namespace}`
}

/** The namespace a topic belongs to, or undefined if it is not an announcement topic of this protocol version. */
export function namespaceOfTopic (topic: string): string | undefined {
  const prefix = `/vortex/${PROTOCOL_VERSION}/announce/`
  if (!topic.startsWith(prefix)) return undefined
  const namespace = topic.slice(prefix.length)
  if (!NAMESPACE_PATTERN.test(namespace)) return undefined
  return namespace
}
