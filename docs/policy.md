# Policy reference

A policy is one JSON document per application. It is validated by the same zod schema the API uses
(`packages/core/src/policy.ts`), stored append-only — `PUT` creates a new version and the highest version is active —
and applied to the **next** request; requests already in flight keep the version they were admitted under
(`policy_version` on every request row).

Every rule **fails closed** and is evaluated against the *actual transaction bytes*, never the DApp's claims.

```json
{
  "enabled": true,
  "contracts": { "ababab…64 hex": ["increment", "claim"] },
  "allow_multiple_calls": false,
  "limits": {
    "period": "daily",
    "global_budget_dust": "100",
    "per_user_budget_dust": "1",
    "max_fee_per_tx_dust": "0.1"
  },
  "rate_limit": {
    "requests_per_minute_per_credential": 60,
    "requests_per_minute_per_user": 10,
    "requests_per_minute_per_ip": 120
  },
  "preflight": {
    "min_ttl_remaining_seconds": 300,
    "max_tx_bytes": 524288
  }
}
```

## Fields

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` rejects everything with `POLICY_DISABLED`. The kill switch. |
| `contracts` | `{}` | Address (64 lowercase hex) → allowed entry points, matched exactly and case-sensitively. An empty array allows the contract for no entry point. An address that is not a key is never sponsored. |
| `allow_multiple_calls` | `false` | Whether one transaction may contain more than one contract call. |
| `limits.period` | `daily` | `hourly` or `daily`, calendar-aligned **UTC**. Budgets reset at the boundary; changing the period starts a new bucket. |
| `limits.global_budget_dust` | — | Total DUST this application may spend per period. Decimal DUST string. |
| `limits.per_user_budget_dust` | — | Same, per `user_id`. |
| `limits.max_fee_per_tx_dust` | — | Per-transaction cap, checked against the fee *estimate* before anything is reserved. |
| `rate_limit.requests_per_minute_per_credential` | 60 | Sliding window per API key. Status reads get a separate, generous bucket (`max(600, 10 × this)`). |
| `rate_limit.requests_per_minute_per_user` | 10 | Per `user_id` within the application. |
| `rate_limit.requests_per_minute_per_ip` | 120 | Per source IP (`trustProxy` is on; put a real proxy in front or this is your load balancer's IP). |
| `preflight.min_ttl_remaining_seconds` | 300 | A transaction whose TTL is closer than this is rejected rather than sponsored — the sponsor must not pay for something that expires mid-flight. |
| `preflight.max_tx_bytes` | 524288 | Size ceiling, checked after decoding. |

Amounts are decimal DUST strings (`"0.004"`, `"100"`); they are converted to SPECK (1 DUST = 10¹⁵ SPECK) and all
arithmetic is integer. Numbers are accepted at the edge but strings avoid float surprises.

## Rules, in evaluation order

| Rule | Rejects with | When |
|---|---|---|
| R1 | `POLICY_DISABLED` | `enabled: false` |
| R4 | `CONTRACT_NOT_ALLOWED` | the transaction deploys a contract or carries a maintenance update — never sponsored |
| R2 | `INVALID_REQUEST` | no contract calls at all |
| R6 | `INVALID_REQUEST` | the transaction already carries DUST actions (fees already paid, or tampering) |
| R2b | `INVALID_REQUEST` | multiple calls while `allow_multiple_calls` is false |
| R2 | `CONTRACT_NOT_ALLOWED` | a called contract is not in `contracts` |
| R3 | `ENTRY_POINT_NOT_ALLOWED` | a called entry point is not allowlisted for its contract |
| R5 | `INVALID_REQUEST` | the DApp's `contract`/`entry_point` claim does not match the bytes |
| R7 | `PREFLIGHT_FAILED` | over `max_tx_bytes`, or the bytes fail `wellFormed` for this network (wrong network id, malformed) |
| R8 | `PREFLIGHT_FAILED` | TTL closer than `min_ttl_remaining_seconds` |
| R9 | `TRANSACTION_LIMIT_EXCEEDED` | fee estimate over `max_fee_per_tx_dust` |
| budget | `GLOBAL_BUDGET_EXCEEDED` / `USER_LIMIT_EXCEEDED` | the atomic reservation does not fit the period bucket |

Rate limits (`RATE_LIMITED`, with `Retry-After`) run before any of this — before the body is even parsed for the
credential and IP buckets. Rate-limited requests are counted in metrics but never persisted.

## Budgets

A request **reserves** `estimate × (1 + AETHERDUST_FEE_MARGIN)` against the global *and* the per-user bucket in one
transaction; the guard `reserved + settled + amount ≤ limit` is evaluated by Postgres under row locks, so concurrent
requests can never overshoot. On confirmation the reservation is dropped and the **actual on-chain fee** is settled;
on any failure the reservation is released. If the chain charged more than was reserved, it is settled anyway (the
DUST is spent) and an `OVERSPEND` audit event is written.

The per-period rows live in `budget_periods`; the dashboard's meters and `aetherdust_budget_*_dust` read them.

## Changing a policy safely

1. Edit it on the dashboard's **Policy** page (or `PUT /v1/admin/applications/{id}/policy`).
2. Press **Dry run** first: it replays the last N stored requests through the candidate and shows which ones would
   change outcome, with the rule that would fire. Nothing is saved.
3. Save. The new version applies to the next request.

Tightening a policy never affects transactions already sponsored, and a policy rejection consumes nothing — after you
fix the policy, the DApp's already-signed transaction can be re-submitted under a new `request_id` (the replay
guard deliberately excludes rejected rows).
