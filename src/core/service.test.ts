import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id'
import { makeProfile } from '../embed/profile.ts'
import type { DirectEvent, Embedder, GossipEvent, GossipHandler, Multiaddr, PeerId, Transport, TransportInfo } from '../types.ts'
import { createAnnouncement } from './announcement.ts'
import { Contact, DiscoveryPacket } from './proto/discovery.ts'
import { createNodeTransport } from '../net/node.ts'
import { encodeVector } from '../embed/vector.ts'
import { VortexService } from './service.ts'
import type { Conferences } from './conferences.ts'
import type { Snapshot, RoomSubscription } from './conversations.ts'
import { createDisclosurePolicy } from './disclosure.ts'

// Docs: VORTEX_v5.1.md §§10.2, 8.2. Rejected text never reaches inference, signing, persistence or transport.
test('disclosure policy gates semantic and legacy announcements and direct messages before side effects', async()=>{
  const raw=await createNodeTransport();
  let embedded=0, signed=0, published=0, sent=0, saved=0;
  const transport={...raw,sign:async(data:Uint8Array)=>{signed++;return raw.sign(data);},
    publish:async(topic:string,data:Uint8Array)=>{published++;return raw.publish(topic,data);},
    send:async()=>{sent++;}};
  const embedder={...fakeEmbedder(),embed:async(text:string)=>{embedded++;return fakeEmbedder().embed(text);}};
  const service=new VortexService(transport,'test',()=>{saved++;},undefined,{embedder,
    disclosure:createDisclosurePolicy({blockedProjectIds:['blocked']})});
  try {
    await service.start();
    const before={embedded,signed,published,sent,saved};
    await assert.rejects(service.announceStatement({session:'s',statement:'blocked'}),/disclosure/);
    await assert.rejects(service.announce('blocked'),/disclosure/);
    assert.deepEqual({embedded,signed,published,sent,saved},before);
    const peer=peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const room=await service.core().invite(peer);
    await service.core().receive(peer,{kind:'accept',room});
    const prior=sent;
    await assert.rejects(service.core().send(room,'blocked'),/disclosure/);
    assert.equal(sent,prior);
    await service.core().send(room,'public context');
    assert.equal(sent,prior+1);
  } finally {await service.stop();}
});

test('semantic-only policy starts without leaking legacy beacons and checks conference posts',async()=>{
  const raw=await createNodeTransport();
  let published=0;
  const service=new VortexService({...raw,publish:async()=>{published++;return {recipients:0};}},'test',()=>{},undefined,
    {embedder:fakeEmbedder(),disclosure:createDisclosurePolicy({allowedNamespaces:[profile.id],blockedProjectIds:['blocked']})});
  try {
    await service.start();
    assert.equal(published,0);
    await assert.rejects(service.postToConference({session:'s',conference:'a'.repeat(32),text:'blocked'}),/disclosure/);
    await service.announceStatement({session:'s',statement:'base'});
    assert.equal(published,1);
  } finally {await service.stop();}
});

test('an approval pending through service stop cannot run inference or publish',async()=>{
  let release:()=>void=()=>{};
  let entered:()=>void=()=>{};
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let embedded=0;
  const service=new VortexService(await createNodeTransport(),'test',()=>{},undefined,{embedder:{...fakeEmbedder(),
    embed:async(text:string)=>{embedded++;return fakeEmbedder().embed(text);}},
    disclosure:createDisclosurePolicy({requireApproval:true},async()=>{entered();await gate;})});
  await service.start();
  const pending=service.announceStatement({session:'s',statement:'base'});
  await ready; await service.stop(); release();
  await assert.rejects(pending,/stopped/);
  assert.equal(embedded,0);
});

test('approval covers the captured semantic request and legacy heartbeat does not ask again',{timeout:10000},async()=>{
  let release:()=>void=()=>{};
  let entered:()=>void=()=>{};
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let approvals=0, published=0;
  const raw=await createNodeTransport();
  const service=new VortexService({...raw,publish:async()=>{published++;return {recipients:0};}},'test',()=>{},undefined,
    {embedder:fakeEmbedder(),disclosure:createDisclosurePolicy({requireApproval:true},async()=>{
      approvals++; if(approvals===1){entered();await gate;}
    })});
  try {
    await service.start();
    const request={session:'s',statement:'base'};
    const pending=service.announceStatement(request);
    await ready; request.statement='blocked'; release();
    const announced=await pending;
    assert.equal(service.openInterests()[0].statement,'base');
    assert.ok(announced.id);
    await service.announce('public legacy problem');
    assert.equal(approvals,2);
    const before=published;
    await sleep(5200);
    assert.ok(published>before);
    assert.equal(approvals,2);
  } finally {await service.stop();}
});

// Fake table embedder, copied pattern from discovery.test.ts (never imported from it).
const profile = makeProfile({
  model: 'm', revision: 'r1', weights: 'q4', prompt: 'p: ', maxTokens: 64, truncation: 'tail',
  pooling: 'mean', normalization: 'l2', dims: [8, 4, 2], encoding: 'float32le', version: 1,
  tolerance: 0.001, thresholds: { 8: 0.9, 4: 0.9, 2: 0.9 }
})
const table: Record<string, Float32Array> = {
  base: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]),
  exact: Float32Array.from([2, 0, 0, 0, 2, 0, 0, 0]),
  tier8: Float32Array.from([1, 0.2, 0, 0, 1, 0.3, 0, 0]),
  tier4: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0]),
  far: Float32Array.from([0, 1, 0, 0, 0, 0, 1, 0])
}
const fakeEmbedder = (): Embedder => ({
  profile: () => profile,
  embed: async (text: string): Promise<Float32Array> => {
    const found = table[text]
    if (found === undefined) throw new Error(`unknown statement: ${text}`)
    return found
  }
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const subjectHex = (text: string): string =>
  Array.from(encodeVector(table[text]), byte => byte.toString(16).padStart(2, '0')).join('')

async function pair (saveA?: (s: Snapshot) => void, saveB?: (s: Snapshot) => void) {
  const ta = await createNodeTransport()
  const tbRaw = await createNodeTransport()
  // B's sends are recorded so tests can see which address chose the dial.
  const sentTo: Array<{ peer: string, addrs?: Multiaddr[] }> = []
  const tb = {
    ...tbRaw,
    send: (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]): Promise<void> => {
      sentTo.push({ peer, addrs })
      return tbRaw.send(peer, data, addrs)
    }
  }
  const sa = new VortexService(ta, 'a', saveA ?? (() => {}), undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', saveB ?? (() => {}), undefined, { embedder: fakeEmbedder() })
  const infoA = await sa.start()
  const infoB = await sb.start()
  await sa.dial(infoB.addrs[0])
  await sleep(2500)
  return { sa, sb, infoA, infoB, sentTo, stop: async (): Promise<void> => { await sa.stop(); await sb.stop() } }
}

// Docs: VORTEX_v5.1.md sections 6.2, 11.2 and 12.6
test('a later matching announcement reaches the holder as a match event, then they talk', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, stop } = await pair()
  try {
    // Step 1: A announces first; nobody holds a matching interest yet.
    await sa.announceStatement({ session: 's', statement: 'base' })
    await sleep(500)
    // Step 2: B announces the same direction later; A answers B directly.
    await sb.announceStatement({ session: 's', statement: 'exact' })
    const page = await sb.core().wait(undefined, 15000)
    const match = page.events.find(e => e.kind === 'match')
    assert.ok(match !== undefined, 'B holds a match event')
    assert.equal(match.peer, infoA.peerId)
    assert.equal(match.tier, 'exact')
    assert.deepEqual(match.addrs, infoA.addrs)
    // Step 3: one direction only; A holds no match event.
    await sleep(1000)
    assert.deepEqual(sa.core().read().events.filter(e => e.kind === 'match'), [])
    // Step 4: B invites A using the verified contact address, not the legacy directory.
    assert.equal((sb as unknown as { peers: Map<string, unknown> }).peers.has(infoA.peerId), false)
    const room = await sb.core().invite(infoA.peerId)
    // Step 5: the invite is delivered; A accepts; B sends; A reads.
    const invitation = await sa.core().wait(undefined, 10000)
    assert.equal(invitation.events.at(-1)?.kind, 'invitation')
    await sa.core().accept(room)
    const accepted = await sb.core().wait(undefined, 10000)
    assert.ok(accepted.events.some(e => e.kind === 'accepted'))
    await sb.core().send(room, 'hello from b')
    await sleep(500)
    assert.equal(sa.core().read().events.at(-1)?.body, 'hello from b')
    void infoB
  } finally { await stop() }
})

// Docs: VORTEX_v5.1.md section 5.2
test('unrelated statements produce no match event on either side', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    await sa.announceStatement({ session: 's', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 's', statement: 'far' })
    await sleep(1500)
    assert.deepEqual(sa.core().read().events.filter(e => e.kind === 'match'), [])
    assert.deepEqual(sb.core().read().events.filter(e => e.kind === 'match'), [])
    await assert.rejects(sa.core().wait(undefined, 500), /timed out/)
  } finally { await stop() }
})

// Docs: VORTEX_v5.1.md section 9.1
test('without an embedder the semantic methods throw and the legacy flow works', async () => {
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {})
  const sb = new VortexService(tb, 'b', () => {})
  const missing = 'semantic discovery is not enabled: start the service with --semantic'
  try {
    await sa.start()
    await sb.start()
    await assert.rejects(sa.announceStatement({ session: 's', statement: 'base' }), new RegExp(missing))
    assert.throws(() => sa.withdrawInterest('s', 'a'.repeat(32)), new RegExp(missing))
    assert.throws(() => sa.endSession('s'), new RegExp(missing))
    assert.throws(() => sa.openInterests(), new RegExp(missing))
    assert.throws(() => sa.matchesFor('a'.repeat(32)), new RegExp(missing))
    await sa.dial(sb.info().addrs[0])
    const room = await sa.core().invite(sb.info().peerId)
    await sb.core().wait(undefined, 5000)
    await sb.core().accept(room)
    await sleep(300)
    await sa.core().send(room, 'legacy still works')
    await sleep(500)
    assert.equal(sb.core().read().events.at(-1)?.body, 'legacy still works')
  } finally { await sa.stop(); await sb.stop() }
})

