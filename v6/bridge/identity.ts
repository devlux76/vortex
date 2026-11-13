// The bridge's two halves share one key (Clouds' #8 point 4, implemented for
// #11): a libp2p Ed25519 key is also a valid A7 edge key. As SPKI DER it is
// the fixed prefix `302a300506032b6570032100` followed by the 32 raw public
// bytes, so sha256(spki) — the A7 `key_id` — binds the libp2p peer id to the
// hub principal that enrolled the same key (`principal_keys`). One key then
// signs the p2p envelopes and the hub's signed HTTP edge requests.
import type { PrivateKey } from '@libp2p/interface'
import { b64pad, b64url } from '../client/b64.ts'
import { keyIdOf } from '../client/edge-sign.ts'

// SubjectPublicKeyInfo for an Ed25519 public key (RFC 8410): the fixed
// 12-byte header names the algorithm, then the 32-byte key.
export const ED25519_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

export function ed25519Spki (rawPublic: Uint8Array): Uint8Array {
  if (rawPublic.length !== 32) throw new Error(`an Ed25519 public key is 32 bytes, got ${rawPublic.length}`)
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32)
  spki.set(ED25519_SPKI_PREFIX)
  spki.set(rawPublic, ED25519_SPKI_PREFIX.length)
  return spki
}

/** The A7 `key_id` (sha256 of the SPKI) of a libp2p Ed25519 key. */
export async function libp2pKeyId (key: PrivateKey): Promise<string> {
  return keyIdOf(ed25519Spki(key.publicKey.raw))
}

export interface EdgeKeyMaterial {
  alg: 'ed25519'
  jwk: JsonWebKey
  spkiB64: string
  keyId: string
}

/**
 * The same key as JWK edge-key material, so an `EdgeClient` can be built from
 * it (`vx edge keygen` writes the same shape). The private JWK must stay in
 * the A7 `unsealed` tier's key file; the hub holds only the public SPKI.
 */
export async function edgeKeyFromLibp2p (key: PrivateKey): Promise<EdgeKeyMaterial> {
  const spki = ed25519Spki(key.publicKey.raw)
  
  // libp2p's `raw` is the 64-byte expanded private key (seed || public); the
  // JWK `d` member is the 32-byte seed.
  const seed = key.raw.length === 64 ? key.raw.subarray(0, 32) : key.raw
  return {
    alg: 'ed25519',
    jwk: { kty: 'OKP', crv: 'Ed25519', x: b64url.encode(key.publicKey.raw), d: b64url.encode(seed) },
    spkiB64: b64pad.encode(spki),
    keyId: await keyIdOf(spki)
  }
}
