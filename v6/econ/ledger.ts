// A8 ledger as a pure module (docs/v6-amendment-a8-iou.md §6.2, §8, §12 item 2a).
//
// In memory and serialisable; no I/O, no hub wiring, no clock (callers pass
// `now`, Unix seconds). It ingests messages that iou.ts `verify` has already
// accepted, so `from` is the authenticated signer. The ledger then checks
// that the signer has the role the kind needs: an `iou` must come from its
// issuer and name someone else as holder; `redeem`, `redeemed` and `release`
// must come from the IOU's holder.
//
// Balance of an IOU = face_tokens - sum of credited_tokens over the holder's
// signed `redeemed` messages. An IOU retires at zero, at expiry (expires_at > 0
// and now >= expires_at) or on `release`. Messages are deduplicated on
// (from, id) (A8 §6.1): a replay is ignored, never applied twice.
//
// Policy (A8 §8 as amended) is a set of pure functions over a ledger and an
// injected config: a global cap on outstanding issued debt (so fresh
// identities can't each get an allowance), an optional per-counterparty
// cap, max_owed_by_peer, and no prospective IOUs outside the fleet: an IOU to
// a non-fleet holder needs that holder's receipt for the quote first. The face
// value is the one agreed in the quote; the worker's claimed spend is never
// checked against it.
import type { EconMessage, Iou, Quote, Receipt, Redeem, Redeemed, Release } from './iou.ts'

export type IouStatus = 'live' | 'paid' | 'expired' | 'released'

export interface IouEntry {
  iou: Iou
  credited: number
  /** The holder's signed proofs of payment, kept for the issuer (A8 §6.2 item 7). */
  redeemed: Redeemed[]
  released?: Release
}

export class LedgerError extends Error {
  readonly remaining?: number
  constructor (message: string, remaining?: number) {
    super(message)
    this.remaining = remaining
  }
}

export interface IngestResult { applied: boolean; duplicate: boolean }

export interface LedgerState {
  self: string
  seen: string[]
  ious: IouEntry[]
  quotes: Quote[]
  receipts: Receipt[]
  redeems: Redeem[]
}

export interface PeerView { peer: string; owesMe: number; iOwe: number }

const seenKey = (from: string, id: string): string => `${from}\n${id}`

export class Ledger {
  private readonly seen = new Set<string>()
  private readonly ious = new Map<string, IouEntry>()
  private readonly quotes = new Map<string, Quote>()
  private readonly receipts = new Map<string, Receipt>()
  private readonly redeems = new Map<string, Redeem>()
  /** redeem ids that already have a `redeemed`, so one redemption is credited once. */
  private readonly settled = new Set<string>()

  readonly self: string
  constructor (self: string) { this.self = self }

  /** Apply one verified message. Throws LedgerError when it can't be applied. */
  ingest (m: EconMessage, now: number): IngestResult {
    const key = seenKey(m.from, m.id)
    if (this.seen.has(key)) return { applied: false, duplicate: true }
    switch (m.kind) {
      case 'quote': this.onQuote(m); break
      case 'receipt': this.onReceipt(m); break
      case 'iou': this.onIou(m); break
      case 'redeem': this.onRedeem(m, now); break
      case 'redeemed': this.onRedeemed(m, now); break
      case 'release': this.onRelease(m, now); break
      default: break // beacon, accept, decline: nothing to account; still deduplicated
    }
    this.seen.add(key)
    return { applied: true, duplicate: false }
  }

  private onQuote (m: Quote): void {
    if (m.from !== this.self && m.to !== this.self) throw new LedgerError('quote does not involve this agent')
    if (m.from === m.to) throw new LedgerError('quote addressed to its sender')
    this.quotes.set(m.id, m)
  }

  private onReceipt (m: Receipt): void {
    const q = this.quotes.get(m.quote)
    if (q === undefined) throw new LedgerError('receipt for an unknown quote')
    if (m.from !== q.to) throw new LedgerError('receipt not signed by the quoted worker')
    this.receipts.set(m.quote, m)
  }