// Docs: VORTEX_v5.1.md sections 4.3 and 9.3
test('a match event survives a restart but open interests do not', { timeout: 60000 }, async () => {
  let saved: Snapshot | undefined
  const first = await pair(() => {}, s => { saved = s })
  try {
    await first.sa.announceStatement({ session: 's', statement: 'base' })
    await sleep(500)
    await first.sb.announceStatement({ session: 's', statement: 'exact' })
    await first.sb.core().wait(undefined, 15000)
    assert.ok(saved !== undefined)
  } finally { await first.stop() }
  const tb2 = await createNodeTransport()
  const sb2 = new VortexService(tb2, 'b', () => {}, saved, { embedder: fakeEmbedder() })
  try {
    await sb2.start()
    const events = sb2.core().read(0).events
    assert.ok(events.some(e => e.kind === 'match'), 'match event restored')
    assert.deepEqual(sb2.openInterests(), [])
  } finally { await sb2.stop() }
})

// Docs: VORTEX_v5.1.md section 9.3
test('a match lost to a failed save reports once and never becomes an event', { timeout: 60000 }, async () => {
  const errors: string[] = []
  let fail = true
  let savedB: Snapshot | undefined
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', s => { if (fail) throw new Error('disk full'); savedB = s },
    undefined, { embedder: fakeEmbedder(), onError: message => errors.push(message) })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 's', statement: 'base', publishStatement: true })
    await sleep(500)
    const { id } = await sb.announceStatement({ session: 's', statement: 'exact' })
    const end = Date.now() + 10000
    while (errors.length < 1) {
      if (Date.now() > end) throw new Error('onError never fired')
      await sleep(25)
    }
    assert.equal(errors.length, 1)
    assert.equal(errors[0], 'match for interest ' + id + ' could not be saved')
    assert.ok(!errors[0].includes('base'), 'no peer statement in the error')
    assert.ok(!errors[0].includes(sa.info().peerId), 'no peer id in the error')
    assert.deepEqual(sb.core().read().events.filter(e => e.kind === 'match'), [])
    const kept = sb.matchesFor(id)
    assert.equal(kept.length, 1)
    // A later successful save of something else resurrects nothing.
    fail = false
    await sb.core().ack(sb.core().read().cursor)
    assert.deepEqual(sb.core().read().events.filter(e => e.kind === 'match'), [])
    assert.ok(savedB !== undefined)
  } finally { await sa.stop(); await sb.stop() }
})

const LEGACY_TOPIC = '/vortex/local-discovery/1'

// Docs: VORTEX_v5.1.md sections 7.1 and 10.6
test('dialing prefers verified contacts and never uses an expired directory entry', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, sentTo, stop } = await pair()
  // Transports are held explicitly here so the test can publish raw legacy
  // packets as their own subject (the topic validator binds id to origin).
  const tx = await createNodeTransport()
  const sx = new VortexService(tx, 'x', () => {}, undefined, { embedder: fakeEmbedder() })
  const ty = await createNodeTransport()
  try {
    await sx.start()
    await ty.start()
    await ty.subscribe(LEGACY_TOPIC, () => 'accept')
    const infoX = tx.info()
    await tx.dial(infoB.addrs[0])
    await ty.dial(infoB.addrs[0])
    await sleep(2000)
    // X announces first; B's later announcement is answered by X, so B keeps
    // a verified match for X whose contact carries the real address.
    await sx.announceStatement({ session: 's', statement: 'tier8' })
    await sleep(500)
    await sb.announceStatement({ session: 's', statement: 'base' })
    await sb.core().wait(undefined, 15000)
    // A bogus legacy entry for X, published by X itself so it is accepted, lands last.
    const bogus = '/ip4/127.0.0.1/tcp/9/p2p/' + infoX.peerId
    await tx.publish(LEGACY_TOPIC, new TextEncoder().encode(JSON.stringify({
      id: infoX.peerId, name: 'x', interest: '', addrs: [bogus], expires: Date.now() + 60000
    })))
    await sleep(1000)
    const entry = sb.discover().find(p => p.id === infoX.peerId)
    assert.ok(entry !== undefined && entry.addrs[0] === bogus, 'bogus legacy entry is newest')
    // The invite still succeeds, so it dialed the verified contact address.
    await sb.core().invite(infoX.peerId)
    assert.equal(sb.discover().find(p => p.id === infoX.peerId)?.addrs[0], bogus)
    assert.deepEqual(sentTo.filter(s => s.peer === infoX.peerId).at(-1)?.addrs, tx.info().addrs)
    // A legacy-only peer whose entry has expired yields no address: the invite fails.
    const yId = ty.info().peerId
    await ty.publish(LEGACY_TOPIC, new TextEncoder().encode(JSON.stringify({
      id: yId, name: 'y', interest: '', addrs: ty.info().addrs, expires: Date.now() + 1500
    })))
    await sleep(700)
    assert.ok(sb.discover().some(p => p.id === yId), 'fresh legacy entry is listed')
    await sleep(1200)
    assert.ok(!sb.discover().some(p => p.id === yId), 'expired legacy entry is gone')
    // The live connection may still deliver, but the dial used no address from the entry.
    await sb.core().invite(yId).catch(() => {})
    assert.equal(sentTo.filter(s => s.peer === yId).at(-1)?.addrs, undefined)
    void sa
    void infoA
  } finally {
    await sx.stop()
    await ty.stop()
    await stop()
  }
})

// Docs: VORTEX_v5.1.md sections 9.3 and 11.2
test('a packet delivered after stop records nothing', async () => {
  const keySelf = await generateKeyPair('Ed25519')
  const keyPeer = await generateKeyPair('Ed25519')
  const selfId = peerIdFromPrivateKey(keySelf).toString()
  const peerId = peerIdFromPrivateKey(keyPeer).toString()
  const gossip = new Map<string, GossipHandler[]>()
  const directs: Array<(event: DirectEvent) => void> = []
  let saves = 0
  const transport: Transport = {
    start: async (): Promise<TransportInfo> => ({ peerId: selfId, addrs: [`/ip4/127.0.0.1/tcp/1/p2p/${selfId}`] }),
    stop: async (): Promise<void> => {},
    info: (): TransportInfo => ({ peerId: selfId, addrs: [`/ip4/127.0.0.1/tcp/1/p2p/${selfId}`] }),
    dial: async (): Promise<PeerId> => peerId,
    subscribe: async (topic: string, handler: GossipHandler): Promise<void> => {
      gossip.set(topic, [...(gossip.get(topic) ?? []), handler])
    },
    unsubscribe: async (topic: string): Promise<void> => { gossip.delete(topic) },
    publish: async (): Promise<{ recipients: number }> => ({ recipients: 0 }),
    send: async (): Promise<void> => {},
    onDirect: (handler: (event: DirectEvent) => void): (() => void) => {
      directs.push(handler)
      return (): void => { directs.splice(directs.indexOf(handler), 1) }
    },
    onPeer: (): (() => void) => (): void => {},
    sign: async (data: Uint8Array): Promise<Uint8Array> => keySelf.sign(data),
    verify: async (peer: PeerId, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
      try {
        const key = peerIdFromString(peer).publicKey
        return key === undefined ? false : await key.verify(data, sig)
      } catch { return false }
    }
  }
  const service = new VortexService(transport, 'b', () => { saves++ }, undefined, { embedder: fakeEmbedder() })
  await service.start()
  const { id } = await service.announceStatement({ session: 's', statement: 'base' })
  const delivered = [...directs]
  assert.ok(delivered.length > 0)
  const before = saves
  await service.stop()
  const record = await createAnnouncement({ profile, vector: table.exact, origin: peerId,
    contact: Contact.encode({ addrs: [`/ip4/127.0.0.1/tcp/1/p2p/${peerId}`] }), ttl: 60,
    sign: async (data: Uint8Array): Promise<Uint8Array> => keyPeer.sign(data), now: Date.now() })
  const encoded = DiscoveryPacket.encode({ results: [{
    announcementId: Uint8Array.from(id.match(/../g) as string[], pair => parseInt(pair, 16)),
    record: record.bytes, tier: 0, score: 1
  }] })
  const packet = new Uint8Array(1 + encoded.length)
  packet[0] = 0
  packet.set(encoded, 1)
  for (const handler of delivered) handler({ from: peerId, data: packet })
  await sleep(200)
  assert.deepEqual(service.core().read().events, [])
  assert.deepEqual(service.matchesFor(id), [])
  assert.equal(saves, before)
})

