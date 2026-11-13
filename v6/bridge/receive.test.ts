// Sub-issue #20 of #3: mesh→hub verified room delivery. A mesh member's
// signed room envelope reaches the hub as a message from the member's
// principal, verified against the key embedded in the envelope's `from`,
// deduplicated on (principal, id), A6-screened in both the bridge and the
// hub, with room scope enforced on both keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub } from '../hub/main.ts'
import type { HubConfig } from '../hub/config.ts'
import { enrollKey } from '../cli/keys.ts'
import { EdgeClient } from '../client/edge.ts'
import { loadOrCreateKey } from '../p2p/identity.ts'
import { signEnvelope } from '../p2p/message.ts'
import { startRelay } from '../p2p/relay.ts'
import { generateEdgeKey } from '../client/edge.ts'
import { ALGS, AUTH_HEADER, STREAM_AUTH_HEADER, answerChallenge, signRequest } from '../client/edge-sign.ts'
import { startPeer } from '../p2p/node.ts'
import { startBridge, type Bridge } from './process.ts'
import { edgeKeyFromLibp2p } from './identity.ts'
import { meshIngest, type IngestStats } from './receive.ts'

async function world (cfg: Partial<HubConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vx-meshhub-'))
  const hub = await startHub({ stateDir: join(dir, 's'), configDir: join(dir, 'c'), cfg: { listen: '127.0.0.1:0', tlsListen: '127.0.0.1:0', ...cfg } })
  const relay = await startRelay({ listen: ['/ip4/127.0.0.1/tcp/0/ws'] })
  const relayAddr = relay.addrs()[0]!.toString()

  // The bridge's key and principal: its libp2p key is its A7 key (#11).
  const bridgeKeyFile = join(dir, 'bridge.key')
  const bridgePriv = await loadOrCreateKey(bridgeKeyFile)
  const bridgeMaterial = await edgeKeyFromLibp2p(bridgePriv)
  const bridgeRow = await enrollKey(hub.store, { principal: 'bridge', spkiB64: bridgeMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })
  const edge = new EdgeClient({
    url: `https://127.0.0.1:${hub.tlsPort}`, principal: 'bridge', keyId: bridgeRow.key_id, hubId: hub.fingerprint!,
    alg: 'ed25519', key: await crypto.subtle.importKey('jwk', bridgeMaterial.jwk, { name: 'Ed25519' }, false, ['sign']),
    insecureLoopback: true
  })

  // The mesh member's key and principal (the same identity system).
  const memberKeyFile = join(dir, 'member.key')
  const memberPriv = await loadOrCreateKey(memberKeyFile)
  const memberMaterial = await edgeKeyFromLibp2p(memberPriv)
  const memberRow = await enrollKey(hub.store, { principal: 'mesher', spkiB64: memberMaterial.spkiB64, alg: 'ed25519', custody: 'unsealed', rooms: ['mesh'] })

  const bridgeOpts = { keyFile: bridgeKeyFile, relay: relayAddr, hubKeyFile: '', edge, insecureLoopback: true }
  const cleanup = async (): Promise<void> => { await relay.stop(); await hub.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { dir, hub, relayAddr, bridgeOpts, memberKeyFile, memberPriv, memberPrincipal: memberRow.principal, cleanup }
}

test('#20: a mesh member\'s signed envelope reaches the hub from its principal, once; A6 and room scope hold', { timeout: 120_000 }, async () => {
  const w = await world()
  let bridge: Bridge | undefined
  const stats: IngestStats = { relayed: 0, skipped: 0, refused: 0 }
  try {
    // The ingest handler needs the bridge it belongs to: a stable indirection.
    let ingest: ((msg: import('../p2p/message.ts').P2PMessage) => Promise<void>) | undefined
    bridge = await startBridge({ ...w.bridgeOpts, onEnvelope: async msg => { await ingest?.(msg) } })
    ingest = meshIngest(bridge, stats)
    // Join the room (one signed presence post), so the bridge can read its log.
    await bridge.edge.send({ room: 'mesh', text: '[vortex bridge] present' })

    const member = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
    try {
      // A clean room message from the member.
      const envelope = await signEnvelope(w.memberPriv, {
        v: 1, id: 'dedupids000000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'mesh says hi', ts: Date.now()
      })
      const { ack } = await member.sendRaw(bridge.peer.id, envelope)
      assert.equal(ack.ok, true)
      for (let i = 0; i < 30 && stats.relayed === 0; i++) await Bun.sleep(200)
      assert.equal(stats.relayed, 1)
      // The hub stored it from the member's principal (origin verified).
      const log = (await bridge.edge.roomLog('mesh')).filter(m => m.text === 'mesh says hi')
      assert.equal(log.length, 1)
      assert.equal(log[0]!.from, w.memberPrincipal)
      assert.equal(log[0]!.human, false)

      // A repeated send is handled once. At the p2p hop the receiver's own
      // dedup refuses the identical frame:
      const again = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
      try {
        const { ack } = await again.sendRaw(bridge.peer.id, envelope)
        assert.equal(ack.ok, false)
        assert.equal(ack.error, 'duplicate message')
      } finally { await again.stop() }
      // And a bridge-level replay (a crash after the p2p hop, before the hub
      // answer) re-relays the same envelope: the hub dedups on (principal, id)
      // and the room log keeps exactly one copy.
      const before = stats.relayed
      await ingest?.(envelope)
      for (let i = 0; i < 30 && stats.relayed <= before; i++) await Bun.sleep(200)
      assert.equal(stats.relayed, before + 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'mesh says hi').length, 1)

      // A6 in both directions. Bridge first: the credential-shaped envelope
      // is screened at ingest and never relayed.
      const bad = await signEnvelope(w.memberPriv, {
        v: 1, id: 'a6probe000000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'here: sk-ant-test1234test1234test12', ts: Date.now()
      })
      const { ack: ack2 } = await member.sendRaw(bridge.peer.id, bad)
      assert.equal(ack2.ok, false)
      assert.match(String(ack2.error), /refused: text contains a credential/)
      for (let i = 0; i < 30 && stats.skipped === 0; i++) await Bun.sleep(200)
      assert.equal(stats.skipped, 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text.includes('sk-ant-')).length, 0)
      // The hub's own screen is authoritative even for a bridge that skips
      // its screen: relaying the same envelope directly gets 422.
      await assert.rejects(
        bridge.edge.request('POST', '/v1/rooms/mesh/relay', { envelope: bad }),
        /422.*refused: text contains a credential/
      )
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text.includes('sk-ant-')).length, 0)

      // Room scope: the member's unsealed key is limited to `mesh`; an
      // envelope for another room is refused by the hub (403) and not stored.
      const other = await signEnvelope(w.memberPriv, {
        v: 1, id: 'scopeprobe000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'elsewhere', text: 'out of scope', ts: Date.now()
      })
      const { ack: ack3 } = await member.sendRaw(bridge.peer.id, other)
      assert.equal(ack3.ok, false)
      assert.match(String(ack3.error), /403/)
      for (let i = 0; i < 30 && stats.refused === 0; i++) await Bun.sleep(200)
      assert.equal(stats.refused, 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'out of scope').length, 0)
    } finally { await member.stop() }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#20: the signed recipient is bound to the bridge — a third-party envelope is refused', { timeout: 60_000 }, async () => {
  const w = await world()
  let bridge: Bridge | undefined
  try {
    bridge = await startBridge({ ...w.bridgeOpts, onEnvelope: async () => {} })
    await bridge.edge.send({ room: 'mesh', text: '[vortex bridge] present' })
    const member = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
    try {
      // Signed by the enrolled origin, but addressed to a DIFFERENT peer:
      // the hub binds `to` to the bridge's own peer id (derived from the
      // authenticated key's SPKI) and refuses to relay for a third party.
      const strangerKey = await loadOrCreateKey(join(w.dir, 'stranger.key'))
      const strangerPeer = await import('@libp2p/peer-id').then(m => m.peerIdFromPrivateKey(strangerKey))
      const misaddressed = await signEnvelope(w.memberPriv, {
        v: 1, id: 'thirdprt0000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: strangerPeer.toString(), scope: 'room', room: 'mesh', text: 'not for the bridge', ts: Date.now()
      })
      await assert.rejects(
        bridge.edge.request('POST', '/v1/rooms/mesh/relay', { envelope: misaddressed }),
        /403.*addressed to this bridge/
      )
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'not for the bridge').length, 0)
    } finally { await member.stop() }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#20: a refused relay claims nothing — the retry is retried, not falsely acknowledged', { timeout: 60_000 }, async () => {
  // Rate limit 1/minute for the origin: the second, different envelope hits 429.
  const w = await world({ sendPerMinute: 1 })
  let bridge: Bridge | undefined
  const stats: IngestStats = { relayed: 0, skipped: 0, refused: 0 }
  try {
    let ingest: ((msg: import('../p2p/message.ts').P2PMessage) => Promise<void>) | undefined
    bridge = await startBridge({ ...w.bridgeOpts, onEnvelope: async msg => { await ingest?.(msg) } })
    ingest = meshIngest(bridge, stats)
    await bridge.edge.send({ room: 'mesh', text: '[vortex bridge] present' })
    const member = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
    try {
      const first = await signEnvelope(w.memberPriv, {
        v: 1, id: 'ratefirst0000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'first passes', ts: Date.now()
      })
      const { ack } = await member.sendRaw(bridge.peer.id, first)
      assert.equal(ack.ok, true)
      for (let i = 0; i < 30 && stats.relayed === 0; i++) await Bun.sleep(200)
      const second = await signEnvelope(w.memberPriv, {
        v: 1, id: 'ratesecond000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'second is rate limited', ts: Date.now()
      })
      const { ack: ack2 } = await member.sendRaw(bridge.peer.id, second)
      assert.equal(ack2.ok, false)
      // Re-relaying the refused envelope must NOT answer duplicate:true
      // (Sun's reproduction): the claim commits with the accepted write only.
      await assert.rejects(
        bridge.edge.request('POST', '/v1/rooms/mesh/relay', { envelope: second }),
        /429/
      )
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'second is rate limited').length, 0)
    } finally { await member.stop() }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#20: a transient relay failure is recoverable — the resend is accepted once (ACK boundary)', { timeout: 60_000 }, async () => {
  const w = await world()
  let bridge: Bridge | undefined
  const stats: IngestStats = { relayed: 0, skipped: 0, refused: 0 }
  try {
    let ingest: ((msg: import('../p2p/message.ts').P2PMessage) => Promise<void>) | undefined
    let failFirst = true
    bridge = await startBridge({ ...w.bridgeOpts, onEnvelope: async msg => {
      if (failFirst) { failFirst = false; throw new Error('hub hiccup') }
      await ingest?.(msg)
    } })
    ingest = meshIngest(bridge, stats)
    await bridge.edge.send({ room: 'mesh', text: '[vortex bridge] present' })
    const member = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
    try {
      const envelope = await signEnvelope(w.memberPriv, {
        v: 1, id: 'transient00000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'once only', ts: Date.now()
      })
      // First attempt: the handler fails transiently; the ack is ok:false and
      // the p2p dedup consumed nothing, so the resend is possible.
      const { ack } = await member.sendRaw(bridge.peer.id, envelope)
      assert.equal(ack.ok, false)
      assert.equal(ack.error, 'hub hiccup')
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'once only').length, 0)
      // Retry: accepted exactly once.
      const { ack: ack2 } = await member.sendRaw(bridge.peer.id, envelope)
      assert.equal(ack2.ok, true)
      for (let i = 0; i < 30 && stats.relayed === 0; i++) await Bun.sleep(200)
      assert.equal(stats.relayed, 1)
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'once only').length, 1)
    } finally { await member.stop() }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})

