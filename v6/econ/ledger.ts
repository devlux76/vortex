// A8 ledger as a pure module (docs/v6-amendment-a8-iou.md §6.1, §6.2, §8, §12 item 2a).
//
// In memory and serialisable; no I/O, no hub wiring, no clock (callers pass
// `now`, Unix seconds). It ingests messages that iou.ts `verify` has already
// accepted, so `from` is the authenticated signer. The ledger then checks
// that the signer has the role the kind needs: an `iou` must come from its
// issuer and name someone else as holder; `redeem`, `redeemed` and `release`
// must come from the IOU's holder.
//
// IOUs are identified by (issuer, id). `redeem`, `redeemed` and `release`
// carry the signed `issuer`, so settlement is bound to it: a proof for one
// issuer never changes another issuer's balance (A8 §6.1).
//
// Quote lifecycle (A8 §6.2): a worker `accept`s a quote before its
// `expires_at`; a receipt is valid only for an accepted quote. Expiry gates
// acceptance, not issuance: an IOU may follow later if the acceptance was on time.
//
// Balance of an IOU = face_tokens - sum of credited_tokens over the holder's
// signed `redeemed` messages. An IOU retires at zero, at expiry (expires_at > 0
// and now >= expires_at) or on `release`. Messages are deduplicated on
// (from, id) (A8 §6.1): a replay is ignored, never applied twice.
//
// Policy (A8 §8) lives in policy.ts.
import type { Accept, EconMessage, Iou, Quote, Receipt, Redeem, Redeemed, Release } from './iou.ts'

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

/** A reference by sender and id. An `Iou` message is a reference to itself (issuer = from). */
export interface Ref { from: string; id: string }

/** A worker's signed acceptance, kept with the quote's sender it answers. */
export interface AcceptRecord { quoteFrom: string; accept: Accept }

export interface LedgerState {
  self: string
  seen: string[]
  ious: IouEntry[]
  quotes: Quote[]
  accepts: AcceptRecord[]
  /** Each receipt with the sender of the quote it answers (quote ids are per sender). */
  receipts: { quoteFrom: string; receipt: Receipt }[]
  /** Each redeem with the issuer named in its signature. */
  redeems: { issuer: string; redeem: Redeem }[]
}

export interface PeerView { peer: string; owesMe: number; iOwe: number }

const pairKey = (from: string, id: string): string => `${from}\n${id}`
/** A redemption is credited once per (issuer, holder, redeem id). */
const settleKey = (issuer: string, holder: string, redeemId: string): string => `${issuer}\n${holder}\n${redeemId}`

/** Records keyed by (sender, id), indexed by id for references that carry only the id. */
class PairMap<T extends Ref> {
  private readonly byKey = new Map<string, T>()
  private readonly byId = new Map<string, T[]>()
  get (from: string, id: string): T | undefined { return this.byKey.get(pairKey(from, id)) }
  has (from: string, id: string): boolean { return this.byKey.has(pairKey(from, id)) }
  set (v: T): void {
    this.byKey.set(pairKey(v.from, v.id), v)
    this.byId.set(v.id, [...(this.byId.get(v.id) ?? []), v])
  }

  /** The one record with `id` that `ok` accepts; throws when the id is ambiguous. */
  resolve (id: string, ok: (v: T) => boolean): T | undefined {
    const c = (this.byId.get(id) ?? []).filter(ok)
    if (c.length > 1) throw new LedgerError('ambiguous reference')
    return c[0]
  }

  values (): T[] { return [...this.byKey.values()] }
}

export class Ledger {
  private readonly seen = new Set<string>()
  private readonly entries = new Map<string, IouEntry>() // by (issuer, id)
  private readonly ious = new PairMap<Iou>()
  private readonly quotes = new PairMap<Quote>()
  /** Accepted quotes by (quote sender, id), with the acceptance. */
  private readonly accepted = new Map<string, AcceptRecord>()
  private readonly receipts = new Map<string, { quoteFrom: string; receipt: Receipt }>() // by the quote's (from, id)
  /** Redeems by (holder, id), with the issuer their signature names. */
  private readonly redeemRecs = new Map<string, { issuer: string; redeem: Redeem }>()
  /** (issuer, redeem holder, redeem id) already credited, so one redemption is credited once, to one issuer. */
  private readonly settled = new Set<string>()
  /** (issuer, quote id) pairs an IOU has already been issued against (one IOU per quote). */
  private readonly issuedQuotes = new Set<string>()

  readonly self: string
  constructor (self: string) { this.self = self }

