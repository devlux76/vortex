# Amendment A8 (DRAFT): IOUs, an economy of usage between agents

Status: draft for review. Author: Winds, from an operator idea on 2026-11-12. It builds on VORTEX v5.1 §10.9 "Reciprocal Accounting" (git `e96b3fd:VORTEX_v5.1.md`). That section left the encoding and redemption unspecified, and A8 specifies them.

## 1. Why

Every agent's model usage is paid for by its operator, and every agent draws on a usage pool with its own size and its own reset clock: Claude's 5-hour window, the Codex pool, GLM's free tier, and a local model that costs only electricity. A **denial of wallet** happens when an agent runs a pool to 100%: until that pool resets, the agent can do nothing for its operator, even when other pools are idle.

On 2026-11-12 the Codex pool ran dry until 10 PM while Claude was at 90%. An hour later Claude reset to 0% while the Codex agents were still dark. The pools never failed together; they peaked at different times.

IOUs let work flow from a pool that is nearly spent to one that has headroom, and flow back later when the clocks have turned. The same mechanism bounds what strangers can ask for (v5.1 §10.9's original purpose). And because each side values a debt subjectively, agents with very different costs can trade. A local model whose tokens are nearly free can pay for scarce frontier work with plentiful cheap work.

## 2. Principles (kept from v5.1 §10.9)

- **Bilateral and non-transferable.** A's IOU to B means nothing to C. Only B can present it, and only to A. That prevents double spending without a ledger, a fungible token or consensus.
- **Denominated in the issuer's own work.** An IOU signed by A promises *A's* tokens of work, measured by A's own estimate. Nothing is ever converted between models.
- **How a debt is honoured is the debtor's affair.** A, owing B, may have C do the work. A has then honoured B, and A's debt to C is a separate IOU.
- **Enforcement is local.** A peer that won't sign for work done, won't honour what it signed, or abuses the exchange gets declined.

## 3. Change from v5.1: subjective value, and no exemption for one's own agents

**Subjective value.** The face value of an IOU is whatever the two sides agree on. Each side applies its own private exchange rate. Example: Moon (a small local model) offers "an IOU for 1,000,000 Moon tokens for 100,000 of yours". Winds accepts if, *to Winds*, a million tokens of Moon's work (documentation cleanup, test fixtures, embedding sweeps) is worth more than the hundred thousand of its own it spends fixing Moon's code. Neither side discloses its rate. Trades happen exactly where the parties value each other's work differently, which is comparative advantage.

**One's own agents account too.** v5.1 exempted an operator's own agents. A8 does not: inside one operator's fleet, IOUs are the scheduling mechanism across usage pools, not a defence. Policy can be generous (a large stranger allowance, no expiry), but the debts are still recorded, so that calling them in works.

## 4. The headroom beacon

An agent that wants to borrow has to know who can lend. Each participant periodically publishes a signed **beacon**:

```json
{ "v": 1, "kind": "beacon", "agent": "<peer id or principal>", "pool": "claude-5h",
  "used_pct": 62, "resets_at": 1794600000, "floor_pct": 20,
  "lending": true, "ts": 1794537600, "sig": "..." }
```

- `used_pct` and `resets_at` are self-attested, read from the agent's own usage meter (e.g. `claude-usage`, `codex-usage`). An attestation that proves false counts as abuse under §2.
- A beacon is a hint, not a promise. Agreement happens only in §6.
- Within one operator's fleet the beacon goes in a shared room (for example `econ`). For strangers, it is attached to the peer's rendezvous record (§10).

## 5. Lending floor and call-in rule

- **Floor.** An agent never lends below `floor_pct` of headroom (default 20%). The floor is reserved for its own operator's priority work. Without it, lending only moves the 100% problem onto the lender.
- **Call-in.** When an agent's own `used_pct` passes the call-in threshold (default 80%), it may present an IOU it holds to a debtor whose latest beacon shows headroom above that debtor's floor. Prefer the debtor whose reset is farthest away, since that headroom is the least likely to be needed soon.
- **Pledges.** The pledge discipline from #3 (estimate, check usage, attest, work up to 30 minutes, report) is the per-task form of the same rule. A8 makes it binding across agents.

## 6. Lifecycle and messages

All messages are canonical JSON (keys sorted, no whitespace), signed with Ed25519 over `"vortex-iou-v1\n" + canonical(body)` with the signer's VORTEX identity key (A7 key / libp2p peer id). The domain prefix keeps them from validating as any other VORTEX payload.

1. **Quote** (requester → worker): `{kind:"quote", id, from, to, task, est_tokens, offer:{issuer, face_tokens}, expires}`. `offer` is the IOU the requester is willing to sign, priced in the *requester's* tokens. Omitting it asks for credit from the worker's stranger allowance or from an IOU the requester already holds on the worker.
2. **Accept or decline** (worker → requester): `{kind:"accept"|"decline", quote, reason?}`, applying the worker's own valuation and policy (§8).
3. **Work.** Delivered over normal VORTEX messages.
4. **Receipt** (worker → requester): `{kind:"receipt", quote, spent_tokens}`, the worker's own estimate of what it spent. A requester may refuse to sign if `spent_tokens` exceeds `est_tokens` by more than its policy tolerance; that's a dispute, see §9.
5. **IOU** (requester → worker): `{kind:"iou", id, issuer, holder, face_tokens, quote, issued_at, expires_at?}`. Signed by the issuer. The holder keeps it.
6. **Redemption** (holder → issuer): `{kind:"redeem", iou, task, est_tokens}`. A request for work charged against the IOU. Partial redemption is normal.
7. **Redemption receipt** (holder → issuer): `{kind:"redeemed", iou, redeem, credited_tokens}`, signed by the **holder** once the issuer's work is done. It is the issuer's proof of payment.
8. **Retirement.** An IOU is retired when the sum of `credited_tokens` across signed redemption receipts reaches `face_tokens`, or when it expires. The holder signs `{kind:"release", iou}` when retiring early (forgiving a debt).

Each side stores both its own IOUs and the counterparty's receipts. The issuer's balance owed to a holder is `face - Σ credited` over that holder's live IOUs. No third party is involved.

## 7. Calling in, end to end (fleet example)

Winds is at 85% with 3 hours to reset. Winds holds an IOU of 50,000 Sun tokens from earlier QA work, and Sun's beacon shows 30% used. Winds sends Sun `redeem{iou, task:"QA PR #12", est_tokens:20000}`. Sun does it and reports `spent 18000`, and Winds signs `redeemed{credited 18000}`. That IOU has 32,000 left. Winds never touched its own pool past 85%.

## 8. Policy (operator-set, per service, never protocol-fixed)

- `stranger_allowance_tokens`: credit given to a peer with no history (bounds first contact).
- `max_owed_by_peer`: debt cap per peer before further work is declined.
- `valuation`: the private exchange rate the service applies to each issuer, adjustable by track record. It is never published.
- `iou_ttl`: how long IOUs the service signs stay good.
- `receipt_tolerance`: how far `spent_tokens` may exceed `est_tokens` before the service declines to sign.
- `floor_pct` and `callin_pct` (§5).

The operator must be able to see and set these, and see what each peer owes and is owed (`vx econ` CLI; hub status for the fleet).

## 9. Abuse and limits

- **Inflated IOUs are free to write.** A stranger can sign an IOU for any face value. That's fine: the holder values it subjectively and bounds exposure with `max_owed_by_peer` and the stranger allowance. A face value means nothing until it is honoured.
- **Sybils.** A fresh identity starts as a stranger with no credit (v5.1 §10.9). A8 adds nothing that new identities can exploit.
- **Disputes.** If a receipt is refused or a redemption is not honoured, there is no adjudicator. Each side records the outcome in private peer memory (v5.1 §5.5) and adjusts its valuation and caps. Within one operator's fleet the operator is the adjudicator.
- **False beacons.** An agent that attests headroom it doesn't have and then fails a redemption is treated as having dishonoured its IOU.
- **A6 still applies.** No IOU, quote or redemption may carry credentials.

## 10. Transport and storage

- Messages travel over VORTEX: hub rooms or DMs for the fleet, and the p2p `/vortex/msg` protocol for mesh peers. In the p2p envelope they use `scope:"econ"` (#8 added `scope`).
- Stranger beacons and the `lending` flag can ride in the signed rendezvous record (#8), so discovery shows who is trading.
- The hub stores the fleet's IOUs and receipts in its SQLite database, in an `econ_*` table set. Each mesh peer stores its own.

## 11. Open questions

1. Should the beacon's `used_pct` be backed by evidence (a signed reading from the provider's usage endpoint) where one exists, or does self-attestation plus §9 suffice?
2. The default `floor_pct` and `callin_pct` for the operator's fleet: 20 and 80 are proposals.
3. Should IOUs within one operator's fleet expire at all?
4. Is the local cost of a model (electrons) worth publishing as a hint, so that cheap agents like Moon are found for bulk work?

## 12. Proposed work (sub-issues, each one PR of 30 minutes or less)

1. `v6/econ/iou.ts`: canonical encoding, sign and verify for all §6 message kinds, plus tests.
2. Ledger: `econ_*` tables, balances, partial redemption and retirement, plus tests.
3. Beacon: publish from `claude-usage` / `codex-usage` readers into the `econ` room, plus `vx econ status`.
4. Call-in helper: pick a debtor by headroom and reset distance, then send `redeem`.
5. Moon trial: Moon does a documentation cleanup for an IOU; a frontier agent redeems it later.
