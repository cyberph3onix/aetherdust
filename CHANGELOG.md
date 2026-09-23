# Changelog

## v0.1.0 — MVP (2026-09-23)

First release. A self-hostable DUST sponsorship control plane for Midnight DApps: the user signs with fees unpaid,
AetherDust enforces policy, budgets and limits, and a sponsor wallet pays the DUST.

**Proven on a public network.** A Lace wallet holding **0 NIGHT / 0 DUST** had `counter.increment` sponsored and
confirmed on **preprod** — contract `e244010266d63c97dd9aac01231281cb75eaa2a211e68ba9964533ddc2c22c56`, transaction
`003b27dc98e98615ee63718d9f7a741cb9c734ceac75f683f194f87896f334471e`, block 2657441, sponsor paid
0.000001000000001 DUST. Lace honours `payFees: false`: the sealed transaction it returns carries no `DustSpend`.

### Sponsorship
- `MidnightSponsorAdapter`: `balanceFinalizedTransaction(['dust'])` → sign → prove → merge → **structural post-merge
  check** (user calls unchanged, exactly one `DustSpend` added, user identifier preserved, no negative imbalance) →
  submit → confirm by transaction identifier.
- Single-writer worker with crash recovery (merged bytes persisted *before* submission), a reconciler for
  `TIMEOUT`/`UNKNOWN`, `SPONSOR_BALANCE_LOW`, and an event-loop watchdog.
- Concurrency is bounded by the sponsor's DUST coins; `wallet` CLI for `status`, `addresses`, `register-dust`,
  `new-seed`, `fund`.

### Control plane
- Fastify API with generated OpenAPI, scrypt-hashed API keys, a separate operator token, sliding-window rate limits,
  idempotency on `(application, request_id)` and on the transaction hash, and `202` + `?wait=` long-polling.
- Policy engine (R1–R9) evaluated against the real transaction bytes, never the DApp's claims; atomic budget
  reserve/settle/release over calendar-UTC periods; a state machine with an append-only audit trail.
- Postgres schema with migrations; one Docker image, two entrypoints.

### SDK and example
- `@aetherdust/client`: REST client, `createSponsoredMidnightProvider` for midnight-js, typed `AetherDustError`.
- `examples/example-dapp`: a browser counter DApp using Lace. (Renamed and rebuilt after v0.1.0 as
  `examples/allowlist-dapp` — Private Allowlist Access.)

### Dashboard and observability
- Operator dashboard (nginx image, `:8090`): overview, requests with audit trails, usage breakdowns, a policy editor
  with a dry run against recent traffic, API keys, wallet.
- Prometheus `/metrics` on the api (pipeline counters plus gauges read from Postgres at scrape time) and on the
  worker (sponsor/submit durations, confirmation latency, outcomes); structured logs carrying
  `request_id`/`application_id`/`transaction_id`.

### Testing
106 unit and integration tests, 12 end-to-end tests against a real local chain (both in-process and against Docker
containers, including a worker SIGKILL mid-sponsorship), 7 Playwright dashboard tests, and a load-test script that
checks the books balance. CI runs all of it plus a clean-machine Docker quickstart.

### Known limitations
- The sponsor wallet has no persisted sync state: a worker restart re-syncs, which takes 1–2 hours on a public
  network.
- `AETHERDUST_DUST_FEE_OVERHEAD_SPECKS` must stay above zero — `wallet-sdk-dust-wallet` 4.2.0 hangs when a network
  fee rounds to 0 (write-up in `docs/upstream-issue-dust-wallet-zero-fee.md`).
- Single admin token, no per-operator accounts; `user_id` is stored as given.
- `elliptic` carries an unpatched low-severity advisory through the example DApp's build tooling only.