async function until (check: () => boolean, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('condition timed out')
    await sleep(20)
  }
}
// Docs: VORTEX_v5.1.md sections 6.2, 6.3, 6.4, 7.3, 9.3 and 12.6
test('three services form one conference, deliver arrivals and fan out signed posts, then leave', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, stop } = await pair()
  const tc = await createNodeTransport()
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sc.start()
    await sc.dial(infoA.addrs[0])
    await sc.dial(infoB.addrs[0])
    await sleep(2500)
    // Step 1: the first agent holds its open interest without a conference.
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    // Step 2: the second agent sees the first interest's explicit record handle.
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    assert.equal(match.record, a.id)
    const waitingA = sa.core().wait(undefined, 10000)
    const b = await sb.joinConference({ session: 'b', ref: match.record! })
    assert.equal(b.id, a.id)
    assert.equal(b.role, 'participant')
    // Step 3: the holder notices formation and arrival through durable events alone.
    assert.equal((await waitingA).events[0].kind, 'formed')
    await until(() => sa.core().read(0).events.some(e => e.kind === 'arrival'))
    assert.deepEqual(sa.core().read(0).events.map(e => e.kind), ['formed', 'arrival'])
    assert.equal(sa.core().read(0).events[1].service, infoB.peerId)
    await sb.postToConference({ session: 'b', conference: a.id, text: 'from b' })
    await until(() => sa.core().read(0).events.some(e => e.body === 'from b'))
    const received = sa.core().read(0).events.find(e => e.body === 'from b')!
    assert.equal(received.kind, 'conference_message')
    assert.equal(received.participant, b.key)
    assert.equal(received.service, infoB.peerId)
    // Step 4: a third agent joins the same holder, and both members notice.
    await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === a.id))
    const c = await sc.joinConference({ session: 'c', ref: a.id })
    await until(() => sb.core().read(0).events.some(e => e.kind === 'arrival' && e.participant === c.key))
    await until(() => sa.core().read(0).events.filter(e => e.kind === 'arrival').length === 2)
    // Step 5: participant and host posts arrive once at every other service.
    const posted = await sc.postToConference({ session: 'c', conference: a.id, text: 'from c', replyTo: received.message })
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.message === posted.message)))
    for (const s of [sa, sb]) {
      const messages = s.core().read(0).events.filter(e => e.message === posted.message)
      assert.equal(messages.length, 1)
      assert.equal(messages[0].body, 'from c')
      assert.equal(messages[0].replyTo, received.message)
      assert.equal(messages[0].participant, c.key)
    }
    await sa.postToConference({ session: 'a', conference: a.id, text: 'from host' })
    await until(() => [sb, sc].every(s => s.core().read(0).events.some(e => e.body === 'from host')))
    for (const s of [sa, sb, sc]) {
      const list = s.conferenceList()
      assert.equal(list.length, 1)
      assert.equal(list[0].count, 3)
      assert.equal(list[0].participants.length, 3)
      assert.equal('descriptor' in list[0], false)
      assert.equal('topicVector' in list[0], false)
      assert.equal(list[0].role, s === sa ? 'host' : 'participant')
      assert.deepEqual(s.conferenceList('other'), [])
    }
    // Step 6: a participant leaves, then the host closes the remaining room.
    assert.equal(await sc.leaveConference('c', a.id), true)
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.kind === 'departure')))
    assert.equal(sc.core().read(0).events.at(-1)?.kind, 'closed')
    await assert.rejects(sc.postToConference({ session: 'c', conference: a.id, text: 'late' }), /not in this conference/)
    await sa.leaveConference('a', a.id)
    await until(() => sb.core().read(0).events.some(e => e.kind === 'closed'))
    assert.equal(sb.core().read(0).events.at(-1)?.peer, infoA.peerId)
    assert.deepEqual(sb.conferenceList(), [])
  } finally { await sc.stop(); await stop() }
})
// Docs: VORTEX_v5.1.md sections 6.3 and 9.1
test('unknown refs send nothing and unanswered joins time out without retaining a pending join', { timeout: 60000 }, async () => {
  const { sa, sb, stop, sentTo } = await pair()
  try {
    const before = sentTo.length
    await assert.rejects(sb.joinConference({ session: 'b', ref: 'f'.repeat(32) }), /no match with that record: read your match events and use the record of one/)
    assert.equal(sentTo.length, before)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    // The holder keeps its transport but has no conference handler answering joins.
    ;(sa as unknown as { conferences: { stop: () => void } }).conferences.stop()
    for (let i = 0; i < 2; i++) {
      const started = Date.now()
      await assert.rejects(sb.joinConference({ session: 'b', ref: a.id }, 500), /join timed out: the holder did not answer/)
      assert.ok(Date.now() - started < 2000)
      assert.deepEqual(sb.conferenceList(), [])
    }
    for (const text of ['', 'é'.repeat(8193)]) {
      await assert.rejects(sb.postToConference({ session: 'b', conference: a.id, text }), /1–16384 bytes/)
    }
    assert.equal(await sb.leaveConference('b', 'f'.repeat(32)), false)
  } finally { await stop() }
})
// Docs: VORTEX_v5.1.md section 9.3
test('a failed conference save reports once with fixed text and conference events survive restart', { timeout: 60000 }, async () => {
  let failMessage = false
  let saved: Snapshot | undefined
  const errors: string[] = []
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', s => {
    if (failMessage && s.events.at(-1)?.kind === 'conference_message') throw new Error('peer text in disk error')
    saved = s
  }, undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sa.start(); await sb.start()
    await sa.dial(sb.info().addrs[0]); await sleep(2500)
    const a = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: a.id })
    await until(() => sa.core().read(0).events.some(e => e.kind === 'arrival'))
    failMessage = true
    await sb.postToConference({ session: 'b', conference: a.id, text: 'lost words' })
    await until(() => errors.length > 0)
    assert.deepEqual(errors, ['conference event for ' + a.id + ' could not be saved'])
    assert.ok(!sa.core().read(0).events.some(e => e.body === 'lost words'))
    failMessage = false
    await sb.postToConference({ session: 'b', conference: a.id, text: 'kept words' })
    await until(() => sa.core().read(0).events.some(e => e.body === 'kept words'))
  } finally { await sa.stop(); await sb.stop() }
  const restored = new VortexService(await createNodeTransport(), 'a', () => {}, saved, { embedder: fakeEmbedder() })
  try {
    await restored.start()
    assert.ok(restored.core().read(0).events.some(e => e.body === 'kept words'))
    assert.deepEqual(restored.conferenceList(), [])
  } finally { await restored.stop() }
})
// Docs: VORTEX_v5.1.md section 9.1
test('conference methods require semantic discovery', async () => {
  const service = new VortexService(await createNodeTransport(), 'a', () => {})
  try {
    await service.start()
    await assert.rejects(service.joinConference({ session: 's', ref: 'a'.repeat(32) }), /not enabled/)
    await assert.rejects(service.postToConference({ session: 's', conference: 'a'.repeat(32), text: 'hi' }), /not enabled/)
    await assert.rejects(service.leaveConference('s', 'a'.repeat(32)), /not enabled/)
    assert.throws(() => service.conferenceList(), /not enabled/)
  } finally { await service.stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1, 6.3, 10.6 and 11.2
test('a later service discovers and joins the same hosted room after its forming interest is withdrawn', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, stop } = await pair()
  const tc = await createNodeTransport()
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sc.start()
    await sc.dial(infoA.addrs[0]); await sc.dial(infoB.addrs[0])
    await sleep(2500)
    const first = await sa.announceStatement({ session: 'a', statement: 'base' })
    await sleep(500)
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    await sb.core().wait(undefined, 10000)
    await sb.joinConference({ session: 'b', ref: first.id })
    assert.equal(sa.withdrawInterest('a', first.id), true)
    const third = await sc.announceStatement({ session: 'c', statement: 'tier8' })
    await until(() => sc.matchesFor(third.id).some(m => m.record === first.id && m.kind === 'conference'))
    const match = sc.matchesFor(third.id).find(m => m.record === first.id)!
    assert.deepEqual(Object.keys(match).sort(), ['addrs', 'admission', 'capacity', 'count', 'expires', 'fullScore', 'host', 'kind', 'peer', 'record', 'score', 'tier'])
    assert.equal(match.count, 2)
    assert.equal(match.host, infoA.peerId)
    assert.deepEqual(sc.conferenceList(), [])
    await until(() => sc.core().read(0).events.some(e => e.kind === 'match' && e.record === first.id))
    const event = sc.core().read(0).events.find(e => e.kind === 'match' && e.record === first.id)!
    assert.equal(event.recordKind, 'conference')
    await assert.rejects(sc.joinConference({ session: 'unknown', ref: first.id }), /no match/)
    const joined = await sc.joinConference({ session: 'c', ref: first.id })
    assert.equal(joined.id, first.id)
    assert.equal(joined.count, 3)
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.kind === 'arrival' && e.participant === joined.key)))
    const posted = await sc.postToConference({ session: 'c', conference: first.id, text: 'later arrival' })
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.message === posted.message)))
    for (const service of [sa, sb]) {
      assert.equal(service.core().read(0).events.filter(e => e.kind === 'arrival' && e.participant === joined.key).length, 1)
      assert.equal(service.core().read(0).events.filter(e => e.message === posted.message).length, 1)
    }
    // The same participant can leave, rediscover the host without its forming interest, and rejoin.
    assert.equal(await sc.leaveConference('c', first.id), true)
    await until(() => sa.conferenceList()[0].count === 2 && sb.conferenceList()[0].count === 2)
    const rediscovered = await sc.announceStatement({ session: 'c', statement: 'tier8', replaces: third.id })
    await until(() => sc.matchesFor(rediscovered.id).some(m => m.record === first.id && m.kind === 'conference'))
    const rejoined = await sc.joinConference({ session: 'c', ref: first.id })
    assert.equal(rejoined.id, first.id)
    assert.notEqual(rejoined.key, joined.key)
    assert.equal(rejoined.count, 3)
    const returned = await sc.postToConference({ session: 'c', conference: first.id, text: 'back again' })
    await until(() => [sa, sb].every(s => s.core().read(0).events.some(e => e.message === returned.message)))
    for (const service of [sa, sb]) {
      assert.equal(service.core().read(0).events.find(e => e.message === returned.message)?.participant, rejoined.key)
    }
    await sa.leaveConference('a', first.id)
    const afterClose = await sc.announceStatement({ session: 'c2', statement: 'base' })
    await sleep(500)
    assert.equal(sc.matchesFor(afterClose.id).some(m => m.record === first.id), false)
  } finally { await sc.stop(); await stop() }
})

// Docs: VORTEX_v5.1.md sections 6.2, 6.3 and 10.2
test('an explicitly created group room is discovered without a forming interest, then admits its selected peer', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base', capacity: 2,
      admission: 'group', peers: [infoB.peerId] })
    assert.equal(room.role, 'host')
    assert.equal(room.count, 1)
    assert.equal(room.admission, 'group')
    assert.deepEqual(sa.openInterests(), [])
    await until(() => sa.core().read(0).events.some(event => event.kind === 'formed' && event.conference === room.id))
    await sa.postToConference({ session: 'host', conference: room.id, text: 'before the guest joined' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(match => match.record === room.id))
    const match = sb.matchesFor(interest.id).find(match => match.record === room.id)!
    assert.equal(match.kind, 'conference')
    assert.equal(match.admission, 'group')
    assert.equal(match.peer, infoA.peerId)
    const joined = await sb.joinConference({ session: 'guest', ref: room.id })
    assert.equal(joined.count, 2)
    const cursor = sb.core().read(0).cursor
    const history = await sb.conferenceHistory({ session: 'guest', conference: room.id, limit: 1 })
    assert.equal(history.historyCursor, 1)
    assert.equal('cursor' in history, false)
    assert.equal(history.messages[0].body, 'before the guest joined')
    assert.equal(history.messages[0].service, infoA.peerId)
    assert.equal(sb.core().read(0).cursor, cursor)
    const sent = await sb.postToConference({ session: 'guest', conference: room.id, text: 'explicit room works' })
    await until(() => sa.core().read(0).events.some(event => event.message === sent.message))
    await sb.leaveConference('guest', room.id)
    await assert.rejects(sb.conferenceHistory({ session: 'guest', conference: room.id }), /not in this conference/)
    await until(() => sa.conferenceList()[0].count === 1)
    await sb.joinConference({ session: 'guest', ref: room.id })
  } finally { await stop() }
})

test('explicit creation checks disclosure and input before inference or signing', async () => {
  const transport = await createNodeTransport()
  let embeds = 0, signs = 0
  const embedder = fakeEmbedder()
  const service = new VortexService({ ...transport, sign: async data => { signs++; return transport.sign(data) } },
    'test', () => {}, undefined, { embedder: { ...embedder, embed: async text => { embeds++; return embedder.embed(text) } },
      disclosure: createDisclosurePolicy({ blockedProjectIds: ['blocked'] }) })
  try {
    await service.start()
    const before = { embeds, signs }
    await assert.rejects(service.createConference({ session: 's', statement: 'blocked' }), /disclosure/)
    await assert.rejects(service.createConference({ session: 's', statement: 'base', capacity: 1 }), /capacity/)
    await assert.rejects(service.createConference({ session: '', statement: 'base' }), /session/)
    assert.deepEqual({ embeds, signs }, before)
    assert.deepEqual(service.conferenceList(), [])
  } finally { await service.stop() }
})

