// Hub configuration (docs/v6-proposal.md §8.2–8.5). Every number is a default
// with a config key; changing a default is a spec change (§8 preamble, §7).

export interface HubConfig {
  /** Plain HTTP+WebSocket listener, "127.0.0.1:7900" default (§8.2). */
  listen: string
  /** Optional TLS listener for LAN/Tailscale devices, e.g. ":7901". */
  tlsListen?: string
  /** Self-signed cert/key persisted once; defaults into the state dir. */
  tlsCertPath?: string
  tlsKeyPath?: string
  // message field limits (§8.2)
  bodyMaxBytes: number           // 4 KiB
  toMaxPrincipals: number        // 16
  // rendered batch bounds (§8.4)
  batchMaxMessages: number       // 20
  batchMaxCodePoints: number     // 6000
  batchMaxBytes: number          // 8 KiB
  // wake pacing (§8.5/§8.4)
  wakeCoalesceMs: number         // 2000
  wakeMinIntervalMs: number      // 10000
  wakeHourlyLimit: number        // 60
  wakeWindowMs: number           // 1 h rolling window for wakeHourlyLimit (A4; test seam)
  // send rate (§8.5)
  sendPerMinute: number          // 30
  // loop breaker (§8.5)
  loopBreakerLimit: number       // 12
  // automatic cooldown (A4, docs/v6-amendment-a4-pacing.md)
  cooldownBaseMs: number         // 10 min
  cooldownMaxMs: number          // 2 h
  cooldownDecayMs: number        // 2 h of genuine quiet resets the backoff level
  // pending queue overflow (§8.4)
  pendingMaxMessages: number     // 1000
  pendingMaxBytes: number        // 4 MiB
  // room retention (§8.4)
  roomMaxMessages: number        // 10,000
  roomMaxDays: number            // 30
  // DM retention: same defaults, own config keys
  dmMaxMessages: number
  dmMaxDays: number
  // unacknowledged batch retry (§8.4)
  batchRetryMs: number           // 15 min
  // log endpoints (§8.3)
  logLimitMax: number            // 200
}

export const DEFAULT_CONFIG: HubConfig = {
  listen: '127.0.0.1:7900',
  bodyMaxBytes: 4096,
  toMaxPrincipals: 16,
  batchMaxMessages: 20,
  batchMaxCodePoints: 6000,
  batchMaxBytes: 8 * 1024,
  wakeCoalesceMs: 2000,
  wakeMinIntervalMs: 10000,
  wakeHourlyLimit: 60,
  wakeWindowMs: 3_600_000,
  sendPerMinute: 30,
  loopBreakerLimit: 12,
  cooldownBaseMs: 10 * 60_000,
  cooldownMaxMs: 2 * 3_600_000,
  cooldownDecayMs: 2 * 3_600_000,
  pendingMaxMessages: 1000,
  pendingMaxBytes: 4 * 1024 * 1024,
  roomMaxMessages: 10000,
  roomMaxDays: 30,
  dmMaxMessages: 10000,
  dmMaxDays: 30,
  batchRetryMs: 15 * 60_000,
  logLimitMax: 200,
}

export const PRINCIPAL_RE = /^[a-z][a-z0-9-]{0,31}$/
export const ROOM_RE = /^[a-z0-9-]{1,32}$/
export const BINDING_RE = /^[a-z][a-z0-9-]{0,31}$/

/** Parse "host:port" or ":port"; a bare port parses as loopback. */
export function parseListen (s: string): { host: string; port: number } {
  const trimmed = s.trim()
  const at = trimmed.lastIndexOf(':')
  if (at < 0) {
    const p = Number(trimmed)
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`invalid listen: ${s}`)
    return { host: '127.0.0.1', port: p }
  }
  const host = trimmed.slice(0, at)
  const port = Number(trimmed.slice(at + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid listen: ${s}`)
  return { host: host === '' ? '0.0.0.0' : host, port }
}

export function hubRoots () {
  return {
    config: configDir(),
    state: stateDir(),
    db: join(stateDir(), 'hub.db'),
    hubConfigPath: join(configDir(), 'hub.json'),
    operatorCredentialPath: join(configDir(), 'operator.json'),
  }
}

function home (...p: string[]): string {
  return [process.env.HOME ?? '/root', ...p].join('/')
}

function join (...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export function stateDir (): string {
  const xdg = process.env.XDG_STATE_HOME ?? home('.local/state')
  return `${xdg.replace(/\/$/, '')}/vortex`
}

export function configDir (): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? home('.config')
  return `${xdg.replace(/\/$/, '')}/vortex`
}

/**
 * Hub config file `$XDG_CONFIG_HOME/vortex/hub.json` with §8.x defaults.
 * Unknown keys are rejected so a typo never silently changes behavior.
 */
export async function loadHubConfig (): Promise<HubConfig> {
  const roots = hubRoots()
  try {
    const text = await Bun.file(roots.hubConfigPath).text()
    const raw = JSON.parse(text) as Record<string, unknown>
    const cfg: HubConfig = { ...DEFAULT_CONFIG }
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'listen') { cfg.listen = String(value); continue }
      if (key === 'tls') {
        const t = value as Record<string, unknown>
        if (t.listen !== undefined) cfg.tlsListen = String(t.listen)
        if (t.certPath !== undefined) cfg.tlsCertPath = String(t.certPath)
        if (t.keyPath !== undefined) cfg.tlsKeyPath = String(t.keyPath)
        continue
      }
      if (key in cfg && typeof value === 'number') {
        ;(cfg as any)[key] = value
        continue
      }
      if (key in cfg && typeof value === 'string') { (cfg as any)[key] = value; continue }
      throw new Error(`unknown hub config key: ${key}`)
    }
    return cfg
  } catch (e) {
    if ((e as Error & { code?: string }).code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw e
  }
}
