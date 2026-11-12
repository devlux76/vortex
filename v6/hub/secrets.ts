// Outbound credential screen (docs/v6-amendment-a6-secrets.md §1). The hub
// refuses a message whose text contains a credential-shaped string, so a peer
// that asks for a key as the price of help cannot receive one through VORTEX.
// Patterns are high-precision shapes of real credential formats, not a general
// secret detector: ordinary prose and code must pass. The matched text is never
// echoed, logged or stored; only the kind name is reported.

interface Shape { kind: string; re: RegExp }

// Every pattern requires the issuer's literal prefix plus a long random tail,
// so placeholders such as `Bearer <token>` or `sk-...` do not match.
const SHAPES: readonly Shape[] = [
  { kind: 'vortex-token', re: /(?<![A-Za-z0-9])vt_[A-Za-z0-9_-]{40,}/ },
  { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: 'aws-access-key', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/ },
  { kind: 'github-token', re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/ },
  { kind: 'anthropic-key', re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'openai-key', re: /(?<![A-Za-z0-9])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: 'slack-token', re: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: 'google-api-key', re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/ },
  { kind: 'stripe-key', re: /(?<![A-Za-z0-9])[rs]k_live_[A-Za-z0-9]{20,}/ },
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'bearer-credential', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
]

/** Kind names, in check order (for tests and documentation). */
export const SECRET_KINDS: readonly string[] = SHAPES.map(s => s.kind)

/** Returns the kind of the first credential-shaped string in `text`, or undefined. */
export function findSecret (text: string): string | undefined {
  for (const s of SHAPES) if (s.re.test(text)) return s.kind
  return undefined
}

export interface RefusalRecord { principal: string; count: number; lastAt: number; lastKind: string }

/**
 * In-memory tally of refused sends per principal since hub start, shown in
 * `/v1/status` so the operator learns of an attempt even when the agent does
 * not report it (A6 §2). Holds no message text.
 */
export class SecretRefusals {
  private byPrincipal = new Map<string, RefusalRecord>()

  record (principal: string, kind: string, now = Date.now()): void {
    const prev = this.byPrincipal.get(principal)
    this.byPrincipal.set(principal, { principal, count: (prev?.count ?? 0) + 1, lastAt: now, lastKind: kind })
  }

  list (): RefusalRecord[] {
    return [...this.byPrincipal.values()].sort((a, b) => a.principal.localeCompare(b.principal))
  }
}
