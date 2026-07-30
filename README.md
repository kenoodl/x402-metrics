# x402 seller metrics, v0.1

A reporting standard for x402 sellers who want their numbers to be checkable.

Published aggregate counts on this rail cannot distinguish real demand from bots, self-dealing, or prearranged integrations. The funnel has three drop-offs, not one: request to challenge, challenge to payment attempt, payment attempt to delivered. Every number published today measures only the last one, which is why the rail looks like it has a demand problem when it may have a buyer-runtime problem. This spec reports all three stages, names the wallets that don't count, and links the revenue claim to chain so a third party can verify it. That's the whole idea. One JSON file, one URL, verifiable on-chain.

Normative artifact: [`x402-metrics.schema.json`](./x402-metrics.schema.json) (JSON Schema draft 2020-12).
Filled examples: [`example-kenoodl.json`](./example-kenoodl.json), [`example-utilia.json`](./example-utilia.json).

## Where to publish

Serve the document at:

```
GET /.well-known/x402-metrics.json
```

Content type `application/json`. Regenerate at least once per reporting window. Monthly is the recommended window; any window is valid if declared explicitly with start, end, and hours. `generated_at` tells readers how fresh it is.

## Fields

All counts are for the declared window. Snake_case throughout.

### Top level

| Field | Req | What it is |
|---|---|---|
| `spec_version` | REQUIRED | `"0.1"` |
| `generated_at` | REQUIRED | ISO 8601 timestamp of report generation |
| `seller.name` | REQUIRED | Seller name (`seller.url` optional) |
| `protocol` | REQUIRED | e.g. `"x402/v2"` |
| `window.start`, `window.end`, `window.hours` | REQUIRED | Explicit window, no assumed period. `hours` must equal end minus start |
| `endpoints[]` | REQUIRED | One row per paid endpoint. An array, never a map keyed by URL, so crawlers can aggregate without parsing keys |
| `totals` | REQUIRED | Seller-level rollup. Additive fields must equal the sum of endpoint rows. `unique_payers` and `repeat_payers` are deduplicated across endpoints |
| `declared_exclusions[]` | REQUIRED, may be empty | Seller-linked wallets by address. Empty array is a positive claim that none exist |
| `receipt_linkage` | REQUIRED | On-chain pointers for independent verification |
| `notes` | OPTIONAL | Methodology caveats, price history |
| `extensions` | OPTIONAL | Anything else. Never add top-level fields |

### Per endpoint (and in `totals`)

| Field | Req | What it is |
|---|---|---|
| `route` | REQUIRED | Path, e.g. `/api/verify` (`method`, `price_usdc`, `notes` optional) |
| `challenges_served` | REQUIRED | 402 challenge responses served |
| `challenges_abandoned` | REQUIRED, nullable | Challenges that never produced a payment attempt: no retry carrying a payment signature was observed from that client within the window. If you cannot attribute retries to challenges, report `null`. Never guess |
| `paid_calls` | REQUIRED | Calls with a settled payment, all sources included |
| `unique_payers` | REQUIRED | Distinct payer wallets, excluding every address in `declared_exclusions` |
| `repeat_payers` | REQUIRED | See definition below. Distinct days, not distinct calls |
| `revenue_usdc_net_of_own_wallets` | REQUIRED | Settled USDC, excluding payments from `self` wallets in `declared_exclusions`. Prearranged and verifier revenue stays in; the breakdowns reveal it |
| `paid_retry_failures` | REQUIRED | `{total, by_class[]}`. See below |
| `paid_calls_by_source_class` | REQUIRED in `totals`, optional per endpoint | `paid_calls` split by source class, must sum to `paid_calls` |
| `payment_attempts` | OPTIONAL | Retries that arrived carrying a payment signature, settled or not. The missing middle of the funnel |
| `challenges_by_source_class` | OPTIONAL | `challenges_served` split by source class. Report it if you can: the challenge distribution and the paid distribution usually differ sharply, and that difference is itself the finding |
| `abandonment_causes` | OPTIONAL | Best-effort split of `challenges_abandoned`: `funding`, `policy`, `retry_handling`, `receipt_handling`, `unknown`. `unknown` is the default, never a guess. Must sum to `challenges_abandoned` |

Most sellers will only be able to fill `challenges_served`, `payment_attempts`, and `challenges_abandoned`. That is fine. Partial honesty beats fabricated completeness.

## Definitions that make the numbers comparable

**`repeat_payers`.** Distinct non-excluded wallets with settled paid calls on at least 2 distinct UTC calendar days within the window. A wallet paying 50 times in one day counts 0 here. One bot hammering an endpoint on one day is not retention.

