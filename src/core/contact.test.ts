import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeContact, openContact } from './contact.ts'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'

const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
const addr = (port: number, id: string = peer): string => `/ip4/127.0.0.1/tcp/${port}/p2p/${id}`

// Docs: VORTEX_v5.1.md section 4.2
test('a contact round-trips through bytes unchanged', () => {
  const addrs = [addr(7810), addr(7811)]
  assert.deepEqual(openContact(encodeContact(addrs), peer), addrs)
})

// Docs: VORTEX_v5.1.md section 4.2
test('zero or nine addresses give undefined', () => {
  assert.equal(openContact(encodeContact([]), peer), undefined)
  assert.equal(openContact(encodeContact([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => addr(n))), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an over-long address gives undefined', () => {
  assert.equal(openContact(encodeContact([`/ip4/127.0.0.1/tcp/1/p2p/${peer}` + 'x'.repeat(512)]), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an address naming another peer gives undefined', () => {
  assert.equal(openContact(encodeContact([addr(7810, '12D3KooWSomeOtherPeer00000000000000000000000002')]), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('undecodable bytes give undefined', () => {
  assert.equal(openContact(Uint8Array.from([255, 255, 255]), peer), undefined)
  assert.equal(openContact(new Uint8Array(0), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an address with a junk prefix gives undefined', () => {
  assert.equal(openContact(encodeContact(['junk/p2p/' + peer]), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an invalid IPv4 address gives undefined', () => {
  assert.equal(openContact(encodeContact(['/ip4/999.1.1.1/tcp/1/p2p/' + peer]), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an unknown protocol gives undefined', () => {
  assert.equal(openContact(encodeContact(['/foo/1/p2p/' + peer]), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an invalid base58 peer id gives undefined, even as the expected peer', () => {
  const bad = '12D3KooW0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'
  assert.equal(openContact(encodeContact(['/ip4/127.0.0.1/tcp/1/p2p/' + bad]), bad), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('a unix path that only mentions p2p gives undefined', () => {
  assert.equal(openContact(encodeContact(['/unix/tmp%2Fp2p%2F' + peer]), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('one bad address rejects the whole list', () => {
  assert.equal(openContact(encodeContact([addr(7810), 'junk']), peer), undefined)
})

// Docs: VORTEX_v5.1.md section 4.2
test('exactly eight addresses are accepted', () => {
  const addrs = [1, 2, 3, 4, 5, 6, 7, 8].map(n => addr(7800 + n))
  assert.deepEqual(openContact(encodeContact(addrs), peer), addrs)
})

// Docs: VORTEX_v5.1.md section 4.2
test('an IPv6 address is accepted', () => {
  const addrs = ['/ip6/::1/tcp/7810/p2p/' + peer]
  assert.deepEqual(openContact(encodeContact(addrs), peer), addrs)
})

// Docs: VORTEX_v5.1.md section 4.2
test('a relayed address belongs to the peer after the relay, not to the relay', async () => {
  const relay = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString()
  const relayed = addr(7810, relay) + '/p2p-circuit/p2p/' + peer
  assert.deepEqual(openContact(encodeContact([relayed]), peer), [relayed])
  assert.equal(openContact(encodeContact([relayed]), relay), undefined)
})
