// Mesh→hub ingest (#20). The bridge receives verified room envelopes over
// /vortex/msg (the p2p receiver has already checked the Noise peer, the
// addressee, the signature and the persisted (from, id) dedup) and relays
// each to the hub's `POST /v1/rooms/:room/relay`, which verifies the origin
// signature against the key embedded in `from`, maps the peer id to a
// principal through principal_keys, dedups, applies A6 and the room scopes,
// and stores the message from the origin principal.
//
// A6 in the bridge direction: the text is screened before relaying, with the
// hub's refusal wording; a refused envelope is not relayed and is counted.
import { screenOutbound, type P2PMessage } from '../p2p/message.ts'
import type { Bridge } from './process.ts'

export interface IngestStats { relayed: number, skipped: number, refused: number }

/** The onEnvelope handler that relays verified room envelopes to the hub. */
export function meshIngest (bridge: Bridge, stats: IngestStats = { relayed: 0, skipped: 0, refused: 0 }): (msg: P2PMessage) => Promise<void> {
  return async (msg: P2PMessage) => {
    if (msg.scope !== 'room' || typeof msg.room !== 'string') return
    const room = msg.room
    try {
      // A6 outbound screen in the bridge before relaying (hub wording).
      screenOutbound(msg.text)
    } catch {
      stats.skipped++
      return
    }
    try {
      const res = await bridge.edge.request('POST', `/v1/rooms/${encodeURIComponent(room)}/relay`, { envelope: msg })
      if (res?.ok === true) stats.relayed++
      else stats.refused++
    } catch (e) {
      // A refused relay (A6 422, scope 403, unverified 401) is not retried:
      // the hub's answer is authoritative and the p2p dedup already consumed
      // the envelope id. Count it.
      if ((e as { status?: unknown }).status !== undefined) stats.refused++
      else throw e
    }
  }
}
