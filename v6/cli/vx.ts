// vx — operator CLI (docs/v6-proposal.md §8.10, A1 §8.13). Run on the hub
// host (or wherever the operator credential is provisioned):
//   bun v6/cli/vx.ts <command> [...]
// Commands: enroll, say, log, status, binding release, hook context (Claude
// plugin, §8.6). `vx codex bind` selects the Codex chat (§8.7).
import { mkdirSync, existsSync } from 'node:fs'
import { VortexClient } from '../client/client.ts'
import { loadCredential, vortexConfigDir } from '../client/credential.ts'
import { logLine } from '../client/render.ts'
import { HubStore } from '../hub/store.ts'
import { hubRoots, PRINCIPAL_RE } from '../hub/config.ts'
import { hookContext } from './hook.ts'
import { codexBind } from './codex.ts'
import { uninstallFiles } from './uninstall.ts'
import { installPrincipal } from './install.ts'
import { keysMain } from './keys.ts'

const USAGE = `vx — operator CLI for VORTEX v6

  vx enroll <name>                          enroll a principal (hub host)
  vx enroll <name> --key <spki-b64> [--alg ed25519|p256] [--custody C] [--rooms a,b] [--ttl-hours N]
                                            enroll a device's public key (A7; no secret moves)
  vx key list [<principal>] | vx key revoke <key-id>
  vx edge keygen|send|read ...              signed HTTP edge client (A7 §3; see v6/cli/keys.ts)
  vx install <principal>                    enroll and write its credential file (hub host, local agent)
  vx say [--to a,b] [--room r] [--scope room|dm] [--reply-to <id>] <text>
  vx log [<room>]|--dm [--after seq] [--limit n]   ids + refs printed (A1)
  vx status
  vx binding release <principal>/<name>
  vx codex bind [<thread-id>]               select the Codex chat for wakes (default $CODEX_THREAD_ID)
  vx uninstall <principal>                  remove that agent's local credential and state files
  vx hook context [--host claude|codex]     (plugins only: hook event JSON on stdin)
`

function die (message: string): never {
  console.error(`vx: ${message}`)
  process.exit(1)
}

function operatorClient (): VortexClient {
  const credential = loadCredential('operator')
  if (credential === undefined) {
    die(`no operator credential at ${vortexConfigDir()}/operator.json; run vortexd on this machine (bun v6/hub/main.ts)`)
  }
  return new VortexClient(credential!)
}

/** Parses `--flag value` flags and trailing positional words from argv. */
function parseArgs (rest: string[]): { flags: Map<string, string>; bare: string[]; bools: Set<string> } {
  const flags = new Map<string, string>()
  const bare: string[] = []
  const bools = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) { bare.push(a); continue }
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++ } else { bools.add(a.slice(2)) }
  }
  return { flags, bare, bools }
}