test('#20: a relayed message wakes a waiting binding (routeStored wakes + post-commit scheduling)', { timeout: 90_000 }, async () => {
  const w = await world({ wakeCoalesceMs: 0, wakeMinIntervalMs: 0 })
  let bridge: Bridge | undefined
  const stats: IngestStats = { relayed: 0, skipped: 0, refused: 0 }
  try {
    // A sealed-custody watcher with a binding on the room, holding an open
    // signed stream (A7 §3 challenge-response).
    const k = await generateEdgeKey('ed25519')
    const watcherRow = await enrollKey(w.hub.store, { principal: 'watcher', spkiB64: k.spkiB64, alg: 'ed25519', custody: 'hardware', rooms: null })
    const watcherKey = await crypto.subtle.importKey('jwk', k.jwk, ALGS['ed25519'].importParams, false, ['sign'])
    const ids = { principal: 'watcher', key_id: watcherRow.key_id, hub: w.hub.fingerprint! }
    const body = new TextEncoder().encode(JSON.stringify({ rooms: ['mesh'] }))
    const put = await fetch(`https://127.0.0.1:${w.hub.tlsPort}/v1/bindings/default`, {
      method: 'PUT',
      headers: { [AUTH_HEADER]: await signRequest(watcherKey, 'ed25519', ids, 'PUT', '/v1/bindings/default', body), 'content-type': 'application/json' },
      body, tls: { rejectUnauthorized: false },
    } as RequestInit)
    assert.equal(put.status, 200, await put.text())
    const ws = new WebSocket(`wss://127.0.0.1:${w.hub.tlsPort}/v1/bindings/default/stream`, {
      headers: { [STREAM_AUTH_HEADER]: `${ids.principal} ${ids.key_id}` }, tls: { rejectUnauthorized: false },
    } as any)
    const frames: any[] = []
    const waiters: Array<() => void> = []
    let closedInfo = 'open'
    ws.onclose = ev => { closedInfo = `closed ${ev.code} ${ev.reason}`; waiters.splice(0).forEach(fn => fn()) }
    ws.onmessage = ev => { frames.push(JSON.parse(String(ev.data))); waiters.splice(0).forEach(fn => fn()) }
    const closed = new Promise<string>(resolve => { const t = setInterval(() => { if (closedInfo !== 'open') { clearInterval(t); resolve(closedInfo) } }, 100) })
    const nextFrame = async (): Promise<any> => {
      const deadline = Date.now() + 5000
      while (frames.length === 0 && Date.now() < deadline) await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50) })
      return frames.shift()
    }

    let ingest: ((msg: import('../p2p/message.ts').P2PMessage) => Promise<void>) | undefined
    bridge = await startBridge({ ...w.bridgeOpts, onEnvelope: async msg => { await ingest?.(msg) } })
    ingest = meshIngest(bridge, stats)
    await bridge.edge.send({ room: 'mesh', text: '[vortex bridge] present' })

    const challenge = await nextFrame()
    assert.equal(challenge.type, 'challenge')
    ws.send(JSON.stringify(await answerChallenge(watcherKey, 'ed25519', ids, 'default', challenge.nonce)))

    const member = await startPeer({ keyFile: w.memberKeyFile, relay: w.relayAddr })
    try {
      const envelope = await signEnvelope(w.memberPriv, {
        v: 1, id: 'waketest00000000000000000000000'.slice(0, 32), from: member.id.toString(),
        to: bridge.peer.id.toString(), scope: 'room', room: 'mesh', text: 'held for the watcher', ts: Date.now()
      })
      const { ack } = await member.sendRaw(bridge.peer.id, envelope)
      assert.equal(ack.ok, true)
      for (let i = 0; i < 30 && stats.relayed === 0; i++) await Bun.sleep(200)
      assert.equal(stats.relayed, 1)
      // A relayed mesh message is room chatter (§8.3): `to` is empty and the
      // origin is not the operator, so it enqueues as a PASSIVE row — held on
      // the binding, NOT pushed. The attach backlog (the presence line) may
      // push on its own, but the relayed row itself waits for a pull.
      await Bun.sleep(500)
      const pushedEarly = frames.filter(f => f.type === 'batch')
      assert.ok(pushedEarly.every(f => !f.messages.some((m: any) => m.text === 'held for the watcher')),
        `the passive relayed row was pushed without a pull: ${JSON.stringify(pushedEarly)}`)
      ws.send(JSON.stringify({ type: 'pull', kind: 'passive' }))
      const pulled = await nextFrame()
      if (pulled === undefined) throw new Error(`no pull batch; frames=${JSON.stringify(frames)} stream=${closedInfo}`)
      assert.equal(pulled.type, 'batch')
      assert.ok(pulled.messages.some((m: any) => m.text === 'held for the watcher'))
      // Wake behavior through the same binding: a wake-eligible message (the
      // operator's room post, a human turn) pushes without a pull.
      const opToken = (await Bun.file(join(w.dir, 'c', 'vortex', 'operator.json')).json()).token
      const post = await fetch(`http://127.0.0.1:${w.hub.port}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'room', room: 'mesh', text: 'operator wake' })
      })
      assert.equal(post.status, 200)
      const pushed = await nextFrame()
      if (pushed === undefined) throw new Error(`no wake batch; frames=${JSON.stringify(frames)} stream=${closedInfo}`)
      assert.equal(pushed.type, 'batch')
      assert.ok(pushed.messages.some((m: any) => m.text === 'operator wake'))
      assert.equal((await bridge.edge.roomLog('mesh')).filter(m => m.text === 'held for the watcher').length, 1)
      ws.close()
    } finally { await member.stop() }
  } finally {
    await bridge?.stop()
    await w.cleanup()
  }
})
