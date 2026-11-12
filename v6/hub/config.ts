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

/**
 * The plain listener carries bearer tokens unencrypted, so it must be loopback
 * (A7 §1): 127.0.0.0/8, ::1 or localhost. Other devices use `tls.listen`.
 */
export function isLoopbackHost (host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h)
}

/** Throws unless `listen` parses and names a loopback host. */
export function assertLoopbackListen (s: string): void {
  const { host } = parseListen(s)
  if (!isLoopbackHost(host)) {
    throw new Error(`hub config listen must be a loopback address (127.0.0.1, ::1 or localhost), got ${JSON.stringify(s)}; use tls.listen for other devices (A7 §1)`)
  }
}

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

/** Numeric keys that may be 0 (pacing intervals); every other numeric key must be at least 1. */
const ZERO_OK = new Set<string>(['wakeCoalesceMs', 'wakeMinIntervalMs'])
const TLS_KEYS = { listen: 'tlsListen', certPath: 'tlsCertPath', keyPath: 'tlsKeyPath' } as const

/**
 * Hub config file `$XDG_CONFIG_HOME/vortex/hub.json` with §8.x defaults.
 * Unknown keys, wrong types and out-of-range numbers are rejected so a typo
 * never silently changes behavior (a quoted number would otherwise make the
 * pacing arithmetic concatenate strings; 0 would disable a limit).
 */
export async function loadHubConfig (): Promise<HubConfig> {
  const roots = hubRoots()
  let text: string
  try {
    text = await Bun.file(roots.hubConfigPath).text()
  } catch (e) {
    if ((e as Error & { code?: string }).code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw e
  }
  return parseHubConfig(JSON.parse(text))
}

/** Validates a parsed hub.json object against the defaults' keys and types. */
export function parseHubConfig (raw: unknown): HubConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('hub config must be a JSON object')
  const cfg: HubConfig = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'listen') {
      if (typeof value !== 'string') throw new Error('hub config listen must be a string')
      assertLoopbackListen(value)
      cfg.listen = value
      continue
    }
    if (key === 'tls') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('hub config tls must be an object')
      for (const [tk, tv] of Object.entries(value as Record<string, unknown>)) {
        if (!Object.hasOwn(TLS_KEYS, tk)) throw new Error(`unknown hub config key: tls.${tk}`)
        if (typeof tv !== 'string' || tv.length === 0) throw new Error(`hub config tls.${tk} must be a non-empty string`)
        if (tk === 'listen') parseListen(tv)
        cfg[TLS_KEYS[tk as keyof typeof TLS_KEYS]] = tv
      }
      continue
    }
    if (!Object.hasOwn(DEFAULT_CONFIG, key) || typeof (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key] !== 'number') throw new Error(`unknown hub config key: ${key}`)
    const min = ZERO_OK.has(key) ? 0 : 1
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      throw new Error(`hub config ${key} must be a whole number >= ${min}, got ${JSON.stringify(value)}`)
    }
    ;(cfg as unknown as Record<string, number>)[key] = value
  }
  return cfg
}
