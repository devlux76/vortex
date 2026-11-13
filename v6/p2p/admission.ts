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
  /** Why a peer would be refused ('' when it would not). With a room, the room-scoped verdict. */
  reason: (peerId: string, room?: string) => Promise<string>
  /** Room-scoped admission (#38, Sun's QA): the key must cover the room. A rendezvous namespace is treated as a room; sealed keys are unrestricted. */
  admitRoom: (peerId: string, room: string) => Promise<boolean>
  /** Closes the read-only database handle (relay shutdown, startup failure). */
  close: () => void
}

export function hubAdmission (dbPath: string): Admission {
  let db: Database | undefined = new Database(dbPath, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000;')
  // One prepared statement, finalized on close: an unfinalized statement keeps the
  // database file descriptor open after db.close() (F6, Invictus QA on #3).
  // Prepared on first use: the hub may create principal_keys after the relay starts.
  let lookup: ReturnType<Database['prepare']> | undefined
  const verdict = async (peerId: string, room?: string): Promise<string> => {
    if (db === undefined) return 'admission is shut down'
    const stmt = lookup ?? (lookup = db.prepare('SELECT revoked, expires, rooms FROM principal_keys WHERE key_id = ?'))
    let keyId: string
    try {
      keyId = await keyIdOf(spkiFromPeerId(peerId))
    } catch {
      return 'the peer id carries no Ed25519 key'
    }
    const row = stmt.get(keyId) as { revoked: number | null, expires: number | null, rooms: string | null } | undefined
    if (row === undefined || row === null) return 'peer not enrolled'
    if (row.revoked !== null) return 'peer key revoked'
    if (row.expires !== null && Date.now() >= row.expires) return 'peer key expired'
    if (room !== undefined) {
      // An unsealed key is capped to its named rooms (A7 §3a); a rendezvous
      // namespace counts as a room for admission, so a peer enrolled for one
      // room cannot appear in another namespace's discovery. Sealed keys are
      // unrestricted here; their room binding is the binding's own.
      // F5 (Invictus QA on #3): a malformed rooms column is a refusal, never a throw.
      let rooms: string[] | null = null
      if (row.rooms !== null) {
        try {
          const parsed: unknown = JSON.parse(row.rooms)
          if (!Array.isArray(parsed)) return 'peer rooms unreadable'
          rooms = parsed as string[]
        } catch {
          return 'peer rooms unreadable'
        }
      }
      if (rooms !== null && !rooms.includes(room)) return 'peer enrolled for other rooms'
    }
    return ''
  }
  return {
    admit: async (peerId: string) => (await verdict(peerId)) === '',
    reason: async (peerId: string, room?: string) => await verdict(peerId, room),
    admitRoom: async (peerId: string, room: string) => (await verdict(peerId, room)) === '',
    close: () => { lookup?.finalize(); lookup = undefined; db?.close(); db = undefined }
  }
}