test('explicit creation cannot survive service stop during embedding', async () => {
  const embedder = fakeEmbedder()
  let release = () => {}, entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined,
    { embedder: { ...embedder, embed: async text => { entered(); await gate; return embedder.embed(text) } } })
  await service.start()
  const pending = service.createConference({ session: 's', statement: 'base' }).catch(error => error)
  try {
    await ready
    await service.stop()
    release()
    assert.match((await pending).message, /stopped/)
    assert.deepEqual(service.conferenceList(), [])
  } finally { release(); await service.stop() }
})

test('explicit creation uses captured options across operator approval', async () => {
  let release = () => {}, entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const statements: string[] = []
  const embedder = fakeEmbedder()
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined, {
    embedder: { ...embedder, embed: async text => { statements.push(text); return embedder.embed(text) } },
    disclosure: createDisclosurePolicy({ requireApproval: true }, async () => { entered(); await gate })
  })
  const request = { session: 'original', statement: 'base', capacity: 3, admission: 'group' as const, peers: [peer] }
  await service.start()
  const pending = service.createConference(request)
  try {
    await ready
    request.session = 'changed'; request.statement = 'far'; request.capacity = 1; request.peers[0] = 'invalid'
    release()
    const room = await pending
    assert.equal(room.session, 'original')
    assert.equal(room.capacity, 3)
    assert.equal(room.admission, 'group')
    assert.deepEqual(statements, ['base'])
  } finally { release(); await service.stop() }
})

// Docs: VORTEX_v5.1.md section 6.5 — service subscription lifecycle (subscribe/renew/expire/leave/stop/closed).
async function singleService(options: Record<string, unknown> = {}, save?: (s: Snapshot) => void) {
  const service = new VortexService(await createNodeTransport(), 'test', save ?? (() => {}), undefined,
    { embedder: fakeEmbedder(), ...(options as object) })
  await service.start()
  return service
}

test('subscribe validates membership, session ownership, ttl bounds and clips to room expiry', async () => {
  const service = await singleService()
  try {
    const room = await service.createConference({ session: 'host', statement: 'base' })
    const request = { session: 'host', conference: room.id, ttl: 3600 }
    const sub = await service.subscribeConference(request)
    request.ttl = 1
    assert.deepEqual(Object.keys(sub).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session'])
    assert.equal(sub.conference, room.id)
    assert.equal(sub.session, 'host')
    assert.ok(sub.expires <= Date.now() + 3600 * 1000 && sub.expires > Date.now())
    await assert.rejects(service.subscribeConference({ session: 'host', conference: room.id, ttl: 0 }), /ttl|expiry|range/)
    await assert.rejects(service.subscribeConference({ session: 'host', conference: room.id, ttl: 86401 }), /ttl|expiry|range/)
    await assert.rejects(service.subscribeConference({ session: 'other', conference: room.id, ttl: 60 }), /member|session|conference/)
    await assert.rejects(service.subscribeConference({ session: 'host', conference: 'f'.repeat(32), ttl: 60 }), /member|conference/)
    await assert.rejects(service.subscribeConference({ session: 'host', conference: 'bad', ttl: 60 }), /conference|invalid/)
    assert.throws(() => new VortexService(service.info() as never, 'x', () => {}, undefined, { embedder: fakeEmbedder(), subscriptions: { maxCount: 0 } } as never), /subscri/)
    assert.throws(() => new VortexService(service.info() as never, 'x', () => {}, undefined, { embedder: fakeEmbedder(), subscriptions: { maxTtl: 604801 } } as never), /subscri|ttl/)
  } finally { await service.stop() }
})

test('host omits membership privately while participant stores hex, and public outputs stay private', async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const hostSub = await sa.subscribeConference({ session: 'host', conference: room.id, ttl: 120 })
    assert.deepEqual(Object.keys(hostSub).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session'])
    const hostStored = sa.core().storedSubscriptions()[room.id]
    assert.equal(hostStored.membership, undefined)
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    const joined = await sb.joinConference({ session: 'guest', ref: room.id })
    const guestSub = await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 120 })
    assert.deepEqual(Object.keys(guestSub).sort(), ['conference', 'expires', 'historyCursor', 'host', 'session'])
    const stored = sb.core().storedSubscriptions()[room.id]
    assert.match(stored.membership!.descriptor, /^[0-9a-f]+$/)
    assert.match(stored.membership!.privateKey, /^[0-9a-f]+$/)
    assert.ok(!JSON.stringify(guestSub).includes(stored.membership!.privateKey))
    assert.ok(!JSON.stringify(sb.core().read().events).includes(stored.membership!.privateKey))
    assert.ok(!JSON.stringify(sb.subscriptions()).includes(stored.id))
    void joined
  } finally { await stop() }
})

test('subscription count limit, renewal preserves cursor and reschedules expiry', async () => {
  const service = await singleService({ subscriptions: { maxCount: 2, maxTtl: 3600 } })
  try {
    const r1 = await service.createConference({ session: 's', statement: 'base' })
    const r2 = await service.createConference({ session: 's', statement: 'base' })
    const r3 = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: r1.id, ttl: 100 })
    await service.subscribeConference({ session: 's', conference: r2.id, ttl: 100 })
    await assert.rejects(service.subscribeConference({ session: 's', conference: r3.id, ttl: 100 }), /too many|subscri/)
    const first = service.subscriptions('s').find(s => s.conference === r1.id)!
    const renewed = await service.subscribeConference({ session: 's', conference: r1.id, ttl: 200 })
    assert.equal(renewed.historyCursor, first.historyCursor)
    assert.ok(renewed.expires >= first.expires)
    assert.equal(service.subscriptions('s').length, 2)
  } finally { await service.stop() }
})

test('expired subscription is removed durably and membership is left', { timeout: 15000 }, async () => {
  const service = await singleService()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 1 })
    assert.equal(service.subscriptions('s').length, 1)
    await until(() => service.subscriptions('s').length === 0, 8000)
    assert.deepEqual(service.conferenceList('s'), [])
  } finally { await service.stop() }
})

test('failed subscription save preserves membership and retries expiry without spinning', { timeout: 15000 }, async () => {
  const errors: string[] = []
  let fail = true
  let saves = 0
  const service = new VortexService(await createNodeTransport(), 'test', () => { saves++; if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    fail = true
    await assert.rejects(service.subscribeConference({ session: 's', conference: room.id, ttl: 60 }), /disk full/)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.equal(service.conferenceList('s').length, 1)
    fail = false
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 1 })
    fail = true
    await until(() => errors.some(m => m === 'subscription expiry could not be saved'), 8000)
    const expiryErrors = (): string[] => errors.filter(m => m === 'subscription expiry could not be saved')
    const seen = expiryErrors().length
    await sleep(1500)
    assert.ok(expiryErrors().length - seen <= 2, 'bounded retries, no spin')
    assert.ok(!expiryErrors().some(m => m.includes('disk')), 'generic error, no cache detail')
    fail = false
    await until(() => service.subscriptions('s').length === 0, 8000)
  } finally { await service.stop() }
})

test('blocked renewal queued ahead of stale expiry keeps the renewed subscription', { timeout: 15000 }, async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 1 })
    block = true
    const renewal = service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    await sleep(1300)
    release()
    await renewal
    await sleep(300)
    assert.equal(service.subscriptions('s').length, 1)
    assert.equal(service.conferenceList('s').length, 1)
    assert.ok(service.subscriptions('s')[0].expires > Date.now() + 200 * 1000)
  } finally { release(); await service.stop() }
})

test('pending leave spanning stop settles without recreating maintenance work', { timeout: 15000 }, async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    block = true
    const leaving = service.leaveConference('s', room.id)
    await sleep(100)
    const stopping = service.stop()
    await sleep(100)
    release()
    await leaving.catch(() => {})
    await stopping
    await sleep(1300)
    assert.equal((service as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
  } finally { release(); await service.stop().catch(() => {}) }
})

test('failed close retries and removes the subscription without spinning', { timeout: 60000 }, async () => {  const errors: string[] = []
  let fail = false
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  try {
    await sa.start()
    await sb.start()
    await sa.dial(sb.info().addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyHex = sb.core().storedSubscriptions()[room.id].membership!.privateKey
    fail = true
    await sa.leaveConference('host', room.id)
    await until(() => errors.some(m => m === 'subscription close could not be saved'), 10000)
    assert.equal(sb.subscriptions('guest').length, 1)
    const closeErrors = (): string[] => errors.filter(m => m === 'subscription close could not be saved')
    const seen = closeErrors().length
    await sleep(1500)
    assert.ok(closeErrors().length - seen <= 2, 'bounded retries, no spin')
    assert.ok(!errors.some(m => m.includes(keyHex)), 'no key material in errors')
    fail = false
    await until(() => sb.subscriptions('guest').length === 0, 10000)
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('failed orphan host cleanup retries after saves recover, participant subs remain', { timeout: 20000 }, async () => {  const errors: string[] = []
  let fail = false
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    await service.core().setSubscription({ conference: 'f'.repeat(32), session: 'p', host: 'h',
      expires: Date.now() + 300000, membership: { descriptor: 'aa', privateKey: 'bb' } })
    await service.stop()
    fail = true
    await service.start()
    await until(() => errors.some(m => m === 'subscription close could not be saved'), 8000)
    assert.equal(service.subscriptions('s').length, 1)
    fail = false
    await until(() => service.subscriptions('s').length === 0, 8000)
    assert.equal(service.subscriptions('p').length, 1)
  } finally { fail = false; await service.stop().catch(() => {}) }
})

test('unsubscribe removes durably then leaves, and ordinary leave removes same-session subscription', async () => {
  const service = await singleService()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 120 })
    assert.equal(await service.unsubscribeConference('s', room.id), true)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.deepEqual(service.conferenceList('s'), [])
    assert.equal(await service.unsubscribeConference('s', room.id), false)
    const room2 = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room2.id, ttl: 120 })
    assert.equal(await service.leaveConference('s', room2.id), true)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.equal(await service.leaveConference('wrong', room2.id), false)
  } finally { await service.stop() }
})

test('stop preserves subscriptions and same-instance restart retains participant state while ending orphan host rooms', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    await sa.subscribeConference({ session: 'host', conference: room.id, ttl: 300 })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sb.stop()
    await sb.start()
    assert.equal(sb.subscriptions('guest').length, 1)
    await sa.stop()
    await sa.start()
    await until(() => sa.subscriptions('host').length === 0, 8000)
    void infoA
  } finally { await stop() }
})