**`source_class`.** Six values: `organic` (a real outside buyer consuming the output), `verifier` (pays to confirm the endpoint works, not to consume it: registry crawlers settling to confirm liveness, directory validators, probes; real USDC, not demand), `prearranged` (known integration or fixture wallet, payment agreed in advance), `self` (a wallet the seller controls), `scanner` (automated discovery traffic; mostly lands in `challenges_served`, rarely pays), `unknown` (could not classify with confidence). `unknown` is legitimate. No seller can classify every wallet, and forcing a guess corrupts the data. A report with a high `unknown` share is more credible than a suspiciously clean one.

**`declared_exclusions`.** Each entry carries `address`, `source_class` (`self`, `prearranged`, `verifier`, or `scanner`, never `organic` or `unknown`), and `evidence` a third party can check. Declaring your own wallets by address is the anti-gaming core of the spec. kenoodl's own agent wallet was once mistaken for a repeat customer. That is the failure mode this field exists to prevent.

**`paid_retry_failures`.** The buyer paid, retried with the payment signature, and still did not get what they paid for. Nobody publishes this number, which is why it is required. `by_class` uses a fixed enum so it is comparable across sellers:

| Class | Why it exists |
|---|---|
| `upstream_timeout` | A dependency did not answer in time. Separate from error because timeouts are load-shaped and often transient |
| `upstream_error` | A dependency returned an error. The seller's supply chain failed, not the buyer |
| `settlement_verified_but_no_delivery` | Money moved and nothing shipped. The worst class. It must never hide inside `other` |
| `malformed_payment` | The payment signature was unparseable or invalid. Buyer-side fault, but still a paid attempt that got nothing, and a spike signals broken client SDKs |
| `insufficient_amount` | The signed amount was below the price. Catches price-change races |
| `replay_rejected` | A reused authorization was correctly refused. Counted so honest rejections do not get shoved into `other` |
| `rate_limited` | Paid but throttled. A seller taking money it cannot serve |
| `sandbox_failure` | The seller's own execution environment failed |
| `other` | Requires a free-text `note`, so it cannot become a dumping ground |

**`receipt_linkage`.** What makes the report a checkable claim instead of a press release. Always required: the receiving `address`, the `chain` (CAIP-2, e.g. `eip155:8453` for Base), and the `asset` contract. Plus at least one of `settlement_tx_hashes` or `block_range`. Tx hashes are not unconditionally required because a high-volume seller cannot list ten thousand hashes in a well-known file; for them, address plus asset plus block range lets an auditor reconstruct the total by scanning transfers. At low volume there is no excuse: the validator warns when `paid_calls` is 100 or fewer and no hashes are listed.

## Utilia field mapping

Utilia's existing fields survive by rename, not rewrite:

| Utilia field | Canonical field |
|---|---|
| `generatedAt` | `generated_at` |
| `windowHours` | `window.hours` (plus explicit `window.start` and `window.end`) |
| `route` | `endpoints[].route` |
| `integrationSource` | `source_class` (in the breakdowns and in `declared_exclusions[].source_class`) |
| `challenges` | `challenges_served` |
| `paidRetryAttempts` | `payment_attempts` |
| `paidRetryFailuresByClass` | `paid_retry_failures.by_class` |
| `settlements` | `paid_calls` |
| `uniquePayerWallets` | `unique_payers` |
| `revenueUsdc` | `revenue_usdc_net_of_own_wallets` |
| `receiptLinkage` | `receipt_linkage` |
| `declared_exclusions` (their proposal) | `declared_exclusions`, adopted as proposed with `address`, `source_class`, `evidence` |

Utilia's original three source classes map into the six-value enum: `customer` becomes `organic`, `verifier` stays `verifier`, `test` becomes `self` (or `prearranged` if the wallet is a counterparty's).

## Validation

```
node validate.mjs /.well-known/x402-metrics.json
node validate.mjs https://example.com/.well-known/x402-metrics.json
```

Zero dependencies, Node 18+. Exits non-zero on failure and names the offending field. Beyond the schema it checks the arithmetic: breakdowns sum to their totals, `by_class` sums to `total`, totals equal the sum of endpoint rows, `repeat_payers` never exceeds `unique_payers`, the declared window hours match start and end, and the funnel is internally possible (a settled call implies a payment attempt, abandoned challenges cannot be fewer than challenges minus attempts).

## Versioning

`spec_version` is required in every document. v0.x may change field semantics between minors. From 1.0, fields are only added, never renamed or removed, and additions land in `extensions` first.
