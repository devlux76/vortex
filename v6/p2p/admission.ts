// Relay and rendezvous admission through the hub's principal_keys (#24,
// Clouds' #8 point 4). The relay process opens the hub's SQLite database
// READ-ONLY and admits a peer only when the Ed25519 key embedded in its peer
// id is enrolled, not revoked and not expired. The mapping is the identity
// binding from #11/#20: an Ed25519 peer id is a base58btc identity multihash
// whose payload is the raw key, sha256(spki(key)) is the A7 `key_id`, so one
// enrollment (`vx enroll <name> --key <spki>`, #7) covers the hub edge, the
// relay and rendezvous, and `vx key revoke` is one revocation path.
//
// Queries run per admission with no cache, so a revocation takes effect on
// the peer's next request (A7 §4).
//
// This module imports bun:sqlite and must stay server-side only: the relay
// injects `admit` into the rendezvous server, so the browser peer (Moon)
// never pulls this module into its bundle.
import { Database } from 'bun:sqlite'
import { spkiFromPeerId } from '../client/relay-envelope.ts'
import { keyIdOf } from '../client/edge-sign.ts'

export interface Admission {
  admit: (peerId: string) => Promise<boolean>
  /** Why a peer would be refused ('' when it would not). */
  reason: (peerId: string) => Promise<string>
}

export function hubAdmission (dbPath: string): Admission {
  const db = new Database(dbPath, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000;')
  const verdict = async (peerId: string): Promise<string> => {
    let keyId: string
    try {
      keyId = await keyIdOf(spkiFromPeerId(peerId))
    } catch {
      return 'the peer id carries no Ed25519 key'
    }
    const row = db.prepare('SELECT revoked, expires FROM principal_keys WHERE key_id = ?').get(keyId) as { revoked: number | null, expires: number | null } | undefined
    if (row === undefined || row === null) return 'peer not enrolled'
    if (row.revoked !== null) return 'peer key revoked'
    if (row.expires !== null && Date.now() >= row.expires) return 'peer key expired'
    return ''
  }
  return {
    admit: async (peerId: string) => (await verdict(peerId)) === '',
    reason: verdict
  }
}