test('closed room ends its subscription durably', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    assert.equal(sb.subscriptions('guest').length, 1)
    await sa.leaveConference('host', room.id)
    await until(() => sb.subscriptions('guest').length === 0, 10000)
  } finally { await stop() }
})

test('blocked leave spanning stop/restart throws without touching the new run', { timeout: 20000 }, async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    block = true
    const leaving = service.leaveConference('s', room.id)
    const settled = leaving.then(() => 'resolved', (error: unknown) => error)
    await sleep(100)
    const stopping = service.stop()
    await sleep(100)
    release()
    await stopping
    await service.start()
    block = false
    assert.match((await settled as Error).message, /stopped during leave/)
    await sleep(200)
    assert.equal((service as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
    assert.deepEqual(service.conferenceList('s'), [])
  } finally { release(); await service.stop().catch(() => {}) }
})

test('failing expiry backs off while unrelated renews reschedule', { timeout: 20000 }, async () => {
  const errors: string[] = []
  let fail = false
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    const expiring = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: expiring.id, ttl: 1 })
    const other = await service.createConference({ session: 's', statement: 'base' })
    await service.subscribeConference({ session: 's', conference: other.id, ttl: 300 })
    fail = true
    const expiryErrors = (): string[] => errors.filter(m => m === 'subscription expiry could not be saved')
    await until(() => expiryErrors().length >= 1, 8000)
    fail = false
    await service.subscribeConference({ session: 's', conference: other.id, ttl: 300 })
    fail = true
    const atRenew = expiryErrors().length
    await sleep(25)
    assert.equal(expiryErrors().length, atRenew, 'no retry within 25ms of an unrelated reschedule')
    await sleep(1500)
    assert.ok(expiryErrors().length - atRenew <= 2, 'bounded retries, no spin')
    fail = false
    await until(() => service.subscriptions('s').find(s => s.conference === expiring.id) === undefined, 8000)
    assert.equal(service.subscriptions('s').length, 1)
  } finally { fail = false; await service.stop().catch(() => {}) }
})

test('subscribe save spanning room close rejects without leaving an orphan', async () => {
  let release: () => void = () => {}
  let block = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (block) return gate },
    undefined, { embedder: fakeEmbedder(), onError: () => {} })
  await service.start()
  try {
    const room = await service.createConference({ session: 's', statement: 'base' })
    block = true
    const pending = service.subscribeConference({ session: 's', conference: room.id, ttl: 300 })
    const settled = pending.then(() => 'resolved', (error: unknown) => error)
    await sleep(100)
    // Close at the engine level without touching the subscription store.
    const engine = (service as unknown as { conferences: { leave: (c: string, s: string) => Promise<boolean> } }).conferences
    await engine.leave(room.id, 's')
    release()
    assert.match(((await settled) as Error).message, /closed during subscribe/)
    await until(() => service.subscriptions('s').length === 0, 5000)
  } finally { release(); await service.stop().catch(() => {}) }
})

// Docs: VORTEX_v5.1.md section 6.5 — automatic subscription recovery and replay.
test('restarted participant resumes same key and replays missed history', { timeout: 90000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyBefore = sb.conferenceList('guest')[0].key
    const privateHex = sb.core().storedSubscriptions()[room.id].membership!.privateKey
    await sb.stop()
    const m1 = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    const m2 = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed two' })
    await sb.start()
    await until(() => sb.core().read(0).events.some(e => e.message === m1.message), 30000)
    await until(() => sb.core().read(0).events.some(e => e.message === m2.message), 30000)
    assert.equal(sb.conferenceList('guest')[0].key, keyBefore)
    assert.equal(sa.conferenceList('host')[0].count, 2)
    // Renew during recovery must not duplicate; live posts arrive exactly once.
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const m3 = await sa.postToConference({ session: 'host', conference: room.id, text: 'live after' })
    await until(() => sb.core().read(0).events.some(e => e.message === m3.message), 30000)
    await sleep(500)
    assert.equal(sb.core().read(0).events.filter(e => e.message === m3.message).length, 1)
    assert.equal(sb.core().read(0).events.filter(e => e.message === m1.message).length, 1)
    const pub = JSON.stringify({ subs: sb.subscriptions(), events: sb.core().read(0).events })
    assert.ok(!pub.includes(privateHex))
  } finally { await stop() }
})

test('recovery save failure keeps cursor and retries after saves recover', { timeout: 90000 }, async () => {
  const errors: string[] = []
  let fail = false
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => { if (fail) throw new Error('disk full') },
    undefined, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  try {
    await sa.start()
    await sb.start()
    await sa.dial(sb.info().addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sb.stop()
    await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    fail = true
    await sb.start()
    await until(() => errors.some(m => m === 'subscription recovery failed'), 20000)
    assert.equal(sb.core().storedSubscriptions()[room.id].historyCursor, 0)
    assert.deepEqual(sb.core().read(0).events.filter(e => e.kind === 'conference_message'), [])
    assert.ok(!errors.some(m => m.includes('disk')))
    fail = false
    await until(() => sb.core().read(0).events.some(e => e.body === 'missed one'), 20000)
  } finally { fail = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('wrong-room and malformed private cache cause no sends', async () => {
  const sent: string[] = []
  const raw = await createNodeTransport()
  const transport = { ...raw,
    send: async (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]): Promise<void> => {
      sent.push(peer)
      return raw.send(peer, data, addrs)
    } }
  const hostKey = await generateKeyPair('Ed25519')
  const hostPeer = peerIdFromPrivateKey(hostKey).toString()
  const mismatched = '0f'.repeat(16)
  const { createDescriptor } = await import('./conference-records.ts')
  const { bytes } = await createDescriptor({ id: mismatched, profile, topicVector: table.exact,
    host: hostPeer, addrs: [`/ip4/127.0.0.1/tcp/1/p2p/${hostPeer}`], participantCount: 1, capacity: 8,
    admission: 'open', createdAt: Date.now() - 1000, expiresAt: Date.now() + 3600000,
    sign: async data => hostKey.sign(data), now: Date.now() })
  const descriptorHex = Buffer.from(bytes).toString('hex')
  const sub = (conference: string, host: string, membership: { descriptor: string, privateKey: string }): RoomSubscription => ({
    id: 'sub-' + conference.slice(0, 8), conference, session: 's', host,
    expires: Date.now() + 300000, historyCursor: 0, membership
  })
  const errors: string[] = []
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [subConfWrongRoom()]: sub(subConfWrongRoom(), hostPeer, { descriptor: descriptorHex, privateKey: 'aa' }),
      [subConfMalformed()]: sub(subConfMalformed(), hostPeer, { descriptor: 'zz', privateKey: 'aa' }),
      [subConfUndecodable()]: sub(subConfUndecodable(), hostPeer, { descriptor: 'aa'.repeat(10), privateKey: 'aa' })
    } }
  const service = new VortexService(transport, 'b', () => {}, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await sleep(1500)
    assert.deepEqual(sent, [])
    assert.deepEqual(service.conferenceList('s'), [])
    assert.equal(service.subscriptions('s').length, 3)
    assert.ok(errors.length >= 1)
    assert.ok(errors.every(m => m === 'subscription recovery failed'))
  } finally { await service.stop().catch(() => {}) }
  function subConfWrongRoom (): string { return 'aa'.repeat(16) }
  function subConfMalformed (): string { return 'bb'.repeat(16) }
  function subConfUndecodable (): string { return 'cc'.repeat(16) }
})

test('unsubscribe and stop cancel pending recovery without resurrection', { timeout: 30000 }, async () => {
  const errors: string[] = []
  const conf = 'dd'.repeat(16)
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [conf]: { id: 'sub-id', conference: conf, session: 's', host: 'h',
        expires: Date.now() + 300000, historyCursor: 0,
        membership: { descriptor: 'aa'.repeat(10), privateKey: 'bb' } }
    } }
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await until(() => errors.length >= 1, 8000)
    assert.deepEqual(errors, ['subscription recovery failed'])
    assert.equal(await service.unsubscribeConference('s', conf), true)
    await sleep(2000)
    assert.deepEqual(service.subscriptions('s'), [])
    assert.deepEqual(errors, ['subscription recovery failed'])
    await service.stop()
    await sleep(1200)
    assert.deepEqual(errors, ['subscription recovery failed'])
    assert.equal((service as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
  } finally { await service.stop().catch(() => {}) }
})

test('wrong-session and failed-save unsubscribe keep owner recovery alive', { timeout: 30000 }, async () => {
  const errors: string[] = []
  let fail = false
  const conf = 'ee'.repeat(16)
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [conf]: { id: 'sub-id', conference: conf, session: 's', host: 'h',
        expires: Date.now() + 300000, historyCursor: 0,
        membership: { descriptor: 'aa'.repeat(10), privateKey: 'bb' } }
    } }
  const service = new VortexService(await createNodeTransport(), 'test', () => { if (fail) throw new Error('disk full') }, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await until(() => errors.length >= 1, 8000)
    assert.equal(await service.unsubscribeConference('wrong', conf), false)
    assert.equal(service.subscriptions('s').length, 1)
    await until(() => errors.length >= 2, 8000)
    fail = true
    await assert.rejects(service.unsubscribeConference('s', conf), /disk full/)
    assert.equal(service.subscriptions('s').length, 1)
    fail = false
    await until(() => errors.length >= 3, 10000)
    assert.equal(await service.unsubscribeConference('s', conf), true)
    const settled = errors.length
    await sleep(1500)
    assert.equal(errors.length, settled)
    assert.deepEqual(service.subscriptions('s'), [])
  } finally { fail = false; await service.stop().catch(() => {}) }
})

test('reconnect during backoff waits for the retry deadline', { timeout: 30000 }, async () => {
  const errors: string[] = []
  const conf = 'ef'.repeat(16)
  const tc = await createNodeTransport()
  await tc.start()
  const hostPeer = tc.info().peerId
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    subscriptions: {
      [conf]: { id: 'sub-id', conference: conf, session: 's', host: hostPeer,
        expires: Date.now() + 300000, historyCursor: 0,
        membership: { descriptor: 'aa'.repeat(10), privateKey: 'bb' } }
    } }
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, restored,
    { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  await service.start()
  try {
    await until(() => errors.length >= 1, 8000)
    await tc.dial(service.info().addrs[0])
    const atConnect = errors.length
    await sleep(300)
    assert.equal(errors.length, atConnect)
    await until(() => errors.length > atConnect, 8000)
    assert.ok(errors.every(m => m === 'subscription recovery failed'))
  } finally { await tc.stop().catch(() => {}); await service.stop().catch(() => {}) }
})

