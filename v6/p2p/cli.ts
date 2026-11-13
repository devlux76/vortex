#!/usr/bin/env bun
// Hand-run entry for the p2p layer.
//
//   bun v6/p2p/cli.ts relay [--listen <ma>]... [--announce <ma>]... [--key <file>]
//   bun v6/p2p/cli.ts peer --relay <ma> [--key <file>] [--ns vortex] [--webrtc]
//                          [--to <peer id>|--to-first] [--text <msg>] [--once]
//
// Output is one JSON object per line on stdout. Keys are never printed.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startPeer } from './node.ts'
import { startRelay } from './relay.ts'

interface Args { cmd: string, flags: Map<string, string[]>, bools: Set<string> }

const BOOLS = new Set(['webrtc', 'once', 'to-first', 'help'])

function parse (argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv
  const flags = new Map<string, string[]>()
  const bools = new Set<string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const name = a.slice(2)
    if (BOOLS.has(name)) { bools.add(name); continue }
    const v = rest[++i]
    if (v === undefined) throw new Error(`--${name} needs a value`)
    flags.set(name, [...(flags.get(name) ?? []), v])
  }
  return { cmd, flags, bools }
}

const one = (a: Args, k: string): string | undefined => a.flags.get(k)?.at(-1)
const out = (o: Record<string, unknown>): void => { console.log(JSON.stringify(o)) }

const USAGE = `usage:
  bun v6/p2p/cli.ts relay [--listen <multiaddr>]... [--announce <multiaddr>]... [--key <file>]
  bun v6/p2p/cli.ts peer --relay <multiaddr> [--key <file>] [--ns <namespace>] [--webrtc]
                         [--to <peer id> | --to-first] [--text <message>] [--once]`

async function relayCmd (a: Args): Promise<void> {
  const relay = await startRelay({
    listen: a.flags.get('listen') ?? ['/ip4/127.0.0.1/tcp/4003/ws'],
    announce: a.flags.get('announce'),
    keyFile: one(a, 'key'),
    admitDb: one(a, 'admit-db')
  })
  out({ event: 'relay', id: relay.node.peerId.toString(), addrs: relay.addrs().map(String), rendezvous: relay.rendezvous != null })
  await waitForSignal()
  await relay.stop()
}

async function peerCmd (a: Args): Promise<void> {
  const relayAddr = one(a, 'relay')
  if (!relayAddr) throw new Error('--relay <multiaddr> is required')
  const ns = one(a, 'ns') ?? 'vortex'
  const peer = await startPeer({
    keyFile: one(a, 'key') ?? join(homedir(), '.config', 'vortex', 'p2p.key'),
    relay: relayAddr,
    webrtc: a.bools.has('webrtc'),
    onMessage: (m, conn) => out({ event: 'message', from: m.from, text: m.text, ts: m.ts, via: conn.remoteAddr.toString() }),
    onReject: (reason, conn) => out({ event: 'rejected', from: conn.remotePeer.toString(), reason })
  })
  out({ event: 'peer', id: peer.id.toString(), addr: peer.circuitAddr().toString(), webrtc: peer.webrtc, ...(peer.webrtcError ? { webrtcError: peer.webrtcError } : {}) })
  const ttl = await peer.register(ns)
  out({ event: 'registered', ns, ttl })

  let to = one(a, 'to')
  if (a.bools.has('to-first') && !to) {
    for (let i = 0; i < 30 && !to; i++) {
      to = (await peer.discover(ns))[0]?.id.toString()
      if (!to) await Bun.sleep(1000)
    }
    if (!to) throw new Error(`no other peer registered under ${ns}`)
  }
  out({ event: 'discovered', ns, peers: (await peer.discover(ns)).map(p => p.id.toString()) })

  const text = one(a, 'text')
  if (to && text !== undefined) {
    const via = peer.webrtc ? 'webrtc' : 'relay'
    try {
      const r = await peer.send(to, text, via)
      out({ event: 'sent', to, ack: r.ack, via: r.conn.remoteAddr.toString() })
    } catch (e) {
      if (via !== 'webrtc') throw e
      out({ event: 'webrtc-failed', error: (e as Error).message })
      const r = await peer.send(to, text, 'relay')
      out({ event: 'sent', to, ack: r.ack, via: r.conn.remoteAddr.toString() })
    }
  }
  if (!a.bools.has('once')) await waitForSignal()
  await peer.stop()
}

function waitForSignal (): Promise<void> {
  return new Promise(resolve => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
}

async function main (): Promise<void> {
  const a = parse(process.argv.slice(2))
  if (a.cmd === 'relay') return await relayCmd(a)
  if (a.cmd === 'peer') return await peerCmd(a)
  console.log(USAGE)
  if (a.cmd !== 'help' && !a.bools.has('help')) process.exitCode = 2
}

main().then(() => process.exit(process.exitCode ?? 0), (e: Error) => {
  console.error(`p2p: ${e.message}`)
  process.exit(1)
})
