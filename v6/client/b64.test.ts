// v6/client/b64.ts: one base64 implementation for the hub (no node_modules in
// its chain), the p2p layer (browser: Moon), and the bridge. The round trips
// are checked against Buffer's output, and the envelope verifier is proven to
// work with globalThis.Buffer deleted (a browser regression fails loudly).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { b64pad, b64url } from './b64.ts'

test('b64: round trips match Buffer byte-for-byte at every length', () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = new Uint8Array(randomBytes(n))
    assert.equal(b64pad.encode(bytes), Buffer.from(bytes).toString('base64'), `b64pad length ${n}`)
    assert.equal(b64url.encode(bytes), Buffer.from(bytes).toString('base64url'), `b64url length ${n}`)
    assert.deepEqual(b64pad.decode(b64pad.encode(bytes)), bytes, `b64pad round trip ${n}`)
    assert.deepEqual(b64url.decode(b64url.encode(bytes)), bytes, `b64url round trip ${n}`)
  }
})

test('b64: decoders accept both alphabets, padded or not', () => {
  const bytes = new Uint8Array(randomBytes(64))
  const std = Buffer.from(bytes).toString('base64')
  const url = Buffer.from(bytes).toString('base64url')
  assert.deepEqual(b64pad.decode(url), bytes)
  assert.deepEqual(b64url.decode(std), bytes)
  // No padding tolerated on either.
  assert.deepEqual(b64pad.decode(std.replace(/=+$/, '')), bytes)
})

test('b64: the envelope verifier works with globalThis.Buffer deleted (browser regression)', async () => {
  // Isolated subprocess: deleting Buffer in-process would break the runner.
  const v6root = new URL('../', import.meta.url).pathname
  const script = `
    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
    const { signEnvelope } = await import(${JSON.stringify(v6root + 'p2p/message.ts')})
    const { verifyRelayEnvelope, spkiFromPeerId } = await import(${JSON.stringify(v6root + 'client/relay-envelope.ts')})
    const { b64url } = await import(${JSON.stringify(v6root + 'client/b64.ts')})
    // Imports done; now the browser condition: no Buffer at all.
    delete globalThis.Buffer
    if (typeof globalThis.Buffer !== 'undefined') throw new Error('Buffer still present')
    const k = await generateKeyPair('Ed25519')
    const p1 = peerIdFromPrivateKey(k)
    const m = await signEnvelope(k, { v: 1, id: 'abcdefghijkmnopqrstuvw', from: p1.toString(), to: p1.toString(), scope: 'dm', text: 'no Buffer here', ts: Date.now() })
    const v = await verifyRelayEnvelope(m)
    if (v.text !== 'no Buffer here') throw new Error('verify failed without Buffer')
    // The peer id → SPKI derivation also works without Buffer, and round trips.
    const spki = spkiFromPeerId(p1.toString())
    if (spki.length !== 44) throw new Error('bad spki')
    const probe = new Uint8Array([1, 2, 3, 250])
    if (b64url.encode(probe) !== 'AQID-g') throw new Error('b64url mismatch without Buffer')
    console.log('verified without Buffer')
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { cwd: v6root, stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(code, 0, `subprocess failed: ${err.slice(0, 500)}`)
  assert.match(out, /verified without Buffer/)
})
