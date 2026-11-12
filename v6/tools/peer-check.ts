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

interface Round {
  n: number; scope: 'room' | 'dm'; nonce: string; sentId?: string; sentSeq?: number
  replyId?: string; replyFrom?: string; peerHost?: string; rttMs?: number
  /** What actually came back (never the requested values): */
  replyScope?: 'room' | 'dm'; replyRoom?: string; replyRecipients?: string[]; replyTo?: string; valid?: boolean; invalid?: string
}

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
  // Only messages accepted after this run started count. The hub replays a binding's
  // undelivered mail on (re)connect (at-least-once), so a previous run's PING/PONG/DONE
  // can arrive first; the hub's seq head is an exact, clock-free boundary.
  let startSeq: number
  try { startSeq = Number((await client.status()).seq ?? 0) } catch (e) { evidence.error = `status failed: ${(e as Error).message}`; return finish(1) }
  ;(evidence as any).startSeq = startSeq
  let stale = 0

  // Every PONG from the peer is buffered: a reply may arrive before our own send's HTTP response returns.
  const pongs: WireApiMessage[] = []
  const arrivals: Array<() => void> = []
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
          if (m.seq <= startSeq) { stale++; (evidence as any).staleIgnored = stale; continue }
          seenHost(p.host)
          if (role === 'respond' && p.kind === 'PING') {
            const reply = m.scope === 'dm'
              ? { scope: 'dm' as const, to: [peer], reply_to: m.id, text: `vx-peer-check PONG ${p.nonce} host=${evidence.host}` }
              : { scope: 'room' as const, room: m.room ?? 'all', to: [peer], reply_to: m.id, text: `vx-peer-check PONG ${p.nonce} host=${evidence.host}` }
            void client.send(reply).then(r => evidence.rounds.push({ n: evidence.rounds.length + 1, scope: m.scope as 'room' | 'dm', nonce: p.nonce, replyId: m.id, replyFrom: peer, peerHost: p.host, sentId: r.id, sentSeq: r.seq }))
          }
          if (role === 'respond' && p.kind === 'DONE') done = true
          if (p.kind === 'PONG') { pongs.push(m); arrivals.splice(0).forEach(w => w()) }
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

  /** Resolves with the first buffered PONG carrying `nonce` (already arrived or arriving before the deadline). */
  const waitPong = async (nonce: string, ms: number): Promise<WireApiMessage> => {
    const end = Date.now() + ms
    while (true) {
      const hit = pongs.find(m => parse(m.text)?.nonce === nonce)
      if (hit !== undefined) return hit
      const left = end - Date.now()
      if (left <= 0) throw new Error(`no PONG for ${nonce} within deadline`)
      await Promise.race([new Promise<void>(r => arrivals.push(r)), new Promise(r => setTimeout(r, Math.min(left, 1000)))])
    }
  }
  /** The reply must answer our exact message, in the same scope, addressed back to us. */
  const checkReply = (m: WireApiMessage, scope: 'room' | 'dm', sentId: string): string | undefined => {
    if (m.reply_to !== sentId) return `reply_to ${m.reply_to ?? '(missing)'} does not reference our PING ${sentId}`
    if (m.scope !== scope) return `reply scope ${m.scope} differs from PING scope ${scope}`
    if (scope === 'room' && m.room !== 'all') return `room reply in ${m.room ?? '(none)'}, expected all`
    if (scope === 'room' && !m.to.includes(me)) return `room reply not addressed to ${me}`
    if (scope === 'dm' && !(m.to.length === 1 && m.to[0] === me)) return `DM reply recipients ${JSON.stringify(m.to)}, expected [${me}]`
    return undefined
  }

  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  for (let n = 1; n <= rounds; n++) {
    const scope: 'room' | 'dm' = n % 2 === 1 ? 'room' : 'dm'
    const nonce = `${run}-${n}`
    const round: Round = { n, scope, nonce }
    evidence.rounds.push(round)
    const t0 = Date.now()
    const text = `vx-peer-check PING ${nonce} host=${evidence.host}`
    try {
      const r = await client.send(scope === 'dm' ? { scope: 'dm', to: [peer], text } : { scope: 'room', room: 'all', to: [peer], text })
      round.sentId = r.id; round.sentSeq = r.seq
      const m = await waitPong(nonce, Math.max(1000, deadline - Date.now()))
      round.rttMs = Date.now() - t0; round.replyId = m.id; round.replyFrom = m.from; round.peerHost = parse(m.text)?.host
      round.replyScope = m.scope; round.replyRoom = m.room; round.replyRecipients = [...m.to]; round.replyTo = m.reply_to
      const problem = checkReply(m, scope, r.id)
      round.valid = problem === undefined
      if (problem !== undefined) { round.invalid = problem; evidence.error = `round ${n} (${scope}): ${problem}`; break }
    } catch (e) { evidence.error = (e as Error).message; break }
  }
  try { await client.send({ scope: 'dm', to: [peer], text: `vx-peer-check DONE ${run} host=${evidence.host}` }) } catch { /* responder times out instead */ }
  ws.close()
  const complete = evidence.error === undefined && evidence.rounds.length === rounds && evidence.rounds.every(r => r.valid === true)
  return finish(complete ? 0 : 1)
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
