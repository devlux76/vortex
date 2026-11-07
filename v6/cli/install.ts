// vx install <principal>: on the hub host, enroll the agent and write its
// credential file in one step, replacing "enroll, then copy the printed token
// into <principal>.json by hand" (docs/v6-proposal.md acceptance table, "one
// install command per harness"). An agent on another machine still needs the
// printed-token route (vx enroll) with the hub's TLS address.
import { existsSync } from 'node:fs'
import { credentialPath, saveCredential } from '../client/credential.ts'
import { hubRoots, loadHubConfig, parseListen, PRINCIPAL_RE } from '../hub/config.ts'
import { HubStore } from '../hub/store.ts'

const RESERVED = new Set(['operator', 'hub'])

export async function installPrincipal (principal: string): Promise<{ credentialPath: string, hub: string }> {
  if (!PRINCIPAL_RE.test(principal) || RESERVED.has(principal)) {
    throw new Error(`not an agent principal: ${JSON.stringify(principal)}`)
  }
  const roots = hubRoots()
  if (!existsSync(roots.db)) throw new Error(`no hub database at ${roots.db}; start the hub on this host first`)
  const path = credentialPath(principal)
  if (existsSync(path)) throw new Error(`${path} already exists; remove it with vx uninstall ${principal} first`)

  // the same local address the hub writes into the operator credential
  const hub = `ws://127.0.0.1:${parseListen((await loadHubConfig()).listen).port}`
  const store = new HubStore(roots.db)
  let token: string
  try {
    token = store.createPrincipal(principal).token
  } finally {
    store.close()
  }
  saveCredential(principal, { hub, token, principal })
  return { credentialPath: path, hub }
}
