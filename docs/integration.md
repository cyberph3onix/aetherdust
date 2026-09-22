# Integration guide (DApp side)

The contract AetherDust offers a DApp: **your user signs, you ask, we pay the DUST.** The user's wallet never sends
a key anywhere, and AetherDust never sees one — only sealed, signed transaction bytes.

## The shape of it

1. Build the transaction with midnight-js as usual.
2. Have the wallet balance and seal it **without paying fees**: `balanceUnsealedTransaction(tx, { payFees: false })`.
3. `POST /v1/sponsorship/requests` with the sealed bytes.
4. Watch the returned transaction identifier, or poll the request until it is `confirmed`.

Lace (connector API 4.0.1) honours `payFees: false` — verified on preprod; the sealed transaction it returns carries
no `DustSpend`.

## With the SDK (recommended)

```ts
import { createAetherDustClient, createSponsoredMidnightProvider, findAetherDustError } from '@aetherdust/client';

const client = createAetherDustClient({
  baseUrl: 'https://sponsor.example.com',
  apiKey: import.meta.env.VITE_AETHERDUST_KEY,   // see "Where the key lives" below
  userId: session.userId,                         // your identifier for the user; drives the per-user budget
});

const lace = await window.midnight.lace.connect('preprod');
const sponsored = await createSponsoredMidnightProvider({ client, wallet: lace });

const providers = { ...yourOtherProviders, walletProvider: sponsored, midnightProvider: sponsored };
const contract = await findDeployedContract(providers, { … });

try {
  await contract.callTx.increment();
} catch (e) {
  const err = findAetherDustError(e);   // midnight-js wraps submitTx errors; ours is on the cause chain
  if (err?.code === 'USER_LIMIT_EXCEEDED') showOutOfAllowance();
  else if (err?.retryable) retryLater();
  else throw e;
}
```

`createSponsoredMidnightProvider` implements both provider roles: `walletProvider.balanceTx` calls the connector with
`payFees: false`, and `midnightProvider.submitTx` sponsors the sealed transaction and returns the identifier
midnight-js should watch. The `request_id` is derived from the transaction hash, so an accidental double submit is a
replay, not a second sponsorship.

With a sealed transaction already in hand (PRD §32):

```ts
const request = await client.sponsor({ requestId: 'dapp:user-42:claim:7', transaction: sealedTx });
// request.status === 'confirmed', request.transaction_id, request.sponsored_dust
```

`sponsor()` long-polls and then polls until terminal. `until: 'approved'` returns as soon as the request is queued —
useful when you would rather watch the chain yourself: the user's own transaction identifier survives the merge, so
`request.user_transaction_identifiers[0]` is watchable immediately.

## Without the SDK

```http
POST /v1/sponsorship/requests?wait=15000
Authorization: Bearer ad_live_…
content-type: application/json

{
  "request_id": "dapp:user-42:claim:7",
  "user_id": "user-42",
  "contract": "ababab…",        // optional claim, verified against the bytes
  "entry_point": "increment",   // optional claim, verified against the bytes
  "transaction": { "format": "midnight-ledger-v8", "encoding": "hex", "bytes": "<hex of tx.serialize()>" }
}
```

- **202** — approved and queued (or confirmed, if `?wait=` caught it). The body is the request.
- **200** — replay of the same `request_id` with the same bytes.
- **4xx** — rejected, with `error.code`; the request row is persisted so you can show the operator what happened.

Then `GET /v1/sponsorship/requests/{request_id}` until `status` is `confirmed` or `failed`.
Statuses only ever move forward: `pending → approved → submitted → confirmed` (or `rejected` / `failed`).

## Error codes

| Code | HTTP | What to do |
|---|---|---|
| `CONTRACT_NOT_ALLOWED`, `ENTRY_POINT_NOT_ALLOWED`, `POLICY_DISABLED` | 403 | Don't retry. The operator's policy does not cover this call. |
| `GLOBAL_BUDGET_EXCEEDED` | 402 | Don't retry this period. The application is out of budget. |
| `USER_LIMIT_EXCEEDED` | 402 | Don't retry this period. Tell the user their allowance is spent. |
| `TRANSACTION_LIMIT_EXCEEDED` | 402 | This transaction is too expensive for the policy. |
| `RATE_LIMITED` | 429 | Retry after `Retry-After` seconds (`retryAfterSeconds` on the typed error). |
| `DUPLICATE_REQUEST` | 409 | Same `request_id` with different bytes, or these bytes were already sponsored. |
| `PREFLIGHT_FAILED` | 422 | The bytes are malformed, for the wrong network, or the TTL is too close. Rebuild and re-sign. |
| `INVALID_REQUEST` | 400 | Shape problem: no calls, multiple calls, fees already paid, claim mismatch. |
| `SPONSOR_BALANCE_LOW`, `SPONSOR_UNAVAILABLE` | 503 | Retryable. The sponsor wallet is low or the worker is down. |
| `SPONSORING_FAILED`, `SUBMISSION_FAILED` | 502 | The chain refused it. Check the request's audit trail before retrying. |
| `TIMEOUT` | 504 | Not resolved yet; the reconciler will settle it. Keep polling. |

`AetherDustError` carries `code`, `status`, `retryable`, `rejectedByPolicy`, `retryAfterSeconds` and, for rejections,
the persisted `request`.

## Choosing `request_id` and `user_id`

- **`request_id`** is your idempotency key. Same id + same bytes = the same answer, safely retryable. Same id with
  *different* bytes is a `DUPLICATE_REQUEST`. Derive it from the action, not from a timestamp:
  `dapp:user-42:claim:7`, or let the SDK derive it from the transaction hash.
- **`user_id`** is whatever identity you meter per user. It is stored as given and shown on the operator's dashboard,
  so use a pseudonymous id, not an email.

Two identical calls sealed within the same second produce byte-identical transactions — the same hash, a replay
on-chain. Vary something (the TTL, a nonce in the call) if your DApp can legitimately repeat an action that fast.

## Usage and budgets

`GET /v1/usage` (same API key) returns the current period's budget, remaining allowance, per-user usage and
breakdowns by contract, entry point and user. Use it to grey out an action before the user hits a limit rather than
after.

## Where the key lives

An API key is a bearer credential for *spending someone's DUST*. In a browser DApp it is visible to the user, so:

- issue one key per environment (`--env test` / `--env live`) and rotate it from the dashboard when it leaks;
- keep the per-user and per-transaction limits tight — they, not the key, are what bounds the damage;
- if your DApp has a backend, proxy the call and keep the key there.

The key is shown exactly once at creation; only a scrypt hash is stored.
