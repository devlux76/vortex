// Persistent Ed25519 identity for a p2p peer. The libp2p peer id derived from
// this key IS the A7 identity of the peer. The private key is kept in a file
// with mode 0600 and is never logged, printed or returned to callers as bytes.
//
// A7 §2 note: a 0600 file readable by the agent's OS user is custody tier
// "not sufficient" for a remote principal. This is the milestone-1 stand-in
// until the signer (tier H/S/K) exists; see v6/p2p/README.md.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import type { PrivateKey } from '@libp2p/interface'

/** Load the key at `path`, or create a new Ed25519 key there (mode 0600). */
export async function loadOrCreateKey (path: string): Promise<PrivateKey> {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) {
      // Tighten rather than refuse: the key never left the owner's account.
      chmodSync(path, 0o600)
    }
    const key = privateKeyFromProtobuf(readFileSync(path))
    if (key.type !== 'Ed25519') throw new Error('p2p key file is not an Ed25519 key')
    return key
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const key = await generateKeyPair('Ed25519')
  // 'wx' fails if another process created the file meanwhile.
  writeFileSync(path, privateKeyToProtobuf(key), { mode: 0o600, flag: 'wx' })
  return key
}
