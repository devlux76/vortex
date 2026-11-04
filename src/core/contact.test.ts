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
