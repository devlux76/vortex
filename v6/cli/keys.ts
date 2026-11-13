// Key enrollment and the signed HTTP edge (A7 §3–§4), as `vx` subcommands:
//   vx enroll <name> --key <spki-b64> [--alg ed25519|p256] [--custody C] [--rooms a,b] [--ttl-hours N]
//   vx key list [<principal>] | vx key revoke <key-id>
//   vx edge keygen --principal <name> --out <file> [--alg ed25519|p256] [--hub <url>] [--hub-id <fp>]
//   vx edge send --key <file> [--room r] [--to a,b] <text>
//   vx edge read --key <file> [--room r | --dm] [--after seq] [--follow]
// Enrollment moves only a public key; no secret crosses machines.
import { existsSync } from 'node:fs'
import { HubStore } from '../hub/store.ts'
import { hubRoots, PRINCIPAL_RE, ROOM_RE } from '../hub/config.ts'
import { addKey, listKeys, revokeKey, CUSTODY, UNSEALED_MAX_TTL_MS, type Custody, type KeyRow } from '../hub/store-keys.ts'
import { ALGS, keyIdOf, type KeyAlg } from '../client/edge-sign.ts'
import { EdgeClient, generateEdgeKey, writeKeyFile } from '../client/edge.ts'
import { logLine } from '../client/render.ts'

function die (message: string): never {
  console.error(`vx: ${message}`)
  process.exit(1)
}

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

/** The hub id bound into signatures: SHA-256 of the TLS certificate DER, if one exists. */
export function hubFingerprint (stateDir: string): string | undefined {
  const certPath = `${stateDir}/cert.pem`
  if (!existsSync(certPath)) return undefined
  const der = Bun.spawnSync(['openssl', 'x509', '-in', certPath, '-outform', 'DER']).stdout
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(der)
  return hasher.digest('hex')
}

export interface EnrollKeyArgs {
  principal: string
  spkiB64: string
  alg: KeyAlg
  custody: Custody
  rooms: string[] | null
  ttlHours?: number
}

/** Enrolls a public key, creating the principal if needed. Validates the key by importing it. */
export async function enrollKey (store: HubStore, a: EnrollKeyArgs, now = Date.now()): Promise<KeyRow> {
  if (!PRINCIPAL_RE.test(a.principal)) throw new Error(`principal must match ${PRINCIPAL_RE}`)
  if (a.principal === 'operator' && a.custody === 'unsealed') throw new Error('the operator may not hold an unsealed key')
  for (const r of a.rooms ?? []) if (!ROOM_RE.test(r)) throw new Error(`invalid room: ${r}`)
  const spki = new Uint8Array(Buffer.from(a.spkiB64, 'base64'))
  await crypto.subtle.importKey('spki', spki, ALGS[a.alg].importParams, true, ['verify'])
    .catch(() => { throw new Error(`--key is not a valid ${a.alg} SubjectPublicKeyInfo`) })
  const ttlMs = a.ttlHours === undefined ? (a.custody === 'unsealed' ? 24 * 3_600_000 : undefined) : a.ttlHours * 3_600_000
  if (a.custody === 'unsealed' && ttlMs !== undefined && ttlMs > UNSEALED_MAX_TTL_MS) throw new Error('an unsealed key may live at most 168 hours')
  // A key-only principal still needs a principals row; its minted token is
  // discarded unseen, so no bearer credential exists for it.
  if (!store.principalExists(a.principal)) store.createPrincipal(a.principal)
  return addKey(store, {
    key_id: await keyIdOf(spki),
    principal: a.principal,
    alg: a.alg,
    spki: Buffer.from(spki).toString('base64'),
    custody: a.custody,
    rooms: a.rooms,
    expires: ttlMs === undefined ? null : now + ttlMs,
  }, now)
}

function hubStore (): HubStore {
  const roots = hubRoots()
  if (!existsSync(roots.db)) die(`no hub database at ${roots.db}; run vortexd on this host first`)
  return new HubStore(roots.db)
}

function describe (k: KeyRow): string {
  const state = k.revoked !== null ? 'revoked' : k.expires !== null && Date.now() >= k.expires ? 'expired' : 'active'
  const rooms = k.rooms === null ? 'any room' : `rooms ${k.rooms.join(',')}`
  const exp = k.expires === null ? 'no expiry' : `expires ${new Date(k.expires).toISOString()}`
  return `${k.key_id}  ${k.principal}  ${k.alg}  custody=${k.custody}  ${rooms}  ${exp}  ${state}`
}