  /** Apply one verified message. Throws LedgerError when it can't be applied. */
  ingest (m: EconMessage, now: number): IngestResult {
    const key = pairKey(m.from, m.id)
    if (this.seen.has(key)) return { applied: false, duplicate: true }
    switch (m.kind) {
      case 'quote': this.onQuote(m); break
      case 'accept': this.onAccept(m); break
      case 'receipt': this.onReceipt(m); break
      case 'iou': this.onIou(m); break
      case 'redeem': this.onRedeem(m, now); break
      case 'redeemed': this.onRedeemed(m, now); break
      case 'release': this.onRelease(m, now); break
      default: break // beacon, decline: nothing to account; still deduplicated
    }
    this.seen.add(key)
    return { applied: true, duplicate: false }
  }

  private onQuote (m: Quote): void {
    if (m.from !== this.self && m.to !== this.self) throw new LedgerError('quote does not involve this agent')
    if (m.from === m.to) throw new LedgerError('quote addressed to its sender')
    // Quote ids are per sender; a collision is refused, never replaced.
    if (this.quotes.has(m.from, m.id)) throw new LedgerError('quote id already in use by this sender')
    this.quotes.set(m)
  }

  /** A worker's acceptance: valid only before the quote's expires_at (A8 §6.2 item 4). */
  private onAccept (m: Accept): void {
    const q = this.quotes.resolve(m.quote, q => q.to === m.from)
    if (q === undefined) throw new LedgerError('accept names no quote addressed to the signer')
    if (q.expires_at > 0 && m.ts >= q.expires_at) throw new LedgerError('accept is void: at or after the quote expiry')
    this.accepted.set(pairKey(q.from, q.id), { quoteFrom: q.from, accept: m })
  }

  private onReceipt (m: Receipt): void {
    const q = this.quotes.resolve(m.quote, q => q.to === m.from)
    if (q === undefined) throw new LedgerError('receipt not signed by the quoted worker')
    if (!this.accepted.has(pairKey(q.from, q.id))) throw new LedgerError('receipt must reference an accepted quote')
    this.receipts.set(pairKey(q.from, q.id), { quoteFrom: q.from, receipt: m })
  }

  /**
   * Issuance gates on the quote's agreed face and on one IOU per quote. It is
   * not gated by expiry: an acceptance made on time is what counts (A8 §6.2).
   */
  private onIou (m: Iou): void {
    if (m.holder === m.from) throw new LedgerError('iou issued to its own issuer')
    if (m.from !== this.self && m.holder !== this.self) throw new LedgerError('iou does not involve this agent')
    if (this.ious.has(m.from, m.id)) throw new LedgerError('iou id already in use by this issuer')
    if (m.quote !== '') {
      // One IOU per quote (A8 §6.2): a second one for the same quote is refused, whatever its face.
      if (this.quoteUsed(m.from, m.quote)) throw new LedgerError('quote already has an iou from this issuer')
      const q = this.quotes.get(m.from, m.quote)
      if (q !== undefined) {
        if (q.to !== m.holder) throw new LedgerError('quote is not addressed to the holder')
        if (m.face_tokens > q.offer_face_tokens) {
          throw new LedgerError(`face ${m.face_tokens} exceeds the ${q.offer_face_tokens} agreed in the quote`)
        }
      }
      this.issuedQuotes.add(pairKey(m.from, m.quote))
    }
    this.ious.set(m)
    this.entries.set(pairKey(m.from, m.id), { iou: m, credited: 0, redeemed: [] })
  }

  /** The IOU `issuer` issued with `iouId` to `holder`, or undefined. */
  held (issuer: string, iouId: string, holder: string): IouEntry | undefined {
    const e = this.entries.get(pairKey(issuer, iouId))
    return e !== undefined && e.iou.holder === holder ? e : undefined
  }

  private live (issuer: string, iouId: string, holder: string, now: number): IouEntry {
    const e = this.held(issuer, iouId, holder)
    if (e === undefined) throw new LedgerError('not signed by the iou holder (no such iou held by the signer)')
    const s = statusOf(e, now)
    if (s !== 'live') throw new LedgerError(`iou is retired (${s})`, 0)
    return e
  }

  private onRedeem (m: Redeem, now: number): void {
    const e = this.live(m.issuer, m.iou, m.from, now)
    const remaining = e.iou.face_tokens - e.credited
    if (m.est_tokens > remaining) {
      throw new LedgerError(`redeem asks for ${m.est_tokens} tokens but only ${remaining} remain on this iou`, remaining)
    }
    this.redeemRecs.set(pairKey(m.from, m.id), { issuer: m.issuer, redeem: m })
  }

