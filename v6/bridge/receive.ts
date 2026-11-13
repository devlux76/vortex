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
      // A6 outbound screen in the bridge before relaying (hub wording): a
      // refusal acks ok:false to the sender, like the hub's own 422.
      screenOutbound(msg.text)
    } catch (e) {
      stats.skipped++
      throw e
    }
    // The hub's answer is the ACK boundary (Sun's QA on #37): a refusal is
    // thrown so the p2p layer acks ok:false and the sender can retry — the
    // hub claimed nothing on refusal (claim-on-accept), so the retry is
    // possible. The refusal is counted here first.
    let res: any
    try {
      res = await bridge.edge.request('POST', `/v1/rooms/${encodeURIComponent(room)}/relay`, { envelope: msg })
    } catch (e) {
      stats.refused++
      throw e
    }
    if (res?.ok === true) { stats.relayed++; return }
    stats.refused++
    throw new Error(`relay refused: ${JSON.stringify(res)}`)
  }
}
