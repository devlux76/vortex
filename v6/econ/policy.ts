// A8 §8 policy as pure functions over a Ledger and an injected config.
//
// A global cap on outstanding issued debt (so fresh identities can't each get
// an allowance), an optional per-counterparty cap, max_owed_by_peer, and no
// prospective IOUs outside the fleet: an IOU to a non-fleet holder needs that
// holder's receipt for this agent's quote first (issuing after the receipt is
// the acceptance, A8 §6.2 item 5). The face value is the one agreed in the
// quote; the worker's claimed spend is never checked against it.
import type { Decline, EconInput, Iou, Quote, Redeem } from './iou.ts'
import { statusOf, type IngestOptions, type Ledger } from './ledger.ts'

export interface EconPolicy {
  /** Members of this operator's fleet (agent / peer ids). Everyone else is outside it. */
  fleet: ReadonlySet<string>
  /** Global cap on outstanding debt this agent has issued, across all holders. */
  maxIssuedTokens: number
  /** Optional per-counterparty cap on what this agent owes one holder. */
  maxIssuedPerPeer?: number
  /** Cap on what one peer may owe this agent before further work is declined. */
  maxOwedByPeer: number
}

export type PolicyResult = { ok: true } | { ok: false; reason: string; remaining?: number }

const no = (reason: string, remaining?: number): PolicyResult =>
  remaining === undefined ? { ok: false, reason } : { ok: false, reason, remaining }

/**
 * May this agent sign an IOU of `face_tokens` to `holder` for `quote`?
 * Checks the global and per-counterparty caps; for a holder outside the fleet,
 * the work must already be delivered (the holder's receipt for the quote is in
 * the ledger). When a quote is named, the face may not exceed the face agreed in it.
 */
export function checkIssue (l: Ledger, p: EconPolicy, iou: Pick<Iou, 'holder' | 'face_tokens' | 'quote'>, now: number): PolicyResult {
  if (iou.holder === l.self) return no('cannot issue an iou to oneself')
  const q = iou.quote === '' ? undefined : l.quote(l.self, iou.quote)
  if (iou.quote !== '' && q === undefined) return no('no quote from this agent with that id')
  if (q !== undefined) {
    if (q.to !== iou.holder) return no('quote is not addressed to the holder')
    if (iou.face_tokens > q.offer_face_tokens) return no(`face ${iou.face_tokens} exceeds the ${q.offer_face_tokens} agreed in the quote`)
  }
  if (!p.fleet.has(iou.holder)) {
    if (q === undefined) return no('outside the fleet an iou needs a quote this agent made')
    if (l.receipt(q) === undefined) return no('outside the fleet an iou is issued only after the work is delivered (no receipt yet)')
  }
  const total = l.liabilities(now) + iou.face_tokens
  if (total > p.maxIssuedTokens) return no(`would owe ${total} in total, over max_issued_tokens ${p.maxIssuedTokens}`)
  if (p.maxIssuedPerPeer !== undefined) {
    const peer = l.owedTo(iou.holder, now) + iou.face_tokens
    if (peer > p.maxIssuedPerPeer) return no(`would owe ${peer} to this holder, over the per-counterparty cap ${p.maxIssuedPerPeer}`)
  }
  return { ok: true }
}

/**
 * Should this agent (the worker) take `quote`? Declines when the requester's
 * debt to this agent plus the offered face would pass max_owed_by_peer.
 */
export function checkQuote (l: Ledger, p: EconPolicy, quote: Pick<Quote, 'from' | 'offer_face_tokens'>, now: number): PolicyResult {
  const owed = l.owedBy(quote.from, now) + quote.offer_face_tokens
  if (owed > p.maxOwedByPeer) return no(`peer would owe ${owed}, over max_owed_by_peer ${p.maxOwedByPeer}`)
  return { ok: true }
}

/**
 * Can this agent (the issuer) take `redeem`? When it can't over the balance,
 * the result carries `remaining` (0 once retired) for the decline.
 */
export function checkRedeem (l: Ledger, redeem: Pick<Redeem, 'iou' | 'from' | 'est_tokens'>, now: number, opts: IngestOptions = {}): PolicyResult {
  const e = l.resolveHeld(redeem.iou, redeem.from, opts)
  if (e === undefined) return no('no iou with this id held by the signer')
  const s = statusOf(e, now)
  if (s !== 'live') return no(`iou is retired (${s})`, 0)
  const remaining = e.iou.face_tokens - e.credited
  if (redeem.est_tokens > remaining) return no(`redeem asks for ${redeem.est_tokens} tokens but only ${remaining} remain on this iou`, remaining)
  return { ok: true }
}

/**
 * The decline (A8 §6.2: ref, reason, remaining?) for `redeem`, or undefined
 * when it can be taken. Sign the result with iou.ts `sign`.
 */
export function declineRedeem (l: Ledger, redeem: Pick<Redeem, 'id' | 'iou' | 'from' | 'est_tokens'>, now: number, opts: IngestOptions = {}): EconInput<Decline> | undefined {
  const c = checkRedeem(l, redeem, now, opts)
  if (c.ok) return undefined
  const d: EconInput<Decline> = { kind: 'decline', from: l.self, ref: redeem.id, reason: c.reason }
  if (c.remaining !== undefined) d.remaining = c.remaining
  return d
}