/** Handles `enroll --key`, `key` and `edge`. Returns false when the command is not one of these. */
export async function keysMain (command: string, rest: string[]): Promise<boolean> {
  if (command === 'enroll' && rest.includes('--key')) {
    const { flags, bare } = parseArgs(rest)
    const alg = (flags.get('alg') ?? 'ed25519') as KeyAlg
    if (!(alg in ALGS)) die('--alg must be ed25519 or p256')
    const custody = (flags.get('custody') ?? 'unsealed') as Custody
    if (!CUSTODY.includes(custody)) die(`--custody must be one of ${CUSTODY.join(', ')}`)
    const rooms = flags.has('rooms') ? flags.get('rooms')!.split(',').filter(Boolean) : null
    const ttl = flags.has('ttl-hours') ? Number(flags.get('ttl-hours')) : undefined
    if (ttl !== undefined && !(Number.isFinite(ttl) && ttl > 0)) die('--ttl-hours must be a positive number')
    const store = hubStore()
    try {
      const k = await enrollKey(store, { principal: bare[0] ?? '', spkiB64: flags.get('key') ?? '', alg, custody, rooms, ttlHours: ttl })
      console.log(describe(k))
      const fp = hubFingerprint(hubRoots().state)
      console.log(fp === undefined
        ? 'hub id: none yet (configure tls.listen and start the hub; signed requests need the TLS listener)'
        : `hub id: ${fp}`)
      console.log('Compare the key id with the one the device printed. Only the public key is stored.')
    } catch (e) { die((e as Error).message) } finally { store.close() }
    return true
  }
  if (command === 'key') {
    const store = hubStore()
    try {
      if (rest[0] === 'list') for (const k of listKeys(store, rest[1])) console.log(describe(k))
      else if (rest[0] === 'revoke' && rest[1] !== undefined) console.log(revokeKey(store, rest[1]) ? `revoked ${rest[1]}` : die('no such active key'))
      else die('usage: vx key list [<principal>] | vx key revoke <key-id>')
    } finally { store.close() }
    return true
  }
  if (command === 'edge') return edgeMain(rest)
  return false
}

async function edgeMain (rest: string[]): Promise<boolean> {
  const [sub, ...args] = rest
  const { flags, bare, bools } = parseArgs(args)
  if (sub === 'keygen') {
    const principal = flags.get('principal')
    const out = flags.get('out')
    if (principal === undefined || !PRINCIPAL_RE.test(principal) || out === undefined) die('usage: vx edge keygen --principal <name> --out <file> [--alg ed25519|p256] [--hub <url>] [--hub-id <fp>]')
    if (existsSync(out)) die(`${out} already exists`)
    const alg = (flags.get('alg') ?? 'ed25519') as KeyAlg
    if (!(alg in ALGS)) die('--alg must be ed25519 or p256')
    const k = await generateEdgeKey(alg)
    writeKeyFile(out, { v: 1, principal, alg, key_id: k.keyId, custody: 'unsealed', hub_url: flags.get('hub'), hub_id: flags.get('hub-id'), jwk: k.jwk })
    console.log(`key id: ${k.keyId}`)
    console.log(`public key (spki, base64): ${k.spkiB64}`)
    console.log(`custody: unsealed (private key in ${out}, mode 0600, readable by this user)`)
    console.log(`On the hub host: vx enroll ${principal} --key ${k.spkiB64} --alg ${alg} --custody unsealed --rooms <room> --ttl-hours 24`)
    return true
  }
  const keyPath = flags.get('key')
  if (keyPath === undefined) die('usage: vx edge send|read --key <file> ...')
  const client = await EdgeClient.fromKeyFile(keyPath, { url: flags.get('hub'), hubId: flags.get('hub-id'), insecureLoopback: bools.has('insecure-loopback') })
  if (sub === 'send') {
    const text = bare.join(' ')
    if (text === '') die('send needs text')
    const to = flags.get('to')?.split(',').filter(Boolean)
    console.log(JSON.stringify(await client.send({ text, room: flags.get('room'), to })))
    return true
  }
  if (sub === 'read') {
    let after = Number(flags.get('after') ?? 0)
    const dm = bools.has('dm')
    const room = flags.get('room') ?? 'all'
    for (;;) {
      const messages = dm ? await client.dms(after) : await client.roomLog(room, after)
      for (const m of messages) { console.log(logLine(m)); after = Math.max(after, m.seq) }
      if (!bools.has('follow')) break
      await Bun.sleep(messages.length > 0 ? 250 : 3000)
    }
    console.error(`[vx edge] next --after ${after}`)
    return true
  }
  die('usage: vx edge keygen|send|read ...')
}
