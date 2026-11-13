// #15 local rehearsal: brings the whole VORTEX v6 topology up on one machine,
// exercises every leg with a transcript in #10's contract shape, and tears it
// all down. Legs covered here:
//   hub        TLS listener with a once-generated self-signed certificate
//              (v6/hub/main.ts) and a plain HTTP listener.
//   relay      Circuit Relay v2 + rendezvous, admission-gated by the hub's
//              principal_keys (v6/p2p/relay.ts, v6/p2p/admission.ts).
//   node       a p2p peer: relay reservation, rendezvous register + discover.
//   bridge     a hub binding over wss (v6/client/bridge-base.ts) fed by the
//              same token-authenticated stream the OpenCode/Codex plugins use.
//   edge       an edge client doing SIGNED HTTP against the hub TLS listener
//              (v6/client/edge.ts, A7 §3), the way Clouds connects.
//   moon       NOT covered: that leg is Sun's (#16, browser rerun) and stays a
//              marked hook — the topology here (relay + rendezvous + admission)
//              is exactly what the Moon page joins in v6/tools/moon/serve.ts.
// Transcript contract (#10): the same row shapes as the Moon page's
// transcript/check/stage bookkeeping (v6/tools/moon/moon.js), written as JSON.
//   bun v6/tools/rehearsal.ts [--dir <dir>] [--moon]
// Exit code 0 when every check passes, 1 otherwise. The transcript is written
// to <dir>/transcript.json and printed.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import { startRelay } from '../p2p/relay.ts'
import { startPeer, type Peer } from '../p2p/node.ts'
import { loadOrCreateKey } from '../p2p/identity.ts'
import { edgeKeyFromLibp2p } from '../bridge/identity.ts'
import { enrollKey } from '../cli/keys.ts'
import { EdgeClient, generateEdgeKey, writeKeyFile } from '../client/edge.ts'
import { BridgeBase } from '../client/bridge-base.ts'
import type { Credential } from '../client/credential.ts'
import type { HostName } from '../client/hooksocket.ts'
import type { Evidence, WireApiMessage } from '../client/client.ts'

const argv = process.argv.slice(2)
const autoDir = !argv.includes('--dir')
const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1]! : mkdtempSync(join(tmpdir(), 'vx-rehearsal-'))
const wantMoon = argv.includes('--moon')

// #10 transcript contract shapes.
const state = { run_id: `R${Date.now().toString(36)}`, stages: [] as string[], checks: [] as Array<{ label: string, ok: boolean, data: unknown }>, transcript: [] as Array<{ speaker: string, turn: string, text: string }> }
const stage = (value: string): void => { state.stages.push(value) }
const check = (label: string, ok: boolean, data: unknown): void => { state.checks.push({ label, ok, data }) }
const transcript = (speaker: string, turn: string, text: string): void => { state.transcript.push({ speaker, turn, text }) }

