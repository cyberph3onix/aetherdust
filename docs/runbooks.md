# Runbooks

Operational procedures for a running AetherDust. Commands assume Docker Compose from the repo root; substitute your
own orchestration as needed. `$ADMIN` is `AETHERDUST_ADMIN_TOKEN`.

Quick triage:

```bash
curl -s localhost:8080/healthz                                                  # api + database
curl -s -H "Authorization: Bearer $ADMIN" localhost:8080/v1/admin/wallet | jq   # sponsor wallet (live + snapshot)
docker compose -f deploy/docker-compose.yml logs --tail 100 worker
```

The dashboard's **Wallet** and **Overview** pages show the same facts; `/metrics` carries them as gauges.

---

## Fund the sponsor wallet

```bash
docker compose -f deploy/docker-compose.yml run --rm worker wallet addresses
```

Send NIGHT to the **unshielded** (`mn_addr…`) address — from the faucet on preview/preprod, or from another wallet
you control (`worker wallet fund <mn_addr…> <night>` sends from the configured wallet).

NIGHT alone does not pay fees. It has to be registered for DUST generation before any DUST exists.

**How much?** DUST generates from NIGHT over time toward a cap; the sponsor spends a fee per sponsorship (on preprod,
around 1 µDUST at current rates). Size NIGHT for your generation rate, and split it across several UTXOs — see
[throughput](#throughput-is-capped-by-dust-coins).

---

## Register NIGHT for DUST generation

```bash
docker compose -f deploy/docker-compose.yml run --rm worker wallet register-dust --wait
```

The registration transaction pays its own fee out of the UTXO's *projected* DUST, and that fee is dynamic — the
command estimates it and waits for enough DUST to be generated before submitting. `--wait` also waits for the first
spendable DUST coin to appear (roughly half a minute on a quiet chain).

Re-run it after adding NIGHT: new UTXOs are not registered automatically. `scripts/register-dust-until-done.sh`
retries it in a loop for unattended setups.

Verify:

```bash
docker compose -f deploy/docker-compose.yml run --rm worker wallet status
# synced: true · dustCoins > 0 · nightUtxosRegisteredForDust == nightUtxos
```

---

## `SPONSOR_BALANCE_LOW` (503 to DApps)

The worker refuses to sponsor when the wallet would drop below `AETHERDUST_MIN_SPONSOR_DUST`. Requests are rejected
before anything is reserved, so nothing is stuck.

1. `wallet status` — is the DUST balance actually low, or is it `dustCoins: 0` with a balance (all coins in flight)?
2. Low balance: add NIGHT and `register-dust`; DUST regenerates over time on its own.
3. Balance fine, coins zero: see [throughput](#throughput-is-capped-by-dust-coins).
4. If you deliberately want to run closer to empty, lower `AETHERDUST_MIN_SPONSOR_DUST` — the floor exists so a
   half-paid sponsorship never strands a user transaction.

Alert on `aetherdust_sponsor_wallet_dust < your floor` and on `aetherdust_sponsor_wallet_healthy == 0`.

---

## Throughput is capped by DUST coins

One in-flight sponsorship holds one DUST coin, so `max_in_flight` = free coins, and the worker's concurrency is
`min(AETHERDUST_WORKER_CONCURRENCY, free coins)`. `could not balance dust` is the retryable symptom of running out.

To raise it: split your NIGHT across more UTXOs (each registered UTXO generates its own DUST coin), then re-run
`register-dust`. Watch `aetherdust_sponsor_wallet_dust_coins` vs `_dust_coins_in_flight`.

---

## Stuck requests

A request in `TIMEOUT` or `UNKNOWN` is *not* lost: its merged bytes are persisted, the reservation is held, and the
reconciler re-checks it against the indexer every `AETHERDUST_RECONCILE_INTERVAL_S`.

```bash
curl -s -H "Authorization: Bearer $ADMIN" \
  "localhost:8080/v1/admin/applications/$APP/requests?status=TIMEOUT" | jq '.[] | {request_id, transaction_id, created_at}'
curl -s -H "Authorization: Bearer $ADMIN" localhost:8080/v1/admin/requests/$ID | jq .events   # full audit trail
```

- **Confirmed on-chain but stuck at `TIMEOUT`** — the watcher missed it; the reconciler settles it by identifier on
  its next pass. Nothing to do.
- **Still unresolved past the user's TTL + `AETHERDUST_CONFIRM_GRACE_S`** (default 3 h, the DUST grace period) — the
  reconciler marks it `EXPIRED` and releases the reservation.
- **Many at once** — check the indexer URL and the node; a dead indexer looks exactly like this.

Never edit `sponsorship_requests` by hand to "unstick" one: the reservation and the status are changed together in
one transaction, and hand edits split them.

---

## Worker restart (and the re-sync cost)

The worker is a **single writer** per sponsor wallet — run exactly one. On start it:

1. re-queues anything left in `SPONSORING` (nothing was sent yet),
2. **resubmits persisted merged bytes** for `SUBMITTED`/`TIMEOUT`/`UNKNOWN` (resubmission is idempotent: the node
   answers `1013 Transaction Already Imported` or the tx is simply deduped),
3. then resumes normal work.

The expensive part is the wallet sync: **there is no persisted wallet state yet**, so every restart re-syncs from
genesis — seconds on a local chain, **1–2 hours on preprod**. Restart the worker only when you mean it, and watch
`"sponsor wallet syncing"` in the logs for progress. While syncing, the api answers `SPONSOR_UNAVAILABLE` (503) and
the dashboard shows the wallet as *syncing* from the last snapshot.

The watchdog (`AETHERDUST_EVENT_LOOP_WATCHDOG_S`, default 120 s) SIGKILLs the process if the event loop stops
heartbeating, so a supervisor restarts it. If that fires repeatedly, look for the zero-fee hang below.

**If the worker restarts in a loop, check its dependencies before its code.** The worker refuses to start the wallet
sync until Postgres answers (it retries for a minute, then exits with
`the database must be reachable before the sponsor wallet syncs`) — precisely so a missing database costs seconds
instead of a two-hour sync. A database that disappears *after* the sync no longer kills the process either: the
worker keeps the synced wallet, refuses to claim new work, and retries the recovery pass every round. Starting the
worker alone (`restart: unless-stopped` after the rest of the stack is gone) is the usual way into this state — bring
Postgres up first:

```bash
docker compose -f deploy/docker-compose.yml --profile testnet up -d postgres proof-server api dashboard
docker compose -f deploy/docker-compose.yml logs -f worker      # "sponsor wallet syncing" → synced
```

---

## Fees round to zero

On an empty chain the network fee for a transaction can round to 0. `wallet-sdk-dust-wallet` 4.2.0's
`computeBalancingRecipe` never converges in that case and spins the event loop at 100 % CPU — it affects both fee
estimation and balancing.

The guard is `AETHERDUST_DUST_FEE_OVERHEAD_SPECKS` (default `1000000000` = 0.000001 DUST), which must stay **> 0**;
the config loader warns at boot if it is zero, and the watchdog kills a worker that hangs anyway. Do not raise it to
the SDK example's 0.3 DUST — that inflates every fee by ~80×.

---

## Rotate an API key

Dashboard → **Applications** → *Create API key* (the token is shown once), ship it to the DApp, then *Revoke* the old
one. Revocation is immediate: the next request with it gets `AUTH_FAILED`.

Same thing from the CLI:

```bash
docker compose -f deploy/docker-compose.yml run --rm api cli create-key --app $APP --env live --label rotation-2026-09
curl -s -X DELETE -H "Authorization: Bearer $ADMIN" localhost:8080/v1/admin/api-keys/$OLD_KEY_ID
```

To stop an application entirely without touching its keys: `PATCH /v1/admin/applications/{id}` with
`{"status":"suspended"}`, or set `enabled: false` in its policy.

---

## Rotate the admin token or the internal secret

Both are plain environment variables. Change `AETHERDUST_ADMIN_TOKEN` in `deploy/.env` and restart **api** only —
dashboard sessions are invalidated (operators sign in again), and nothing else is affected.

`AETHERDUST_INTERNAL_SECRET` is shared by api and worker: change it in both and restart **api first**, then the
worker, accepting the re-sync. Fee estimates fail (`SPONSOR_UNAVAILABLE`) in the window where they disagree.

---

## Rotate the sponsor seed

The seed *is* the wallet, so "rotation" means moving to a new wallet:

1. `worker wallet new-seed`, and put it in a file mounted at `AETHERDUST_SPONSOR_SEED_FILE`.
2. Fund and `register-dust` the new wallet while the old one still serves traffic.
3. Drain in-flight work: stop accepting new requests (suspend the applications, or `enabled: false`), wait until no
   request is in `RESERVED`/`SPONSORING`/`SUBMITTED`.
4. Swap the secret, restart the worker, wait out the sync, re-enable.
5. Move the remaining NIGHT with `worker wallet fund <new mn_addr…> <night>` from the old wallet.

---

## Database

Migrations are applied by the api at boot (`AETHERDUST_AUTO_MIGRATE=true`) under an advisory lock, or manually with
`api cli migrate`. They are additive and forward-only.

Back up `sponsorship_requests`, `request_events`, `usage_records`, `budget_periods`, `policies`, `applications`,
`api_keys` — that is the whole control plane. `sponsor_wallet_snapshots` is disposable.

The tables that grow are `sponsorship_requests` (which holds transaction bytes) and `request_events`. There is no
retention job yet; if you prune, keep `usage_records` (the usage numbers) and drop old `tx_bytes`/`merged_tx_bytes`
only for terminal rows.

---

## Capacity

Two separate ceilings, and they fail differently.

**Admission (api).** Every request verifies its API key with scrypt (N=16384), which runs on libuv's threadpool —
so a single api process admits roughly `threadpool size / scrypt time` requests per second. Measured on one
container with the defaults: **~104 req/s admitted**, p50 279 ms, p95 294 ms. Raise `UV_THREADPOOL_SIZE` (16 is a
reasonable start) or run more api containers; the api is stateless apart from its in-memory rate-limit counters.

**Sponsorship (worker).** Bounded by DUST coins, not CPU: `min(AETHERDUST_WORKER_CONCURRENCY, free coins)` in
flight, each taking as long as proving + submission + confirmation. With the mock adapter (8 coins, 200 ms
confirmations) one worker settled **27 sponsorships/s**; on a real chain the confirmation wait dominates and the
number is single digits per coin. The worker is a single writer — scale it by adding DUST coins, not processes.

Reproduce either number:

```bash
node scripts/loadtest.mjs --url http://127.0.0.1:8080 --admin $ADMIN --requests 300 --concurrency 30
```

It creates its own application and policy, drives N requests, waits for every one to settle, and then checks the
books: settled DUST must equal the sum of what confirmed requests were charged, with no reservation left behind.

---

## Upgrades

1. Read the release notes for pin changes (ledger, wallet SDK, node/indexer/proof-server support matrix).
2. `docker compose build`, then restart **api** first (it applies migrations), then the worker.
3. Verify: `/healthz`, `wallet status`, a sponsored call on a test application, `/metrics` still scraping.

The proof server, node and indexer versions must match the support matrix for the ledger version in use — mixing
them produces confusing verification failures rather than clean errors.