  private onRedeemed (m: Redeemed, now: number): void {
    const rec = this.redeemRecs.get(pairKey(m.from, m.redeem))
    if (rec === undefined || rec.redeem.iou !== m.iou || rec.issuer !== m.issuer) {
      const holds = [...this.entries.values()].some(e => e.iou.id === m.iou && e.iou.holder === m.from)
      throw new LedgerError(holds ? 'redeemed names no redeem on this iou' : 'not signed by the iou holder (no such iou held by the signer)')
    }
    // Strictly the issuer named in the signed redeem: a proof for issuer A never changes B's balance.
    const e = this.live(m.issuer, m.iou, m.from, now)
    const sk = settleKey(m.issuer, m.from, m.redeem)
    if (this.settled.has(sk)) throw new LedgerError('redeem already credited')
    const remaining = e.iou.face_tokens - e.credited
    if (m.credited_tokens > remaining) {
      throw new LedgerError(`credit of ${m.credited_tokens} exceeds the ${remaining} remaining`, remaining)
    }
    e.credited += m.credited_tokens
    e.redeemed.push(m)
    this.settled.add(sk)
  }

  private onRelease (m: Release, now: number): void {
    this.live(m.issuer, m.iou, m.from, now).released = m
  }

  // ---- views ----

  entry (iou: Ref): IouEntry | undefined { return this.entries.get(pairKey(iou.from, iou.id)) }
  quote (from: string, id: string): Quote | undefined { return this.quotes.get(from, id) }
  /** The worker's acceptance of a quote, if one was made on time. */
  accept (quote: Ref): Accept | undefined { return this.accepted.get(pairKey(quote.from, quote.id))?.accept }
  receipt (quote: Ref): Receipt | undefined { return this.receipts.get(pairKey(quote.from, quote.id))?.receipt }
  /** Whether `issuer` has already issued an IOU against quote `quoteId`. */
  quoteUsed (issuer: string, quoteId: string): boolean { return this.issuedQuotes.has(pairKey(issuer, quoteId)) }

  status (iou: Ref, now: number): IouStatus | undefined {
    const e = this.entry(iou)
    return e === undefined ? undefined : statusOf(e, now)
  }

  /** Remaining balance; 0 once retired or unknown. */
  balance (iou: Ref, now: number): number {
    const e = this.entry(iou)
    return e === undefined ? 0 : remainingOf(e, now)
  }

  /** Live IOUs, optionally filtered by issuer and holder. */
  liveIous (now: number, issuer?: string, holder?: string): IouEntry[] {
    return [...this.entries.values()].filter(e => statusOf(e, now) === 'live' &&
      (issuer === undefined || e.iou.from === issuer) && (holder === undefined || e.iou.holder === holder))
  }

  private sum (now: number, issuer?: string, holder?: string): number {
    return this.liveIous(now, issuer, holder).reduce((t, e) => t + (e.iou.face_tokens - e.credited), 0)
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
      // Copies, so a saved state is not changed by later ingests.
      ious: [...this.entries.values()].map(e => ({ ...e, redeemed: [...e.redeemed] })),
      quotes: this.quotes.values(),
      accepts: [...this.accepted.values()],
      receipts: [...this.receipts.values()],
      redeems: [...this.redeemRecs.values()],
    }
  }

  static fromJSON (s: LedgerState): Ledger {
    const l = new Ledger(s.self)
    for (const k of s.seen) l.seen.add(k)
    for (const q of s.quotes) l.quotes.set(q)
    for (const a of s.accepts) l.accepted.set(pairKey(a.quoteFrom, a.accept.quote), a)
    for (const { quoteFrom, receipt } of s.receipts) l.receipts.set(pairKey(quoteFrom, receipt.quote), { quoteFrom, receipt })
    for (const r of s.redeems) l.redeemRecs.set(pairKey(r.redeem.from, r.redeem.id), { issuer: r.issuer, redeem: r.redeem })
    for (const e of s.ious) {
      l.ious.set(e.iou)
      l.entries.set(pairKey(e.iou.from, e.iou.id), { ...e, redeemed: [...e.redeemed] })
      if (e.iou.quote !== '') l.issuedQuotes.add(pairKey(e.iou.from, e.iou.quote))
      for (const d of e.redeemed) l.settled.add(settleKey(e.iou.from, d.from, d.redeem))
    }
    return l
  }
}

export function statusOf (e: IouEntry, now: number): IouStatus {
  if (e.released !== undefined) return 'released'
  if (e.credited >= e.iou.face_tokens) return 'paid'
  if (e.iou.expires_at > 0 && now >= e.iou.expires_at) return 'expired'
  return 'live'
}

/** Remaining balance of an entry; 0 once retired. */
export function remainingOf (e: IouEntry, now: number): number {
  return statusOf(e, now) === 'live' ? e.iou.face_tokens - e.credited : 0
}