// The bridge leg: a minimal BridgeBase — OpenCode-style (no hook socket), wake
// batches land in the transcript and are acked with hook evidence.
class RehearsalBridge extends BridgeBase {
  protected override readonly host: HostName = 'opencode'
  protected override readonly hookSocket = false
  protected override readonly wakeEvidence: Evidence = 'hook-returned'
  readonly inbox: WireApiMessage[] = []
  streamUp = false
  lastHubError = ''
  protected override streamOpened (): void { this.streamUp = true }
  protected override hubFailed (reason: string): void { this.lastHubError = reason }
  protected override async onWake (batch: string, messages: WireApiMessage[]): Promise<void> {
    this.inbox.push(...messages)
    for (const m of messages) transcript('bridge', 'wake', `${m.from ?? '?'}: ${String(m.text ?? '')}`)
    this.ack(batch, this.wakeEvidenceFor(batch))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const main = async (): Promise<number> => {
  stage('hub')
  const stateDir = join(dir, 'state')
  const hub = await startHub({ stateDir, configDir: join(dir, 'config'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0' } })
  if (hub.tlsPort === undefined) throw new Error('the hub TLS listener did not start')
  const tlsPort: number = hub.tlsPort
  check('hub up (http + TLS, self-signed)', tlsPort > 0, { httpPort: hub.port, tlsPort, fingerprint: hub.fingerprint })
  const hubUrl = `https://127.0.0.1:${tlsPort}`
  const hubWs = `wss://127.0.0.1:${tlsPort}`

  // Principals: a bridge principal with a bearer token (the binding owner),
  // an edge principal with an unsealed signed key (A7 §3a: room-capped).
  stage('enroll')
  const bridgeToken = hub.store.createPrincipal('bridge').token
  const edge = await generateEdgeKey()
  writeKeyFile(join(dir, 'edge.key'), {
    v: 1, principal: 'edge', alg: 'ed25519', key_id: edge.keyId, custody: 'unsealed',
    hub_id: hub.fingerprint, hub_url: hubUrl, jwk: edge.jwk,
  })
  await enrollKey(hub.store, { principal: 'edge', spkiB64: edge.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['rehearsal'] })
  check('principals enrolled (bridge token, edge unsealed key)', true, { edgeKeyId: edge.keyId })

  // Relay with rendezvous, admission-gated by the hub's principal_keys.
  stage('relay')
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'], admitDb: join(stateDir, 'vortex', 'hub.db'), revocationSweepMs: 0 })
  const relayAddr = relay.addrs()[0]!.toString()
  check('relay reservation service up (admission on)', relayAddr.startsWith('/ip4/'), { addr: relayAddr })

  // Node leg: two p2p peers reserve with the relay, register and discover
  // each other (rendezvous discovery excludes a peer's own registration,
  // v6/p2p/node.ts, so one peer alone would discover nothing).
  stage('node')
  let peer: Peer | undefined
  let peer2: Peer | undefined
  const peerKeyFile = join(dir, 'peer.key')
  const priv = await loadOrCreateKey(peerKeyFile)
  const material = await edgeKeyFromLibp2p(priv)
  await enrollKey(hub.store, { principal: 'peer', spkiB64: material.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['rehearsal'] })
  peer = await startPeer({ keyFile: peerKeyFile, relay: relayAddr })
  const ttl = await peer.register('rehearsal')
  check('node: relay reservation + rendezvous register', ttl > 0, { ttl })
  const peer2KeyFile = join(dir, 'peer2.key')
  const priv2 = await loadOrCreateKey(peer2KeyFile)
  const material2 = await edgeKeyFromLibp2p(priv2)
  await enrollKey(hub.store, { principal: 'peer2', spkiB64: material2.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['rehearsal'] })
  peer2 = await startPeer({ keyFile: peer2KeyFile, relay: relayAddr })
  await peer2.register('rehearsal')
  const discovered = (await peer.discover('rehearsal')).map(p => p.id.toString())
  check('node: rendezvous discover sees the other peer', discovered.includes(peer2.id.toString()), { found: discovered.length })
  const discovered2 = (await peer2.discover('rehearsal')).map(p => p.id.toString())
  check('node: discover is symmetric', discovered2.includes(peer.id.toString()), { found: discovered2.length })

  // Bridge leg: binding over the hub's TLS stream, fed the same way the
  // OpenCode/Codex plugins are (bearer token + fingerprint pin).
  stage('bridge')
  const credential: Credential = { principal: 'bridge', token: bridgeToken, hub: hubWs, fingerprint: hub.fingerprint }
  const bridge = new RehearsalBridge({ credential, binding: 'rehearsal', rooms: ['rehearsal'], stateFile: join(dir, 'bridge-state.json') }, 'opencode')
  const bindRes = await fetch(new URL('/v1/bindings/rehearsal', hubUrl), {
    method: 'PUT', headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ rooms: ['rehearsal'] }), tls: { rejectUnauthorized: false },
  } as RequestInit)
  check('binding created over TLS (bearer token)', bindRes.ok, { status: bindRes.status })
  await bridge.start()
  let up = false
  for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = bridge.streamUp }
  check('bridge: TLS stream established (pin + bind + wss)', up, { hubError: bridge.lastHubError })

  // Edge leg: signed HTTP against the TLS listener, the way Clouds connects.
  // An unsealed key may not send DMs (v6/hub/api.ts:211), so the edge leg is a
  // room post, and room delivery is what feeds the binding's wake.
  stage('edge')
  const client = await EdgeClient.fromKeyFile(join(dir, 'edge.key'), { insecureLoopback: true })
  // Addressed to the binding's principal: enqueue marks a row WAKE only when
  // m.to names the binding's principal (v6/hub/delivery.ts), so an addressed
  // room post is pushed to the stream; plain room mail is passive (hook-offered).
  const sent = await client.send({ room: 'rehearsal', to: ['bridge'], text: `rehearsal ${state.run_id}: signed room post` })
  check('edge: signed POST /v1/messages accepted', typeof sent.id === 'string', { id: sent.id, seq: sent.seq })
  transcript('edge', 'room', `rehearsal ${state.run_id}: signed room post`)

  // The exchange must land: the room post is delivered to the binding as a
  // wake batch, the bridge acks it, and its inbox == what the edge sent (the
  // #10 contract compares both sides under one run id).
  let received = false
  for (let i = 0; i < 60 && !received; i++) {
    await sleep(500)
    received = bridge.inbox.some(m => String(m.text ?? '').includes(state.run_id))
  }
  check('exchange: edge room post reached the bridge binding (wake + ack)', received, { bridged: bridge.inbox.length, streamUp: bridge.streamUp, hubError: bridge.lastHubError })

  // Reverse direction: the binding's principal posts over its bearer token,
  // and the edge reads it back through signed HTTP.
  const reply = await fetch(new URL('/v1/messages', hubUrl), {
    method: 'POST', headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'room', room: 'rehearsal', text: `rehearsal ${state.run_id}: bridge room post` }), tls: { rejectUnauthorized: false },
  } as RequestInit)
  check('bridge: bearer-token room post accepted', reply.ok, { status: reply.status })
  const log = await client.roomLog('rehearsal')
  const echoed = log.some((m: { text?: string }) => String(m.text ?? '').includes(`${state.run_id}: bridge room post`))
  check('edge: room log round-trip over signed HTTP', echoed, { rows: log.length })
  transcript('bridge', 'room', `rehearsal ${state.run_id}: bridge room post`)

