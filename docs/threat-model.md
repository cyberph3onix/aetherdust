# Threat model

What AetherDust is trying to protect, from whom, and what is left unprotected. It expands the boundary table in
`IMPLEMENTATION_PLAN.md` §18 and records the Phase 5 security pass.

## Assets

| Asset | Where it lives | Loss looks like |
|---|---|---|
| Sponsor seed | Worker process memory; env var or mounted file | Total loss of the sponsor's NIGHT and DUST |
| Sponsor DUST | On-chain, spendable only by the seed | Drained budget, sponsorship stops |
| Admin token | Operator's browser tab (sessionStorage) and the api's env | Policy/budget changes, new API keys, full read of every request |
| API keys | DApp (often a browser); scrypt hash in Postgres | Someone else spends the application's budget within its limits |
| Internal secret | api + worker env | Fee-estimate and health RPC access on the private network |
| Request data | Postgres: user ids, contract addresses, transaction bytes | Deanonymisation of who called what |

Not an asset here: **user keys**. They are never received. AetherDust only ever sees bytes the user's wallet already
sealed and signed.

## Actors

- **Anonymous internet** — can reach the api (and the dashboard, if you publish it).
- **A DApp with a valid API key** — spends budget under its own policy.
- **An end user of that DApp** — can craft arbitrary transactions and ask the DApp to submit them.
- **An operator** — holds the admin token.
- **The host** — can read the seed out of memory. Everything below assumes the host is trusted.

## Boundaries and controls

| Boundary | Controls |
|---|---|
| Internet → api | API key (scrypt-hashed, `ad_<env>_<keyId>_<secret>`), sliding-window rate limits per credential / IP / user, 2 MiB body cap, strict zod schemas, no wallet code in the process |
| Internet → dashboard | Admin token only; token kept in `sessionStorage` (closing the tab ends the session); the SPA holds no other credential and never talks to Midnight |
| Internet → `/metrics` | Bearer token required (admin or `AETHERDUST_METRICS_TOKEN`); `AETHERDUST_METRICS_PUBLIC=true` is opt-in for a private network |
| api → worker | Private network, shared secret, only `estimate` and `health`; neither can spend. The queue is Postgres, not an RPC |
| worker → proof server | **Private only.** The proof server sees the sponsor's witness data — a public one is a key-material leak by another name |
| worker → node / indexer | Outbound only; public endpoints are fine |
| Sponsor seed | Worker memory; `AETHERDUST_SPONSOR_SEED_FILE` preferred over an env var; pino redaction on `*.seed`, `*.secret`, `*.token`, and the config is never logged raw |
| Sponsor ↔ user transaction | The sponsor balances `['dust']` only, and the merged transaction is structurally checked before submission: the user's calls are unchanged, exactly one `DustSpend` is added, the user's identifier survives, and there is no negative imbalance |
| Replay | `UNIQUE(application_id, request_id)` and a unique index on `tx_hash` covering every non-rejected row — the same bytes can never be sponsored twice under any request id |
| Audit | Append-only `request_events`; every decision records the policy version and the inputs that produced it |

## Attacks considered

**A user makes the sponsor pay for something other than a fee.** The adapter balances only the `dust` token kind, and
the post-merge check rejects anything where the user's calls changed, more than one `DustSpend` appeared, or the
imbalance is negative. The sponsor cannot be made to move NIGHT.

**A DApp drains the sponsor.** Bounded by policy: per-transaction cap, per-user budget, global budget per UTC period,
and rate limits. The reservation is atomic in SQL, so concurrency cannot overshoot a budget. Worst case within one
period is the global budget — set it to what you can afford to lose.

**A leaked API key.** Same bound as above, plus rate limits. Revoke it on the dashboard; revocation is immediate.
Browser DApps should assume the key is public and lean on the per-user limits.

**Replay of a sealed transaction.** The tx-hash index refuses it, independent of `request_id`. Rejected requests are
deliberately excluded so that a policy fix lets a legitimately-rejected transaction through afterwards.

**A malicious or malformed transaction.** Rate limits and the body cap run before deserialisation; `wellFormed`
against a blank ledger state for the configured network catches wrong-network and malformed bytes for ~10 ms of CPU.
Contract proofs cannot be verified pre-submission on ledger v8 — a bad proof costs the sponsor ~1.5 s of CPU and
**0 DUST**, because the node rejects the transaction before any fee applies.

**A crash mid-sponsorship.** Merged bytes are persisted *before* submission, so a crash can never lose track of a
possibly-submitted transaction; recovery resubmits them (idempotent) and the reconciler settles whatever the chain
decided. Budget and status always change in the same database transaction.

**Timing attacks on tokens.** Admin, metrics and internal-secret comparisons use `timingSafeEqual` on equal-length
buffers; API key secrets go through scrypt.

**Operator mistakes.** The policy dry run replays recent traffic through a candidate policy before it is saved, so a
tightening that would have rejected legitimate traffic is visible beforehand. Policies are versioned and append-only.

## Residual risks (accepted for the MVP)

- **Host compromise = seed compromise.** No HSM, no remote signer. Run the worker on a host you trust, with the seed
  in a mounted file rather than an environment variable.
- **A single admin token.** No per-operator accounts, no audit of *which* human changed a policy. Put the dashboard
  behind your own SSO if that matters.
- **`user_id` is stored raw** (a §23 decision). It is visible on the dashboard and in `/v1/usage` breakdowns. Send a
  pseudonym, not an email.
- **Transaction bytes are retained** in `sponsorship_requests` with no retention policy yet.
- **Metrics label cardinality** is bounded by applications and status/error codes, not by user — but application
  *names* appear in `aetherdust_application_info`. Treat the metrics endpoint as operator-confidential.
- **No mutual TLS between api and worker.** A shared secret on a private network; an attacker already on that network
  can request fee estimates and health (neither spends).
- **Dependency supply chain.** Versions are pinned (including pnpm overrides for the duplicated WASM packages), but
  there is no signature verification of the Midnight images beyond their tags.
- **The `AETHERDUST_METRICS_PUBLIC` escape hatch** exists; if you set it, make sure the port really is private.

## Deployment checklist

- [ ] `AETHERDUST_ADMIN_TOKEN` is long and random, and not shared with anything else.
- [ ] `AETHERDUST_SPONSOR_SEED_FILE` points at a mounted secret; the seed is not in `deploy/.env`.
- [ ] The proof server is reachable only from the worker.
- [ ] The worker publishes no ports; only the api (and, if you want it, the dashboard) is exposed.
- [ ] `AETHERDUST_METRICS_TOKEN` is set if anything but your monitoring can reach `/metrics`.
- [ ] `AETHERDUST_DASHBOARD_ORIGIN` is set to your dashboard's origin in production (CORS defaults to permissive).
- [ ] Postgres is not reachable from outside the compose network; backups are in place.
- [ ] Global and per-user budgets are set to amounts you are willing to lose in one period.
- [ ] TLS terminates in front of the api (it speaks plain HTTP; `trustProxy` is on).