async function main (): Promise<void> {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE)
    process.exit(0)
  }

  if (await keysMain(command, rest)) return
  if (command === 'enroll') {
    const name = rest[0]
    if (name === undefined || !PRINCIPAL_RE.test(name)) die(`enroll takes a principal name matching ${PRINCIPAL_RE}`)
    const roots = hubRoots()
    if (!existsSync(roots.db)) die(`no hub database at ${roots.db}; run vortexd on this host first`)
    mkdirSync(roots.config, { recursive: true, mode: 0o700 })
    const store = new HubStore(roots.db)
    let token = ''
    try {
      token = store.createPrincipal(name).token
    } catch (e) {
      const message = (e as Error).message
      if (message.includes('UNIQUE')) die('already enrolled')
      if (message.includes('operator')) die(message)
      throw e
    } finally {
      store.close()
    }
    // Fingerprint is available when a TLS cert exists on this host (§8.2);
    // other-device enrollment prints it from the operator's console instead.
    let fingerprint: string | undefined
    const certPath = `${roots.state}/cert.pem`
    if (existsSync(certPath)) {
      const der = Bun.spawnSync(['openssl', 'x509', '-in', certPath, '-outform', 'DER']).stdout
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(der)
      fingerprint = hasher.digest('hex')
    }
    console.log(`token: ${token}`)
    if (fingerprint !== undefined) console.log(`fingerprint: ${fingerprint}`)
    console.log('(stored hashed by the hub; shown once — keep it in the client credential file)')
    return
  }

  if (command === 'say') {
    const { flags, bare } = parseArgs(rest)
    const text = bare.join(' ')
    if (text.length === 0) die('say takes the message text')
    const scope = flags.get('scope') as 'room' | 'dm' | undefined
    if (scope !== undefined && scope !== 'room' && scope !== 'dm') die('scope is room|dm')
    const room = flags.get('room')
    if (scope === 'dm' && room !== undefined) die('a DM takes no room')
    const to = (flags.get('to') ?? '').split(',').filter(w => w.length > 0)
    if (scope === 'dm' && to.length !== 1) die('a DM needs exactly one recipient: --to <name>')
    const client = operatorClient()
    const { id, seq } = await client.send({
      text,
      ...(scope === undefined ? {} : { scope }),
      ...(room === undefined ? {} : { room }),
      ...(to.length === 0 ? {} : { to }),
      ...(flags.get('reply-to') === undefined ? {} : { reply_to: flags.get('reply-to') }),
    })
    console.log(`${id} seq ${seq}`)
    return
  }

  if (command === 'log') {
    const { flags, bare, bools } = parseArgs(rest)
    const after = Number(flags.get('after') ?? 0)
    const limit = Number(flags.get('limit') ?? 100)
    if (!Number.isInteger(after) || !Number.isInteger(limit)) die('log flags --after/--limit take integers')
    const client = operatorClient()
    if (bools.has('dm')) {
      // A1: the operator-visible reference source for /vx-reply.
      const res = await client.dmLog(after, limit)
      for (const m of res.messages) console.log(logLine(m))
      return
    }
    // Room goes positionally (`vx log all`) or via --room; not both.
    const room = bare.length === 1 ? bare[0] : flags.get('room')
    if (room === undefined) die('log takes a room: vx log <room>  (or vx log --dm)')
    const res = await client.roomLog(room, after, limit)
    for (const m of res.messages) console.log(logLine(m))
    return
  }

  if (command === 'status') {
    const client = operatorClient()
    console.log(JSON.stringify(await client.status(), null, 2))
    return
  }

  if (command === 'binding') {
    if (rest[0] !== 'release') die('binding takes "release <principal>/<name>"')
    const [principal, name] = (rest[1] ?? '').split('/')
    if (!principal || !name) die('binding release takes <principal>/<name>')
    const client = operatorClient()
    await client.release(principal, name)
    console.log(`released ${principal}/${name}`)
    return
  }

  if (command === 'install') {
    try {
      const { credentialPath, hub } = await installPrincipal(rest[0] ?? '')
      console.log(`enrolled ${rest[0]}; credential for ${hub} written to ${credentialPath}`)
    } catch (e) {
      die((e as Error).message)
    }
    return
  }

  if (command === 'uninstall') {
    let removed: string[] = []
    try {
      removed = uninstallFiles(rest[0] ?? '', hubRoots())
    } catch (e) {
      die((e as Error).message)
    }
    console.log(removed.length === 0 ? 'nothing to remove' : removed.map(p => `removed ${p}`).join('\n'))
    return
  }

  if (command === 'codex') {
    if (rest[0] !== 'bind') die('codex takes "bind [<thread-id>]"')
    process.exit(await codexBind(rest.slice(1)))
  }

  if (command === 'hook') {
    if (rest[0] !== 'context') die('hook takes "context"')
    const h = rest.indexOf('--host')
    const host = h >= 0 ? rest[h + 1] : 'claude'
    if (host !== 'claude' && host !== 'codex') die('hook --host is claude|codex')
    await hookContext(host)
    process.exit(0)
  }

  die(`unknown command: ${command}
${USAGE}`)
}

void main()