  // Moon hook (Sun, #16): the same relay/rendezvous topology the Moon page
  // joins in v6/tools/moon/serve.ts. Left unexercised here on purpose.
  stage('moon (hook)')
  if (wantMoon) console.error('rehearsal: --moon is a marked hook for Sun (#16); this sprint does not run the browser leg')
  check('moon leg marked as hook (Sun, #16)', true, { note: 'pending Sun ACK on #16; topology ready at v6/tools/moon/serve.ts' })
  // Mesh-relay hook: the bridge-as-p2p-peer room route (v6/hub/relay.ts) needs
  // the bridge's libp2p identity (#11/#36) — a marked follow-up, like Moon.
  check('mesh-relay route marked as hook (bridge p2p identity)', true, { note: 'v6/hub/relay.ts relayPost requires the bridge peer id; follow-up sprint' })

  await bridge.stop()
  await Promise.allSettled([peer?.stop(), peer2?.stop()])
  await relay.stop()
  await hub.stop()

  const pass = state.checks.every(c => c.ok)
  const out = { ...state, startedAt: new Date().toISOString(), pass }
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ transcript: join(dir, 'transcript.json'), pass, checks: state.checks.length }, null, 2))
  if (autoDir) rmSync(dir, { recursive: true, force: true })
  return pass ? 0 : 1
}

main()
  .then(code => process.exit(code))
  .catch(e => { console.error('rehearsal failed:', (e as Error).message); process.exit(1) })
