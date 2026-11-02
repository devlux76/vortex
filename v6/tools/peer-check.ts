// VORTEX v6 two-device acceptance kit (docs/v6-proposal.md §4 "Two devices",
// §154 release gate). Run one side on each machine against the SAME hub over its
// authenticated TLS listener (wss:// + enrolled fingerprint pin):
//
//   machine B: bun peer-check.ts --credential dev-b.json --role respond  --peer dev-a --out b.json.evidence
//   machine A: bun peer-check.ts --credential dev-a.json --role initiate --peer dev-b --out a.json.evidence [--rounds 4]
//
// The initiator sends PINGs alternating #all room posts and DMs addressed to the
// peer; the responder answers each with a PONG naming its own host; DONE ends it.
// Each side writes JSON evidence (hostname, non-loopback addresses, hub URL,
// whether the TLS pin was used, message ids/seqs, round-trip times). Hostnames
// inside messages are self-reported: the two-device claim rests on the operator
// running the sides on two physical machines; the evidence makes that checkable.
// Exit 0 when every round completed both ways; 1 otherwise; 2 usage.
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { VortexClient, type WireApiMessage } from '../client/client.ts'
import type { Credential } from '../client/credential.ts'

interface Round { n: number; scope: 'room' | 'dm'; nonce: string; sentId?: string; sentSeq?: number; replyId?: string; replyFrom?: string; peerHost?: string; rttMs?: number }

function flags (argv: string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--') && argv[i + 1] !== undefined) { m.set(argv[i].slice(2), argv[i + 1]); i++ }
  return m
}

function addrs (): string[] {
  return Object.values(networkInterfaces()).flat().filter(a => a !== undefined && !a.internal).map(a => `${a!.address}`)
}

export async function main (argv: string[]): Promise<number> {
  const f = flags(argv)
  const role = f.get('role'); const peer = f.get('peer'); const credFile = f.get('credential')
  const rounds = Number(f.get('rounds') ?? 4)
  const timeoutMs = Number(f.get('timeout-ms') ?? 120_000)
  if ((role !== 'initiate' && role !== 'respond') || peer === undefined || credFile === undefined || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
    console.error('usage: peer-check --credential <file> --role initiate|respond --peer <principal> [--rounds 1..50] [--timeout-ms >=1000] [--out <file>] [--binding peercheck]')
    return 2
  }
  const cred = JSON.parse(readFileSync(credFile, 'utf8')) as Credential
  const me = cred.principal ?? '?'
  const binding = f.get('binding') ?? 'peercheck'
  const evidence = {
    kit: 'vortex-v6-peer-check/1', role, principal: me, peer, host: hostname(), addresses: addrs(),
    hub: cred.hub, tls: cred.hub.startsWith('wss://'), pinned: typeof cred.fingerprint === 'string' && cred.fingerprint.length > 0,
    started: new Date().toISOString(), rounds: [] as Round[], peerHostsSeen: [] as string[], ok: false, error: undefined as string | undefined,
  }
  const out = f.get('out')
  const finish = (code: number): number => {
    evidence.ok = code === 0
    if (out !== undefined) writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ ok: evidence.ok, role, host: evidence.host, peerHostsSeen: evidence.peerHostsSeen, rounds: evidence.rounds.map(r => ({ n: r.n, scope: r.scope, rttMs: r.rttMs, peerHost: r.peerHost })), error: evidence.error }))
    return code
  }
  if (!evidence.tls || !evidence.pinned) console.error('peer-check: WARNING credential is not wss:// with a fingerprint pin; this cannot satisfy the two-device TLS gate')

  const client = new VortexClient(cred)
  try { await client.bind(binding, ['all']) } catch (e) { evidence.error = `bind failed: ${(e as Error).message}`; return finish(1) }

  const waiters: Array<(m: WireApiMessage) => boolean> = []
  let done = false
  const seenHost = (h: string | undefined): void => { if (h !== undefined && !evidence.peerHostsSeen.includes(h)) evidence.peerHostsSeen.push(h) }
  const parse = (text: string): { kind: string; nonce: string; host?: string } | undefined => {
    const m = /^vx-peer-check (PING|PONG|DONE) (\S+)(?: host=(\S+))?/.exec(text)
    return m === null ? undefined : { kind: m[1], nonce: m[2], host: m[3] }
  }
  let ws!: WebSocket
  const opened = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('stream did not open')), 15_000)
    ws = client.stream(binding, {
      onOpen: () => { clearTimeout(t); resolve() },
      onBatch: (batch, _wake, messages) => {
        client.delivered(ws, batch, 'transport-written')
        for (const m of messages) {
          if (m.from !== peer) continue
          const p = parse(m.text)
          if (p === undefined) continue
          seenHost(p.host)
          if (role === 'respond' && p.kind === 'PING') {
            const reply = m.scope === 'dm'
              ? { scope: 'dm' as const, to: [peer], reply_to: m.id, text: `vx-peer-check PONG ${p.nonce} host=${evidence.host}` }
              : { scope: 'room' as const, room: m.room ?? 'all', to: [peer], reply_to: m.id, text: `vx-peer-check PONG ${p.nonce} host=${evidence.host}` }
            void client.send(reply).then(r => evidence.rounds.push({ n: evidence.rounds.length + 1, scope: m.scope as 'room' | 'dm', nonce: p.nonce, replyId: m.id, replyFrom: peer, peerHost: p.host, sentId: r.id, sentSeq: r.seq }))
          }
          if (role === 'respond' && p.kind === 'DONE') done = true
          for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](m)) waiters.splice(i, 1)
        }
        if (!done) client.pull(ws)
      },
    }).ws
  })
  try { await opened } catch (e) { evidence.error = (e as Error).message; return finish(1) }
  client.pull(ws)
  const deadline = Date.now() + timeoutMs

  if (role === 'respond') {
    while (!done && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
    ws.close()
    if (!done) { evidence.error = 'timed out before DONE'; return finish(1) }
    return finish(evidence.rounds.length > 0 ? 0 : 1)
  }

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  for (let n = 1; n <= rounds; n++) {
    const scope: 'room' | 'dm' = n % 2 === 1 ? 'room' : 'dm'
    const nonce = `${run}-${n}`
    const round: Round = { n, scope, nonce }
    evidence.rounds.push(round)
    const got = new Promise<WireApiMessage>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`round ${n} (${scope}) no PONG within deadline`)), Math.max(1000, deadline - Date.now()))
      waiters.push(m => { const p = parse(m.text); if (p?.kind === 'PONG' && p.nonce === nonce) { clearTimeout(t); resolve(m); return true } return false })
    })
    const t0 = Date.now()
    const text = `vx-peer-check PING ${nonce} host=${evidence.host}`
    try {
      const r = await client.send(scope === 'dm' ? { scope: 'dm', to: [peer], text } : { scope: 'room', room: 'all', to: [peer], text })
      round.sentId = r.id; round.sentSeq = r.seq
      const m = await got
      round.rttMs = Date.now() - t0; round.replyId = m.id; round.replyFrom = m.from; round.peerHost = parse(m.text)?.host
    } catch (e) { evidence.error = (e as Error).message; break }
  }
  try { await client.send({ scope: 'dm', to: [peer], text: `vx-peer-check DONE ${run} host=${evidence.host}` }) } catch { /* responder times out instead */ }
  ws.close()
  const complete = evidence.error === undefined && evidence.rounds.every(r => r.rttMs !== undefined)
  return finish(complete ? 0 : 1)
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
