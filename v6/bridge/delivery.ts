// Hub→mesh room delivery (#11). The bridge polls its enrolled room's log
// (A7 §3a signed HTTPS, non-consuming), and forwards each message to the
// room's mesh members — the peers registered under the room's rendezvous
// namespace — as signed p2p envelopes with scope:"room" (#8's v1 extension).
//
// - A6 both directions: the text is screened before anything is signed, with
//   the hub's refusal wording; a refused message is not forwarded.
// - Dedup on (from, id): the envelope id is derived deterministically from
//   the hub message id, so a crash between send and cursor-write, or a
//   replayed batch, re-sends the identical frame — the receiver's persisted
//   dedup (v6/p2p/dedup.ts) refuses it as `duplicate message`, which counts
//   as already delivered.
// - The cursor is persisted, so a bridge restart does not re-read the room
//   from the beginning. A message still undelivered for some member is
//   retried on later polls (bounded attempts, then dropped and counted).
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { toString } from 'uint8arrays'
import { screenOutbound, signEnvelope } from '../p2p/message.ts'
import type { Bridge } from './process.ts'

const MAX_POLL_BATCH = 100
const MAX_ATTEMPTS = 5

export interface HubLogEntry { id: string, seq: number, text: string, from?: string }

export interface DeliveryStats { forwarded: number, duplicates: number, skipped: number, dropped: number }

export interface Delivery {
  room: string
  stats: DeliveryStats
  stop: () => void
  stopped: () => boolean
}

/** Deterministic envelope id for a hub message (see module comment). */
export async function forwardIdOf (hubMessageId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vortex-bridge-forward\0' + hubMessageId))
  return toString(new Uint8Array(digest), 'base64url')
}

/**
 * Send one hub message to each target; returns the targets that did not
 * acknowledge delivery. `duplicate message` counts as delivered: it is the
 * receiver's persisted dedup recognizing the deterministic envelope id.
 * `to` is a signed field, so the envelope is signed per recipient.
 */
async function deliver (bridge: Bridge, room: string, m: HubLogEntry, targets: string[], stats: DeliveryStats): Promise<string[]> {
  screenOutbound(m.text) // A6 outbound screen before anything is signed
  const id = await forwardIdOf(m.id)
  const from = bridge.peer.id.toString()
  const failed: string[] = []
  for (const t of targets) {
    if (t === from) continue
    try {
      const frame = await signEnvelope(bridge.privateKey, {
        v: 1, id, from, to: t, scope: 'room', room, text: m.text, ts: Date.now()
      })
      const { ack } = await bridge.peer.sendRaw(t, frame)
      if (ack.ok) stats.forwarded++
      else if (ack.error === 'duplicate message') stats.duplicates++
      else failed.push(t)
    } catch { failed.push(t) }
  }
  return failed
}

export interface ForwardResult {
  /** Seq through which everything is delivered, A6-refused, or handed to pending. */
  through: number
  /** Messages that still need delivery to some member; the caller retries them. */
  pending: Array<{ msg: HubLogEntry, targets: string[] }>
}

/** Forward a batch of hub log entries to the room's mesh members. */
export async function forwardMessages (bridge: Bridge, room: string, messages: HubLogEntry[], targets: string[], stats: DeliveryStats): Promise<ForwardResult> {
  const result: ForwardResult = { through: 0, pending: [] }
  for (const m of messages) {
    // The bridge's own lines (its presence announcement) are not forwarded.
    if (m.from === bridge.edge.opts.principal) {
      result.through = m.seq
      continue
    }
    let failed: string[]
    try {
      failed = await deliver(bridge, room, m, targets, stats)
    } catch (e) {
      if ((e as Error).message.startsWith('refused: text contains a credential')) {
        stats.skipped++
        result.through = m.seq
        continue
      }
      throw e
    }
    if (failed.length === 0) result.through = m.seq
    else result.pending.push({ msg: m, targets: failed })
  }
  return result
}

interface Cursor { room: string, after: number }

interface Pending { msg: HubLogEntry, attempts: number, targets: string[] }

function loadCursor (file: string, room: string): number {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Cursor
    return s.room === room ? s.after : 0
  } catch { return 0 }
}

function pendingFile (stateFile: string, room: string): string {
  return `${stateFile}.${room}.pending.json`
}

function readPending (stateFile: string, room: string): Pending[] {
  try { return JSON.parse(readFileSync(pendingFile(stateFile, room), 'utf8')) as Pending[] } catch { return [] }
}

function writePending (stateFile: string, room: string, list: Pending[]): void {
  if (list.length === 0) rmSync(pendingFile(stateFile, room), { force: true })
  else writeFileSync(pendingFile(stateFile, room), JSON.stringify(list), { mode: 0o600 })
}

/** Publish the bridge under the room namespace and start the poll loop. */
export async function startRoomDelivery (bridge: Bridge, room: string, opts: { intervalMs?: number, stateFile?: string } = {}): Promise<Delivery> {
  const stateFile = opts.stateFile ?? `${bridge.keyFile}.delivery.json`
  const intervalMs = opts.intervalMs ?? 2000
  await bridge.peer.register(room)
  const stats: DeliveryStats = { forwarded: 0, duplicates: 0, skipped: 0, dropped: 0 }
  let pending = readPending(stateFile, room)
  let after = loadCursor(stateFile, room)
  const saveCursor = (n: number): void => {
    if (n > after) { after = n; writeFileSync(stateFile, JSON.stringify({ room, after }) + '\n', { mode: 0o600 }) }
  }
  let running = true
  let presencePosted = false
  const loop = (async () => {
    while (running) {
      try {
        const members = (await bridge.peer.discover(room)).map(p => p.id.toString())
        // Retries first: messages still undelivered for some member.
        const keep: Pending[] = []
        for (const p of pending) {
          p.attempts++
          let failed: string[]
          try { failed = await deliver(bridge, room, p.msg, p.targets, stats) } catch { failed = p.targets }
          if (failed.length === 0) saveCursor(p.msg.seq)
          else if (p.attempts < MAX_ATTEMPTS) keep.push({ ...p, targets: failed })
          else stats.dropped++
        }
        pending = keep
        writePending(stateFile, room, pending)
        // Room log reads need membership (§8.2), which enrollment does not
        // grant; posting does. The bridge announces itself once.
        let entries: HubLogEntry[]
        try {
          entries = (await bridge.edge.roomLog(room, after, MAX_POLL_BATCH)) as HubLogEntry[]
        } catch (e) {
          if (!presencePosted && /404/.test((e as Error).message)) {
            presencePosted = true
            await bridge.edge.send({ room, text: '[vortex bridge] present' }).catch(() => {})
            continue
          }
          throw e
        }
        if (entries.length > 0) {
          const r = await forwardMessages(bridge, room, entries, members, stats)
          saveCursor(r.through)
          pending = [...pending, ...r.pending.map(p => ({ ...p, attempts: 1 }))]
          writePending(stateFile, room, pending)
        }
      } catch { /* hub or relay hiccup: keep polling */ }
      await Bun.sleep(intervalMs)
    }
  })()
  void loop
  return {
    room,
    stats,
    stop: () => { running = false },
    stopped: () => !running
  }
}
