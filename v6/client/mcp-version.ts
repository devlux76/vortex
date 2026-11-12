// MCP protocol versions this server speaks, newest first. initialize answers
// the client's requested version when it is one of these and our newest
// otherwise, never an unknown version echoed back (audit finding F26).
export const SUPPORTED_PROTOCOLS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']

export function negotiateProtocol (requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOLS[0]!
}
