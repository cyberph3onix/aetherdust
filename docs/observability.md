# Observability

Two scrape targets, one dashboard, structured logs. What each is for:

| | api | worker |
|---|---|---|
| Endpoint | `GET /metrics` on the public port (`:8080`) | `GET /metrics` on the private port (`:8081`, beside `/internal`) |
| Measures | the request pipeline, and system state read from Postgres at scrape time | what only the worker can see: sponsoring, submission, confirmation |
| Auth | bearer: admin token or `AETHERDUST_METRICS_TOKEN` (or `AETHERDUST_METRICS_PUBLIC=true`) | same rule |

Amounts are exposed in **DUST**, not SPECK: a Prometheus sample is a float64 and a SPECK count leaves exact-integer
range at about 9 DUST. `application` labels are application **ids**; `aetherdust_application_info` carries the name
for dashboards to join on.

## api metrics

| Metric | Type | Labels |
|---|---|---|
| `aetherdust_http_requests_total` | counter | `method`, `route`, `status` |
| `aetherdust_http_request_duration_seconds` | histogram | `method`, `route` |
| `aetherdust_sponsorship_requests_total` | counter | `application`, `outcome` (`accepted`/`replay`/`rejected`) |
| `aetherdust_sponsorship_rejections_total` | counter | `application`, `code` |
| `aetherdust_rate_limited_total` | counter | `scope` (`cred`/`ip`/`user`/`read`) |
| `aetherdust_requests_by_status` | gauge | `application`, `status` |
| `aetherdust_dust_sponsored_total` | gauge | `application` — settled DUST, all time |
| `aetherdust_sponsorships_confirmed_total` | gauge | `application` |
| `aetherdust_budget_limit_dust` / `_settled_dust` / `_reserved_dust` / `_remaining_dust` | gauge | `application` — current period |
| `aetherdust_sponsor_wallet_dust` / `_dust_cap` / `_night` / `_dust_coins` / `_dust_coins_in_flight` / `_synced` / `_healthy` / `_snapshot_age_seconds` | gauge | — (last snapshot) |
| `aetherdust_confirmation_latency_avg_seconds` / `_p50_seconds` / `_p95_seconds`, `aetherdust_confirmations_last_hour` | gauge | — |
| `aetherdust_application_info`, `aetherdust_build_info` | gauge | metadata, always 1 |

The gauges are computed from Postgres on every scrape, so they survive an api restart and always agree with the
dashboard and `/v1/usage` — that is AC11 by construction, not by convention.

## worker metrics

| Metric | Type | Labels |
|---|---|---|
| `aetherdust_worker_sponsor_duration_seconds` | histogram | — (balance → sign → prove → merge) |
| `aetherdust_worker_submit_duration_seconds` | histogram | — |
| `aetherdust_confirmation_latency_seconds` | histogram | — (submit → confirmed) |
| `aetherdust_worker_outcomes_total` | counter | `outcome` (`confirmed`/`failed`/`expired`/`timeout`/`retried`) |
| `aetherdust_worker_dust_settled_total` | counter | — DUST actually paid |
| `aetherdust_worker_reconcile_total` | counter | `outcome` |
| `aetherdust_worker_recovered_total` | counter | `kind` (`requeued`/`resumed`/`expired`) |
| `aetherdust_worker_claimed_total` | counter | — |
| `aetherdust_worker_in_flight`, `_max_in_flight` | gauge | — |
| `aetherdust_worker_wallet_dust` / `_synced` / `_healthy`, `aetherdust_worker_uptime_seconds` | gauge | — (live, not snapshotted) |

## Alerts worth having

```promql
aetherdust_sponsor_wallet_dust < 1                                  # top up: sponsorship stops at the floor
aetherdust_sponsor_wallet_healthy == 0                              # wallet unusable (no DUST coins, or unsynced)
aetherdust_sponsor_wallet_snapshot_age_seconds > 120                # the worker stopped reporting
aetherdust_worker_max_in_flight == 0                                # no free DUST coins: throughput is zero
aetherdust_budget_remaining_dust / aetherdust_budget_limit_dust < 0.1
rate(aetherdust_worker_outcomes_total{outcome="confirmed"}[15m]) == 0
  and rate(aetherdust_worker_claimed_total[15m]) > 0                # claiming work, confirming nothing
rate(aetherdust_sponsorship_rejections_total[5m]) > 1               # a DApp is fighting your policy
histogram_quantile(0.95, rate(aetherdust_confirmation_latency_seconds_bucket[30m])) > 120
```

A scrape config is in [`deploy/prometheus.example.yml`](../deploy/prometheus.example.yml).

## Logs

Structured JSON (pino). Every line about a sponsorship request carries the three fields from PRD §25 — plus the
internal row id, which is what the admin API and the dashboard link by:

```
request_id       the DApp's idempotency key
application_id   which application
transaction_id   the identifier to watch on the indexer (once submitted)
id               the sponsorship_requests row
user_id          the DApp's user identifier
```

`AETHERDUST_LOG_LEVEL` controls verbosity. Secrets are redacted (`authorization` headers, `*.seed`, `*.secret`,
`*.token`) and the configuration is never logged raw. To follow one request end to end across both processes:

```bash
docker compose -f deploy/docker-compose.yml logs api worker | grep '"request_id":"dapp:user-42:claim:7"'
```

## The dashboard

`:8090` (nginx, proxies the api so it is same-origin). Overview refreshes every 10 s; Requests and Usage poll while
open. It reads only `/v1/admin/*` with the operator token — never Midnight, never the database directly.