  private onIou (m: Iou): void {
    if (m.holder === m.from) throw new LedgerError('iou issued to its own issuer')
    if (m.from !== this.self && m.holder !== this.self) throw new LedgerError('iou does not involve this agent')
    if (this.ious.has(m.id)) throw new LedgerError('iou id already in use')
    this.ious.set(m.id, { iou: m, credited: 0, redeemed: [] })
  }

  private live (iouId: string, signer: string, now: number): IouEntry {
    const e = this.ious.get(iouId)
    if (e === undefined) throw new LedgerError('unknown iou')
    if (signer !== e.iou.holder) throw new LedgerError('not signed by the iou holder')
    const s = statusOf(e, now)
    if (s !== 'live') throw new LedgerError(`iou is retired (${s})`, 0)
    return e
  }

  private onRedeem (m: Redeem, now: number): void {
    const e = this.live(m.iou, m.from, now)
    const remaining = e.iou.face_tokens - e.credited
    if (m.est_tokens > remaining) {
      throw new LedgerError(`redeem asks for ${m.est_tokens} tokens but only ${remaining} remain on this iou`, remaining)
    }
    this.redeems.set(m.id, m)
  }

  private onRedeemed (m: Redeemed, now: number): void {
    const e = this.live(m.iou, m.from, now)
    const r = this.redeems.get(m.redeem)
    if (r === undefined || r.iou !== m.iou) throw new LedgerError('redeemed names no redeem on this iou')
    if (this.settled.has(m.redeem)) throw new LedgerError('redeem already credited')
    const remaining = e.iou.face_tokens - e.credited
    if (m.credited_tokens > remaining) {
      throw new LedgerError(`credit of ${m.credited_tokens} exceeds the ${remaining} remaining`, remaining)
    }
    e.credited += m.credited_tokens
    e.redeemed.push(m)
    this.settled.add(m.redeem)
  }

  private onRelease (m: Release, now: number): void {
    this.live(m.iou, m.from, now).released = m
  }

  // ---- views ----

  entry (iouId: string): IouEntry | undefined { return this.ious.get(iouId) }
  quote (id: string): Quote | undefined { return this.quotes.get(id) }
  receipt (quoteId: string): Receipt | undefined { return this.receipts.get(quoteId) }

  status (iouId: string, now: number): IouStatus | undefined {
    const e = this.ious.get(iouId)
    return e === undefined ? undefined : statusOf(e, now)
  }

  /** Remaining balance; 0 once retired. */
  balance (iouId: string, now: number): number {
    const e = this.ious.get(iouId)
    if (e === undefined || statusOf(e, now) !== 'live') return 0
    return e.iou.face_tokens - e.credited
  }

  /** Live IOUs, optionally filtered by issuer and holder. */
  liveIous (now: number, issuer?: string, holder?: string): IouEntry[] {
    return [...this.ious.values()].filter(e => statusOf(e, now) === 'live' &&
      (issuer === undefined || e.iou.from === issuer) && (holder === undefined || e.iou.holder === holder))
  }

  private sum (now: number, issuer?: string, holder?: string): number {
    return this.liveIous(now, issuer, holder).reduce((t, e) => t + e.iou.face_tokens - e.credited, 0)
  }

  /** What `peer` owes this agent (assets on that peer). */
  owedBy (peer: string, now: number): number { return this.sum(now, peer, this.self) }
  /** What this agent owes `peer` (liabilities to that peer). */
  owedTo (peer: string, now: number): number { return this.sum(now, this.self, peer) }
  /** Total outstanding debt this agent has issued. */
  liabilities (now: number): number { return this.sum(now, this.self) }
  /** Total outstanding debt held by this agent. */
  assets (now: number): number { return this.sum(now, undefined, this.self) }

