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
import { profile, table, fakeEmbedder, sleep, subjectHex, pair, LEGACY_TOPIC, until, singleService } from './service.testkit.ts'


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
