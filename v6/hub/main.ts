// vortexd — the v6 hub daemon (docs/v6-proposal.md §3, §8.2, §8.10).
// Boot sequence: state dirs, config load, SQLite store, operator credential
// (mode 0600, once), optional TLS cert (self-signed, generated once), then the
// plain and (optional) TLS listeners. Run: `bun v6/hub/main.ts`
import { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { loadHubConfig, hubRoots, parseListen, assertLoopbackListen, localHubUrl, type HubConfig } from './config.ts'
import { HubStore } from './store.ts'
import { Delivery } from './delivery.ts'
import { Api } from './api.ts'

export interface HubHandles {
  cfg: HubConfig
  tlsPort?: number
  port: number
  store: HubStore
  delivery: Delivery
  api: Api
  stop: () => Promise<void>
  fingerprint: string | undefined
}

export async function startHub (over: { cfg?: Partial<HubConfig>; stateDir?: string; configDir?: string } = {}): Promise<HubHandles> {
  // Test seams first: paths must resolve before the config file is read.
  if (over.stateDir !== undefined) process.env.XDG_STATE_HOME = over.stateDir
  if (over.configDir !== undefined) process.env.XDG_CONFIG_HOME = over.configDir
  const cfg = await loadHubConfig()
  const roots = hubRoots()
  mkdirSync(roots.config, { recursive: true, mode: 0o700 })
  mkdirSync(roots.state, { recursive: true, mode: 0o700 })
  for (const [k, v] of Object.entries(over.cfg ?? {})) {
    ;(cfg as any)[k] = v
  }
  assertLoopbackListen(cfg.listen) // A7 §1: also covers programmatic overrides
  const store = new HubStore(roots.db, cfg)
  const delivery = new Delivery(store, cfg)
  delivery.start() // A4: expire cooldowns that passed while down; arm the next expiry
  const api = new Api({ cfg, store, delivery })

  // Operator credential (§8.10): created by hub initialization, mode 0600,
  // on the hub host; `vx enroll` must never create the operator principal.
  const operatorPath = roots.operatorCredentialPath
  if (!store.operatorExists()) {
    // Operator messages must be human (§8.5) and only the operator socket
    // carries that identity (§8.2/§8.10); the credential file is mode 0600.
    const { token } = store.createPrincipalUnchecked('operator')
    const credential = { principal: 'operator', token, hub: localHubUrl(cfg.listen) }
    writeFileSync(operatorPath, JSON.stringify(credential, null, 2), { mode: 0o600 })
    chmodSync(operatorPath, 0o600)
  } else if (!existsSync(operatorPath)) {
    // Credential file lost: the operator can re-provision only by removing the
    // principal row; never silently mint a second operator credential.
    console.error('[vortexd] operator principal exists but the credential file is missing at', operatorPath)
  }

  // TLS listener (§8.2): self-signed cert generated once, fingerprint printed.
  let fingerprint: string | undefined
  const certPath = cfg.tlsCertPath ?? `${roots.state}/cert.pem`
  const keyPath = cfg.tlsKeyPath ?? `${roots.state}/key.pem`
  if (cfg.tlsListen !== undefined) {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      const gen = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
        '-subj', '/CN=vortex-hub', '-keyout', keyPath, '-out', certPath])
      if (gen.exitCode !== 0) {
        console.error('[vortexd] openssl certificate generation failed:', new TextDecoder().decode(gen.stderr))
        throw new Error('openssl is required to generate the TLS certificate')
      }
      chmodSync(keyPath, 0o600)
      chmodSync(certPath, 0o600)
    }
    const der = Bun.spawnSync(['openssl', 'x509', '-in', certPath, '-outform', 'DER']).stdout
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(der)
    fingerprint = hasher.digest('hex')
  }

  const listen = parseListen(cfg.listen)
  const handlers = api.handlers()
  const plain = Bun.serve({
    hostname: listen.host,
    port: listen.port,
    websocket: handlers.websocket,
    // A tunnel or reverse proxy aimed at the loopback listener would make
    // remote traffic look local (A7 §1). Requests it forwards carry one of
    // these headers; refuse them before authentication or upgrade.
    fetch: (req: Request, server: any) => {
      const via = forwardedBy(req)
      if (via !== undefined) {
        console.error(`[vortexd] refused forwarded request on the loopback listener (${via}); point tunnels at tls.listen`)
        return new Response('forwarded requests are not accepted on the loopback listener; use the TLS listener', { status: 421 })
      }
      return handlers.fetch(req, server)
    },
  })

  let tls: ReturnType<typeof Bun.serve> | undefined
  let tlsPort: number | undefined
  if (cfg.tlsListen !== undefined) {
    const tl = parseListen(cfg.tlsListen)
    const tlsOpts = { cert: readFileSync(certPath), key: readFileSync(keyPath) } as const
    tls = Bun.serve({
      hostname: tl.host,
      port: tl.port,
      ...api.handlers(),
      tls: tlsOpts as any,
    })
    tlsPort = tls.port
  }

  console.error(`[vortexd] listening on ${plain.hostname}:${plain.port}` +
    (tlsPort !== undefined ? ` and TLS :${tlsPort}` : '') +
    (fingerprint !== undefined ? ` (cert sha256 ${fingerprint})` : ''))

  const stop = async (): Promise<void> => {
    delivery.stop()
    plain.stop(true)
    tls?.stop(true)
    store.close()
  }
  return { cfg, port: plain.port ?? listen.port, tlsPort, store, delivery, api, stop, fingerprint }}

// Executed directly (not when imported by tests).
const isMain = process.argv[1] === import.meta.path
void (async () => {
  if (!isMain) return
  await startHub()
})()

/** Headers added by reverse proxies and tunnels (A7 §1). */
export const FORWARDING_HEADERS = [
  'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-forwarded-server', 'x-real-ip', 'x-client-ip', 'cf-connecting-ip', 'true-client-ip', 'fastly-client-ip',
  'tailscale-user-login', 'tailscale-funnel-request',
] as const

/** The first forwarding header present on `req`, or undefined. */
export function forwardedBy (req: Request): string | undefined {
  return FORWARDING_HEADERS.find(h => req.headers.has(h))
}