test('transport reconnect replays missed posts without restarting room membership', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sa.postToConference({ session: 'host', conference: room.id, text: 'before disconnect' })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await until(() => sb.core().storedSubscriptions()[room.id].historyCursor === 1)
    const key = sb.conferenceList('guest')[0].key
    const transport = (sb as unknown as { transport: Transport }).transport
    await transport.stop()
    const missed = await sa.postToConference({ session: 'host', conference: room.id, text: 'during disconnect' })
    assert.ok(!sb.core().read(0).events.some(e => e.message === missed.message))
    await transport.start()
    await sb.dial(infoA.addrs[0])
    await until(() => sb.core().read(0).events.some(e => e.message === missed.message), 20000)
    await until(() => sb.core().storedSubscriptions()[room.id].historyCursor === 2)
    assert.equal(sb.conferenceList('guest')[0].key, key)
    assert.equal(sb.core().read(0).events.filter(e => e.message === missed.message).length, 1)
  } finally { await stop() }
})

for (const ending of ['unsubscribe', 'stop'] as const) {
test(`held resume reply aborted by ${ending} never resurrects`, { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sb.stop()
    await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    const saTransport = (sa as unknown as { transport: Transport }).transport
    const origSend = saTransport.send.bind(saTransport)
    const sbTransport = (sb as unknown as { transport: Transport }).transport
    const origDirect = sbTransport.onDirect.bind(sbTransport)
    const lateHandlers: Array<(event: DirectEvent) => void> = []
    sbTransport.onDirect = handler => { lateHandlers.push(handler); return origDirect(handler) }
    const held: Array<{ peer: PeerId, data: Uint8Array, addrs?: Multiaddr[] }> = []
    let hold = false
    saTransport.send = (async (peer: PeerId, data: Uint8Array, addrs?: Multiaddr[]) => {
      if (hold) { held.push({ peer, data, addrs }); return }
      return origSend(peer, data, addrs)
    }) as typeof saTransport.send
    const releaseHeld = async (addrs?: Multiaddr[]): Promise<void> => {
      hold = false
      for (const packet of held) await origSend(packet.peer, packet.data, addrs ?? packet.addrs)
      held.length = 0
    }
    try {
      hold = true
      await sb.start()
      await until(() => held.length > 0, 10000)
      assert.deepEqual(sb.conferenceList('guest'), [])
      if (ending === 'unsubscribe') {
        assert.equal(await sb.unsubscribeConference('guest', room.id), true)
        assert.deepEqual(sb.subscriptions('guest'), [])
        await until(() => sa.conferenceList('host')[0]?.count === 1, 2000)
      } else {
        await sb.stop()
        assert.equal(sb.subscriptions('guest').length, 1)
        // Deliver the real signed reply to callbacks captured before stop,
        // as if it were already queued when the handlers were unregistered.
        hold = false
        for (const packet of held) {
          for (const handler of lateHandlers) handler({ from: sa.info().peerId, data: packet.data })
        }
        held.length = 0
        await sleep(1500)
        assert.deepEqual(sb.conferenceList('guest'), [])
        assert.equal(sb.subscriptions('guest').length, 1)
        assert.ok(!sb.core().read(0).events.some(e => e.body === 'missed one'))
        assert.equal((sb as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
        return
      }
      await releaseHeld()
      await sleep(1500)
      assert.deepEqual(sb.conferenceList('guest'), [])
      assert.deepEqual(sb.subscriptions('guest'), [])
      assert.ok(!sb.core().read(0).events.some(e => e.body === 'missed one'))
      assert.equal((sb as unknown as { expiryTimer?: unknown }).expiryTimer, undefined)
    } finally {
      hold = false
      saTransport.send = origSend
      sbTransport.onDirect = origDirect
    }
  } finally { await stop() }
})
}

test('delayed recovery page overlaps live events without duplication', { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const subId = sb.core().storedSubscriptions()[room.id].id
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    const origHistory = engine.history.bind(engine)
    let delayOnce = true
    engine.history = (async (request: Parameters<typeof engine.history>[0]) => {
      if (delayOnce) { delayOnce = false; await sleep(1500) }
      return origHistory(request)
    }) as typeof engine.history
    try {
      const m1 = await sa.postToConference({ session: 'host', conference: room.id, text: 'first' })
      await until(() => sb.core().read(0).events.some(e => e.message === m1.message), 10000)
      const renewed = sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
      const settled = renewed.then(() => 'resolved', (error: unknown) => error)
      await sleep(300)
      // Advance the store cursor while the real page awaits: the stale page
      // must neither append nor roll the cursor back.
      const baseline = sb.core().storedSubscriptions()[room.id].historyCursor
      assert.equal(await sb.core().applySubscriptionHistory(room.id, subId, baseline, baseline + 5, []), 0)
      assert.equal(sb.core().storedSubscriptions()[room.id].historyCursor, baseline + 5)
      const m2 = await sa.postToConference({ session: 'host', conference: room.id, text: 'second' })
      assert.equal(await settled, 'resolved')
      await until(() => sb.core().read(0).events.some(e => e.message === m2.message), 10000)
      await sleep(500)
      const events = sb.core().read(0).events
      assert.equal(events.filter(e => e.message === m1.message).length, 1)
      assert.equal(events.filter(e => e.message === m2.message).length, 1)
      assert.equal(sb.core().storedSubscriptions()[room.id].historyCursor, baseline + 5)
    } finally {
      engine.history = origHistory
    }
  } finally { await stop() }
})

// Docs: VORTEX_v5.1.md sections 6.1 and 11.5 — host-only topic revision.
test('host revision policy rejects before inference and keeps the old topic', { timeout: 60000 }, async () => {
  let embedded = 0
  const embedder = fakeEmbedder()
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined,
    { embedder: { ...embedder, embed: async text => { embedded++; return embedder.embed(text) } } })
  try {
    await service.start()
    const room = await service.createConference({ session: 'host', statement: 'base' })
    assert.equal(room.revision, 1)
    embedded = 0
    await assert.rejects(service.reviseConference({ session: 'other', conference: room.id, statement: 'base' }), /host owner|not hosting|member/)
    await assert.rejects(service.reviseConference({ session: 'host', conference: 'f'.repeat(32), statement: 'base' }), /host owner|not hosting|member|conference/)
    await assert.rejects(service.reviseConference({ session: 'host', conference: room.id, statement: '' }), /statement/)
    await assert.rejects(service.reviseConference({ session: 'host', conference: room.id, statement: 'x'.repeat(4097) }), /statement/)
    assert.equal(embedded, 0)
    assert.equal(service.conferenceList('host')[0].revision, 1)
    assert.equal(service.conferenceList('host')[0].count, 1)
  } finally { await service.stop() }
})

test('revision uses the captured approval request', { timeout: 60000 }, async () => {
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const statements: string[] = []
  const embedder = fakeEmbedder()
  let approvals = 0
  const service = new VortexService(await createNodeTransport(), 'test', () => {}, undefined, {
    embedder: { ...embedder, embed: async text => { statements.push(text); return embedder.embed(text) } },
    disclosure: createDisclosurePolicy({ requireApproval: true }, async () => { approvals++; if (approvals === 2) { entered(); await gate } })
  })
  await service.start()
  try {
    const created = await service.createConference({ session: 'host', statement: 'base' })
    const request = { session: 'host', conference: created.id, statement: 'tier8' }
    const pending = service.reviseConference(request)
    await ready
    request.statement = 'far'
    release()
    const revised = await pending
    assert.equal(revised.revision, 2)
    assert.deepEqual(statements.slice(-1), ['tier8'])
  } finally { release(); await service.stop() }
})

test('revision fans out to members and discovery matches the new topic', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'far' })
    const cold = await sb.announceStatement({ session: 'cold', statement: 'exact' })
    await sleep(1500)
    assert.ok(!sb.matchesFor(cold.id).some(m => m.record === room.id && m.kind === 'conference'))
    const revised = await sa.reviseConference({ session: 'host', conference: room.id, statement: 'base' })
    assert.equal(revised.revision, 2)
    assert.equal(revised.id, room.id)
    const interest = await sb.announceStatement({ session: 'guest', statement: 'exact' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id && m.kind === 'conference'))
    const joined = await sb.joinConference({ session: 'guest', ref: room.id })
    assert.equal(joined.revision, 3)
    assert.equal(joined.count, 2)
  } finally { await stop() }
})

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — original-query subject retention.
test('join captures the original query despite later interest changes', { timeout: 60000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    const joining = sb.joinConference({ session: 'guest', ref: room.id })
    sb.withdrawInterest('guest', interest.id)
    const joined = await joining
    assert.equal(joined.id, room.id)
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    assert.deepEqual(engine.membershipSubject(room.id, 'guest'), {
      statement: 'tier8', vector: subjectHex('tier8'), namespace: profile.id, profileVersion: 1 })
    for (const view of [sb.subscriptions(), sb.conferenceList('guest'), sb.core().read()]) {
      assert.ok(!JSON.stringify(view).includes('tier8'))
    }
    assert.throws(() => engine.membershipSubject(room.id, 'wrong'), /not in this conference/)
  } finally { await stop() }
})

test('revision, restart and renewal preserve the original query', { timeout: 90000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await sleep(1000)
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    const expected = { statement: 'tier8', vector: subjectHex('tier8'), namespace: profile.id, profileVersion: 1 }
    assert.deepEqual(engine.membershipSubject(room.id, 'guest'), expected)
    assert.deepEqual(sb.core().storedSubscriptions()[room.id].subject, expected)
    await sa.reviseConference({ session: 'host', conference: room.id, statement: 'far' })
    await until(() => engine.get(room.id)?.descriptor.revision === 3, 10000)
    assert.deepEqual(engine.membershipSubject(room.id, 'guest'), expected)
    const roster = engine.certifiedParticipants(room.id, 'guest')
    assert.equal(roster.length, 2)
    assert.ok(roster.some(entry => entry.service === sb.info().peerId))
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    assert.deepEqual(sb.core().storedSubscriptions()[room.id].subject, expected)
    await sb.stop()
    await sb.start()
    await sleep(2000)
    assert.deepEqual(sb.core().storedSubscriptions()[room.id].subject, expected)
    for (const view of [sb.subscriptions(), sb.conferenceList('guest'), sb.core().read()]) {
      assert.ok(!JSON.stringify(view).includes('tier8'))
    }
    await sleep(2000)
  } finally { await stop() }
})

