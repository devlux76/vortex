// Starts a VORTEX v6 hub for the two-device acceptance (peer-check.ts) with its
// TLS listener on a reachable address, enrolls two principals and writes their
// pinned wss:// credentials. Hub state lives under --dir (kept between runs).
//   bun device-hub.ts --dir <state dir> --tls <ip:port> [--a dev-a] [--b dev-b]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { startHub } from '../hub/main.ts'

const f = new Map<string, string>()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--') && argv[i + 1] !== undefined) { f.set(argv[i].slice(2), argv[i + 1]); i++ }
const dir = f.get('dir'); const tls = f.get('tls')
if (dir === undefined || tls === undefined || !/^[0-9.]+:[0-9]+$/.test(tls)) { console.error('usage: device-hub --dir <dir> --tls <ip:port> [--a dev-a] [--b dev-b]'); process.exit(2) }
mkdirSync(dir, { recursive: true, mode: 0o700 })
const hub = await startHub({ stateDir: `${dir}/state`, configDir: `${dir}/config`, cfg: { listen: '127.0.0.1:0', tlsListen: tls } as any })
const host = tls.split(':')[0]
for (const name of [f.get('a') ?? 'dev-a', f.get('b') ?? 'dev-b']) {
  const file = `${dir}/${name}.json`
  const url = `wss://${host}:${hub.tlsPort}`
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    if (c.fingerprint === hub.fingerprint && c.principal === name && typeof c.token === 'string') {
      // Same hub identity: keep principal/token, refresh the endpoint if --tls moved.
      if (c.hub !== url) { writeFileSync(file, JSON.stringify({ ...c, hub: url }, null, 2) + '\n', { mode: 0o600 }); console.error(`device-hub: ${name} endpoint refreshed ${c.hub} -> ${url}`) }
      continue
    }
    console.error(`device-hub: ${file} belongs to a different hub identity (fingerprint/principal mismatch); use a fresh --dir`)
    process.exit(1)
  }
  let token: string
  try { token = hub.store.createPrincipal(name).token } catch (e) { console.error(`device-hub: cannot enroll ${name}: ${(e as Error).message} (an existing principal without its credential file needs a fresh --dir)`); process.exit(1) }
  writeFileSync(file, JSON.stringify({ principal: name, token, hub: url, fingerprint: hub.fingerprint }, null, 2) + '\n', { mode: 0o600 })
}
console.error(`device-hub: TLS wss://${host}:${hub.tlsPort} fingerprint ${hub.fingerprint}; credentials in ${dir}`)
setInterval(() => {}, 1 << 30)