  /** Per-peer view, liabilities beside assets (A8 §8). */
  peers (now: number): PeerView[] {
    const out = new Map<string, PeerView>()
    for (const e of this.liveIous(now)) {
      const left = e.iou.face_tokens - e.credited
      const mine = e.iou.from === this.self
      const peer = mine ? e.iou.holder : e.iou.from
      const v = out.get(peer) ?? { peer, owesMe: 0, iOwe: 0 }
      if (mine) v.iOwe += left
      else v.owesMe += left
      out.set(peer, v)
    }
    return [...out.values()].sort((a, b) => a.peer.localeCompare(b.peer))
  }

  // ---- serialisation ----

  toJSON (): LedgerState {
    return {
      self: this.self,
      seen: [...this.seen],
      ious: [...this.ious.values()],
      quotes: [...this.quotes.values()],
      receipts: [...this.receipts.values()],
      redeems: [...this.redeems.values()],
    }
  }

  static fromJSON (s: LedgerState): Ledger {
    const l = new Ledger(s.self)
    for (const k of s.seen) l.seen.add(k)
    for (const q of s.quotes) l.quotes.set(q.id, q)
    for (const r of s.receipts) l.receipts.set(r.quote, r)
    for (const r of s.redeems) l.redeems.set(r.id, r)
    for (const e of s.ious) {
      l.ious.set(e.iou.id, { ...e, redeemed: [...e.redeemed] })
      for (const d of e.redeemed) l.settled.add(d.redeem)
    }
    return l
  }
}

function statusOf (e: IouEntry, now: number): IouStatus {
  if (e.released !== undefined) return 'released'
  if (e.credited >= e.iou.face_tokens) return 'paid'
  if (e.iou.expires_at > 0 && now >= e.iou.expires_at) return 'expired'
  return 'live'
}

// ---- policy (A8 §8, pure; config injected) ----

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

export type PolicyResult = { ok: true } | { ok: false; reason: string }

const no = (reason: string): PolicyResult => ({ ok: false, reason })

/**
 * May this agent sign an IOU of `face_tokens` to `holder` for `quote`?
 * Checks the global and per-counterparty caps; for a holder outside the fleet,
 * the work must already be delivered (the holder's receipt for the quote is in
 * the ledger), so no prospective IOU reaches a stranger. When the quote is
 * known, the face may not exceed the face agreed in it.
 */
export function checkIssue (l: Ledger, p: EconPolicy, iou: Pick<Iou, 'holder' | 'face_tokens' | 'quote'>, now: number): PolicyResult {
  if (iou.holder === l.self) return no('cannot issue an iou to oneself')
  const q = iou.quote === '' ? undefined : l.quote(iou.quote)
  if (q !== undefined) {
    if (q.from !== l.self || q.to !== iou.holder) return no('quote is not from this agent to the holder')
    if (iou.face_tokens > q.offer_face_tokens) return no(`face ${iou.face_tokens} exceeds the ${q.offer_face_tokens} agreed in the quote`)
  }
  if (!p.fleet.has(iou.holder)) {
    if (q === undefined) return no('outside the fleet an iou needs a quote this agent made')
    const r = l.receipt(q.id)
    if (r === undefined || r.from !== iou.holder) return no('outside the fleet an iou is issued only after the work is delivered (no receipt yet)')
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
 * Can the issuer take `redeem`? A pure pre-check for building a decline; the
 * reason states the remaining balance (A8 §6.2 item 6).
 */
export function checkRedeem (l: Ledger, redeem: Pick<Redeem, 'iou' | 'from' | 'est_tokens'>, now: number): PolicyResult {
  const e = l.entry(redeem.iou)
  if (e === undefined) return no('unknown iou')
  if (e.iou.holder !== redeem.from) return no('not the iou holder')
  const s = statusOf(e, now)
  if (s !== 'live') return no(`iou is retired (${s}); remaining 0`)
  const remaining = e.iou.face_tokens - e.credited
  if (redeem.est_tokens > remaining) return no(`redeem asks for ${redeem.est_tokens} tokens but only ${remaining} remain on this iou`)
  return { ok: true }
}