test('fresh instance keeps the original query across a host revision', { timeout: 90000 }, async () => {
  const ta = await createNodeTransport()
  const tbRaw = await createNodeTransport()
  let savedB: Snapshot | undefined
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tbRaw, 'b', s => { savedB = s }, undefined, { embedder: fakeEmbedder() })
  try {
    const infoA = await sa.start()
    const infoB = await sb.start()
    await sa.dial(infoB.addrs[0])
    await sleep(2500)
    const room = await sa.createConference({ session: 'host', statement: 'base',
      capacity: 2, admission: 'invitation', peers: [infoB.peerId] })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    const keyBefore = sb.conferenceList('guest')[0].key
    const expected = { statement: 'tier8', vector: subjectHex('tier8'), namespace: profile.id, profileVersion: 1 }
    const exported = (sb as unknown as { transport: { exportKey: () => Uint8Array } }).transport.exportKey()
    await sb.stop()
    await sa.reviseConference({ session: 'host', conference: room.id, statement: 'far' })
    const missed = await sa.postToConference({ session: 'host', conference: room.id, text: 'missed one' })
    assert.ok(savedB !== undefined)
    const restored = JSON.parse(JSON.stringify(savedB)) as Snapshot
    const tb2 = await createNodeTransport({ key: exported })
    const sb2 = new VortexService(tb2, 'b', () => {}, restored, { embedder: fakeEmbedder() })
    try {
      const infoB2 = await sb2.start()
      assert.equal(infoB2.peerId, infoB.peerId)
      await until(() => sb2.core().read(0).events.some(e => e.message === missed.message), 30000)
      await sleep(500)
      assert.equal(sb2.conferenceList('guest')[0].key, keyBefore)
      assert.equal(sb2.core().read(0).events.filter(e => e.message === missed.message).length, 1)
      assert.equal(sa.conferenceList('host')[0].count, 2)
      const engine = (sb2 as unknown as { conferences: Conferences }).conferences
      assert.deepEqual(engine.membershipSubject(room.id, 'guest'), expected)
      for (const view of [sb2.subscriptions(), sb2.conferenceList('guest'), sb2.core().read()]) {
        assert.ok(!JSON.stringify(view).includes('tier8'))
      }
      void infoA
    } finally { await sb2.stop().catch(() => {}) }
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

// Docs: VORTEX_v5.1.md §5.5; TODO.md C9 — private feedback on leave.
test('leave feedback defaults to the original query and honors overrides', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 300 })
    await sa.reviseConference({ session: 'a', conference: joined.id, statement: 'tier8' })
    assert.equal(sb.withdrawInterest('b', match.interest!), true)
    const hostKey = sa.conferenceList('a').find(c => c.id === joined.id)!.key
    assert.equal(await sb.leaveConference('b', joined.id, { outcomes: [{ participant: hostKey, outcome: 'useful' }] }), true)
    const stored = sb.core().storedPeerMemory()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].participant, hostKey)
    assert.equal(stored[0].peer, infoA.peerId)
    assert.equal(stored[0].statement, 'exact')
    assert.equal(stored[0].outcome, 'useful')
    assert.equal(stored[0].namespace, profile.id)
    assert.deepEqual(sb.conferenceList('b'), [])
  } finally { await stop() }
})

test('host feedback defaults to the current topic and honors overrides', { timeout: 60000 }, async () => {
  const { sa, sb, infoB, stop } = await pair()
  try {
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sa.reviseConference({ session: 'a', conference: joined.id, statement: 'tier8' })
    const guestKey = sb.conferenceList('b').find(c => c.id === joined.id)!.key
    assert.equal(await sa.leaveConference('a', joined.id, { outcomes: [{ participant: guestKey, outcome: 'misleading' }] }), true)
    const stored = sa.core().storedPeerMemory()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].participant, guestKey)
    assert.equal(stored[0].peer, infoB.peerId)
    assert.equal(stored[0].statement, 'tier8')
    assert.equal(stored[0].outcome, 'misleading')
    void joined
  } finally { await stop() }
})

test('feedback proof rejects unknown, self and malformed batches before inference', { timeout: 60000 }, async () => {
  let embedded = 0
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { embedded++; return embedder.embed(text) } } })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    const ownKey = sb.conferenceList('b').find(c => c.id === joined.id)!.key
    const unknownKey = 'ff'.repeat(32)
    const bad = { outcomes: [{ participant: unknownKey, outcome: 'useful' as const }] }
    embedded = 0
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: 'x' } as never), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: unknownKey, outcome: 'useful' as const },
      { participant: unknownKey, outcome: 'neutral' as const }] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: 'zz', outcome: 'useful' as const }] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: unknownKey, outcome: 'great' as never }] }), /feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, { outcomes: [{ participant: ownKey, outcome: 'useful' as const }] }), /own key|feedback/);
    await assert.rejects(sb.leaveConference('b', joined.id, bad), /no proof|feedback/);
    await assert.rejects(sb.leaveConference('wrong', joined.id, bad), /feedback|session|member/);
    await assert.rejects(sb.leaveConference('b', 'f'.repeat(32), bad), /feedback|member|conference/);
    await assert.rejects(sb.leaveConference('b', joined.id,
      { outcomes: [{ participant: unknownKey, outcome: 'useful' as const }], statement: '' }), /feedback|statement/);
    assert.equal(embedded, 0)
    assert.deepEqual(sb.core().storedPeerMemory(), [])
    assert.ok(sb.conferenceList('b').some(c => c.id === joined.id))
  } finally { await sa.stop(); await sb.stop() }
})

test('departed authors prove by message events; save failure rolls everything back', { timeout: 90000 }, async () => {
  let fail = false
  let embedded = 0
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => { if (fail) throw new Error('disk full') }, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined,
    { embedder: { ...embedder, embed: async (text: string) => { embedded++; return embedder.embed(text) } } })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 300 })
    await sb.postToConference({ session: 'b', conference: joined.id, text: 'guest words' })
    await until(() => sa.core().read(0).events.some(e => e.kind === 'conference_message' && e.body === 'guest words'))
    const guestKey = sb.conferenceList('b').find(c => c.id === joined.id)!.key
    assert.equal(await sb.leaveConference('b', joined.id), true)
    await until(() => sa.core().read(0).events.some(e => e.kind === 'departure'))
    embedded = 0
    await sa.subscribeConference({ session: 'a', conference: joined.id, ttl: 300 })
    fail = true
    await assert.rejects(sa.leaveConference('a', joined.id,
      { outcomes: [{ participant: guestKey, outcome: 'useful' as const }] }), /disk full/)
    assert.equal(sa.core().storedPeerMemory().length, 0)
    assert.ok(sa.conferenceList('a').some(c => c.id === joined.id))
    assert.ok(sa.core().storedSubscriptions()[joined.id] !== undefined)
    fail = false
    assert.equal(await sa.leaveConference('a', joined.id,
      { outcomes: [{ participant: guestKey, outcome: 'useful' as const }] }), true)
    const stored = sa.core().storedPeerMemory()
    assert.equal(stored.length, 1)
    assert.equal(stored[0].participant, guestKey)
    assert.deepEqual(sa.conferenceList('a'), [])
    // Restart retains the committed private feedback.
    await sa.stop()
    await sa.start()
    assert.equal(sa.core().storedPeerMemory().length, 1)
    assert.equal(embedded, 0)
  } finally { fail = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('overlapping leaves keep only the winner and never store twice', { timeout: 60000 }, async () => {
  let releaseEmbed!: () => void
  const gate = new Promise<void>(resolve => { releaseEmbed = resolve })
  let blockEmbed = false
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { if (blockEmbed) await gate; return embedder.embed(text) } } })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    const hostKey = sa.conferenceList('a').find(c => c.id === joined.id)!.key
    blockEmbed = true
    const first = sb.leaveConference('b', joined.id,
      { outcomes: [{ participant: hostKey, outcome: 'useful' as const }], statement: 'far' })
    const settled = first.then(() => 'resolved', (error: unknown) => error)
    await sleep(200)
    assert.equal(await sb.leaveConference('b', joined.id), true)
    releaseEmbed()
    blockEmbed = false
    await assert.rejects(first, /membership|changed|left|conference/)
    assert.equal((await settled) instanceof Error, true)
    assert.equal(sb.core().storedPeerMemory().length, 0)
    assert.deepEqual(sb.conferenceList('b'), [])
  } finally { releaseEmbed(); blockEmbed = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('unsubscribe ownership, stats privacy and match ordering', { timeout: 90000 }, async () => {
  let embedded = 0
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const tc = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { embedded++; return embedder.embed(text) } } })
  const sc = new VortexService(tc, 'c', () => {}, undefined, { embedder: fakeEmbedder() })
  try {
    for (const s of [sa, sb, sc]) await s.start()
    await sa.dial((await sb.info()).addrs[0])
    await sc.dial((await sa.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    const bInterest = await sb.announceStatement({ session: 'b', statement: 'exact' })
    const cInterest = await sc.announceStatement({ session: 'c', statement: 'tier8' })
    const infoA = await sa.info()
    const infoC = await sc.info()
    await until(() => {
      const peers = sb.matchesFor(bInterest.id).map(m => m.peer)
      return peers.includes(infoA.peerId) && peers.includes(infoC.peerId)
    })
    embedded = 0
    // Unsubscribe without an owned subscription stores nothing and embeds nothing.
    assert.equal(await sb.unsubscribeConference('b', 'f'.repeat(32)), false)
    assert.equal(await sb.unsubscribeConference('b', 'f'.repeat(32),
      { outcomes: [{ participant: 'ab'.repeat(32), outcome: 'useful' as const }] }), false)
    assert.equal(embedded, 0)
    assert.deepEqual(sb.core().storedPeerMemory(), [])
    // Wrong session feedback stores nothing.
    assert.equal(await sb.unsubscribeConference('wrong', 'f'.repeat(32),
      { outcomes: [{ participant: 'ab'.repeat(32), outcome: 'useful' as const }] }), false)
    assert.deepEqual(sb.core().storedPeerMemory(), [])
    // Plant ratings directly: B useful, C misleading, expired/foreign/other-peer neutral.
    const exactHex = Array.from(encodeVector(table.exact), byte => byte.toString(16).padStart(2, '0')).join('')
    const farHex = Array.from(encodeVector(table.far), byte => byte.toString(16).padStart(2, '0')).join('')
    const now = Date.now()
    const stranger = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
    await sb.core().recordPeerOutcomes([
      { peer: infoA.peerId, participant: 'cd'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: exactHex, outcome: 'useful', recordedAt: now - 1000, expires: now + 60000 },
      { peer: infoC.peerId, participant: 'cd'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: exactHex, outcome: 'misleading', recordedAt: now - 1000, expires: now + 60000 },
      { peer: stranger, participant: 'cd'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: exactHex, outcome: 'useful', recordedAt: now - 1000, expires: now + 60000 },
      { peer: infoA.peerId, participant: 'ef'.repeat(32), namespace: profile.id, profileVersion: 1,
        statement: 's', vector: farHex, outcome: 'useful', recordedAt: now - 1000, expires: now + 60000 }
    ])
    const ordered = sb.matchesFor(bInterest.id).map(m => m.peer)
    assert.ok(ordered.includes(infoA.peerId) && ordered.includes(infoC.peerId))
    assert.ok(ordered.indexOf(infoA.peerId) < ordered.indexOf(infoC.peerId))
    assert.ok(!ordered.includes(stranger))
    // Stats expose counts only.
    const stats = sb.peerMemoryStats()
    assert.deepEqual(Object.keys(stats).sort(), ['bytes', 'count'])
    assert.equal(stats.count, 4)
    for (const view of [sb.subscriptions(), sb.conferenceList()]) {
      assert.ok(!JSON.stringify(view).includes('cd'.repeat(32)))
    }
    // Expired and other-profile records score neutral through direct lookup.
    assert.equal(sb.core().peerOutcome(infoA.peerId, table.exact, profile), 'useful')
    assert.equal(sb.core().peerOutcome(infoC.peerId, table.exact, profile), 'misleading')
  } finally { await sa.stop().catch(() => {}); await sb.stop().catch(() => {}); await sc.stop().catch(() => {}) }
})

