// Per-principal credential files under $XDG_CONFIG_HOME/vortex/<name>.json,
// mode 0600 (§8.6 claude.json, §8.10 operator.json, §8.8 plugin configs).
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface Credential {
  hub: string
  token: string
  principal?: string
  binding?: string
  /** sha256 hex of the hub TLS cert; pinned at enrollment (§8.2). */
  fingerprint?: string
  /** Plugin-local extensions live beside these fields. */
  [extra: string]: unknown
}

export function vortexConfigDir (): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME ?? '/root'}/.config`
  return `${xdg.replace(/\/$/, '')}/vortex`
}

export function credentialPath (name: string): string {
  return `${vortexConfigDir()}/${name}.json`
}

export function loadCredential (name: string): Credential | undefined {
  const path = credentialPath(name)
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Credential
  if (typeof parsed.hub !== 'string' || typeof parsed.token !== 'string') {
    throw new Error(`invalid credential file: ${path}`)
  }
  return parsed
}

export function saveCredential (name: string, credential: Credential): void {
  mkdirSync(vortexConfigDir(), { recursive: true, mode: 0o700 })
  const path = credentialPath(name)
  writeFileSync(path, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