test('review: ordinary unsubscribe observes queued subscription creation', { timeout: 30000 }, async () => {
  let blocked = false, hold = false
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { sa, sb, stop } = await pair(undefined, s => {
    if (hold && s.subscriptions && Object.keys(s.subscriptions).length) { blocked = true; return gate }
  })
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    hold = true
    const subscribing = sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await until(() => blocked)
    const removing = sb.unsubscribeConference('guest', room.id)
    hold = false; release()
    await subscribing
    assert.equal(await removing, true)
    assert.deepEqual(sb.subscriptions('guest'), [])
  } finally { hold = false; release(); await stop() }
})

test('review: feedback refuses a vector outside the actual profile', { timeout: 30000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    const embedder = (sb as unknown as { embedder: Embedder }).embedder
    embedder.embed = async () => Float32Array.from([1, 0, 0, 0])
    await assert.rejects(sb.leaveConference('guest', room.id, {
      outcomes: [{ participant: sa.conferenceList('host')[0].key, outcome: 'useful' }], statement: 'base'
    }), /subject|vector|profile/)
    assert.equal(sb.core().storedPeerMemory().length, 0)
    assert.equal(sb.conferenceList('guest').length, 1)
  } finally { await stop() }
})

test('renewal during feedback embedding keeps the renewed subscription', { timeout: 60000 }, async () => {
  let releaseEmbed!: () => void
  const gate = new Promise<void>(resolve => { releaseEmbed = resolve })
  let blockEmbed = false
  const embedder = fakeEmbedder()
  const ta = await createNodeTransport()
  const tb = await createNodeTransport()
  const sa = new VortexService(ta, 'a', () => {}, undefined, { embedder: fakeEmbedder() })
  const sb = new VortexService(tb, 'b', () => {}, undefined, { embedder: { ...embedder,
    embed: async (text: string) => { if (blockEmbed) await gate; return embedder.embed(text) } } })
  try {
    await sa.start()
    await sb.start()
    await sa.dial((await sb.info()).addrs[0])
    await sleep(2500)
    await sa.announceStatement({ session: 'a', statement: 'base' })
    await sb.announceStatement({ session: 'b', statement: 'exact' })
    const match = (await sb.core().wait(undefined, 10000)).events.find(e => e.kind === 'match')!
    const joined = await sb.joinConference({ session: 'b', ref: match.record! })
    await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 300 })
    const hostKey = sa.conferenceList('a').find(c => c.id === joined.id)!.key
    blockEmbed = true
    const leaving = sb.leaveConference('b', joined.id,
      { outcomes: [{ participant: hostKey, outcome: 'useful' as const }], statement: 'far' })
    const settled = leaving.then(() => 'resolved', (error: unknown) => error)
    await sleep(200)
    const renewed = await sb.subscribeConference({ session: 'b', conference: joined.id, ttl: 600 })
    releaseEmbed()
    blockEmbed = false
    await assert.rejects(leaving, /membership changed during feedback/)
    assert.equal((await settled) instanceof Error, true)
    assert.equal(sb.core().storedSubscriptions()[joined.id].expires, renewed.expires)
    assert.ok(sb.conferenceList('b').some(c => c.id === joined.id))
    assert.deepEqual(sb.core().storedPeerMemory(), [])
  } finally { releaseEmbed(); blockEmbed = false; await sa.stop().catch(() => {}); await sb.stop().catch(() => {}) }
})

test('review: unsubscribe feedback expires after a concurrent engine leave', { timeout: 15000 }, async () => {
  let hold = false, blocked = false
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { sa, sb, stop } = await pair(undefined, s => {
    if (hold && s.peerMemory?.length) { blocked = true; return gate }
  })
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    await sb.subscribeConference({ session: 'guest', conference: room.id, ttl: 300 })
    await until(() => !(sb as unknown as { recovery: Map<string, { active: boolean }> }).recovery.get(room.id)?.active)
    const local = sb as unknown as { peerMemoryTtl: number }
    local.peerMemoryTtl = 1
    hold = true
    const leaving = sb.unsubscribeConference('guest', room.id, {
      outcomes: [{ participant: sa.conferenceList('host')[0].key, outcome: 'useful' }]
    })
    await until(() => blocked)
    const engine = (sb as unknown as { conferences: Conferences }).conferences
    await engine.leave(room.id, 'guest')
    hold = false; release()
    await leaving
    await sb.core().flush()
    await until(() => sb.core().storedPeerMemory().length === 0, 2500)
  } finally { hold = false; release(); await stop() }
})

test('explicit feedback override stores its private source and vector', { timeout: 30000 }, async () => {
  const { sa, sb, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base' })
    const interest = await sb.announceStatement({ session: 'guest', statement: 'tier8' })
    await until(() => sb.matchesFor(interest.id).some(m => m.record === room.id))
    await sb.joinConference({ session: 'guest', ref: room.id })
    let embedded = 0
    const embedder = (sb as unknown as { embedder: Embedder }).embedder
    const embed = embedder.embed.bind(embedder)
    embedder.embed = async text => { embedded++; return embed(text) }
    assert.equal(await sb.leaveConference('guest', room.id, {
      outcomes: [{ participant: sa.conferenceList('host')[0].key, outcome: 'useful' }], statement: 'far'
    }), true)
    assert.equal(embedded, 1)
    const record = sb.core().storedPeerMemory()[0]
    assert.equal(record.statement, 'far')
    assert.equal(record.vector, subjectHex('far'))
    assert.equal(record.namespace, profile.id)
    assert.ok(!JSON.stringify(sb.core().read(0)).includes('far'))
  } finally { await stop() }
})

test('review: restored memory bounds retry a failed durable save', { timeout: 10000 }, async () => {
  const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const now = Date.now()
  const record = { peer, participant: 'aa'.repeat(32), namespace: profile.id, profileVersion: 1,
    statement: 'base', vector: subjectHex('base'), outcome: 'useful' as const,
    recordedAt: now - 1000, expires: now + 3600000 }
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0,
    peerMemory: [record, { ...record, participant: 'bb'.repeat(32), recordedAt: now }] }
  let fail = true
  const errors: string[] = []
  const s = new VortexService(await createNodeTransport(), 'bounds', () => {
    if (fail) throw new Error('disk full')
  }, restored, { embedder: fakeEmbedder(), peerMemory: { maxCount: 1 }, onError: m => errors.push(m) })
  try {
    await s.start()
    await until(() => errors.length > 0, 1000)
    assert.equal(s.core().storedPeerMemory().length, 2)
    fail = false
    await until(() => s.core().storedPeerMemory().length === 1, 3500)
  } finally { fail = false; await s.stop() }
})

test('review: peer memory expiry backs off and saves when storage recovers', { timeout: 10000 }, async () => {
  const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const now = Date.now()
  const restored: Snapshot = { rooms: {}, events: [], seen: [], cursor: 0, peerMemory: [{
    peer, participant: 'aa'.repeat(32), namespace: profile.id, profileVersion: 1,
    statement: 'base', vector: subjectHex('base'), outcome: 'useful',
    recordedAt: now - 1000, expires: now + 150 }] }
  let fail = true, saves = 0
  const errors: string[] = []
  const s = new VortexService(await createNodeTransport(), 'expiry', () => {
    saves++; if (fail) throw new Error('disk full')
  }, restored, { embedder: fakeEmbedder(), onError: m => errors.push(m) })
  try {
    await s.start()
    await until(() => errors.length > 0, 1500)
    await sleep(200)
    assert.equal(s.core().storedPeerMemory().length, 1)
    assert.equal(saves, 1)
    fail = false
    await until(() => s.core().storedPeerMemory().length === 0, 3500)
    assert.equal(saves, 2)
  } finally { fail = false; await s.stop() }
})

// Docs: VORTEX_v5.1.md §§4–5; skills/vortex/SKILL.md (one topic = one thread).
test('a direct message about an owned conference topic is routed to it; others and embed failures stay plain', { timeout: 60000 }, async () => {
  const { sa, sb, infoA, stop } = await pair()
  try {
    const room = await sa.createConference({ session: 'host', statement: 'base', capacity: 2 })
    const direct = await sb.core().invite(infoA.peerId)
    await sa.core().wait(undefined, 10000)
    await sa.core().accept(direct)
    await sb.core().wait(undefined, 10000)
    for (const body of ['exact', 'far', 'not in the embedder table']) await sb.core().send(direct, body)
    await until(() => sa.core().read(0).events.filter(event => event.kind === 'message').length === 3)
    const messages = sa.core().read(0).events.filter(event => event.kind === 'message')
    assert.deepEqual(messages.map(event => [event.body, event.room, event.routingConference, event.tier]), [
      ['exact', direct, room.id, 'exact'],
      ['far', direct, undefined, undefined],
      ['not in the embedder table', direct, undefined, undefined]
    ])
    // The sender holds no conference: nothing to route against, so its events carry no routing.
    await sa.core().send(direct, 'exact')
    await until(() => sb.core().read(0).events.some(event => event.kind === 'message'))
    assert.equal(sb.core().read(0).events.find(event => event.kind === 'message')?.routingConference, undefined)
  } finally { await stop() }
})
