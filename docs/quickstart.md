# Quickstart

Three environments, in the order you should use them: **mock** (no chain, seconds), **local `undeployed`** (a real
chain on your machine, minutes), **preprod** (the public testnet, plus a faucet wait).

Every command below assumes the repo root and `deploy/.env` copied from `deploy/.env.example`.

---

## 1. Mock sponsor — no Midnight at all

Nothing is proved, nothing is submitted; the mock adapter invents a fee and confirms after a delay. Use it to build
and test everything that is not the chain: policies, budgets, limits, idempotency, the dashboard.

```bash
cp deploy/.env.example deploy/.env       # set AETHERDUST_ADMIN_TOKEN to a long random string
docker compose -f deploy/docker-compose.yml up --build -d
docker compose -f deploy/docker-compose.yml run --rm api cli bootstrap \
  --name ExampleDApp --policy /app/scripts/demo-policy.json
#  → prints application_id and the API key, once
```

- API: <http://localhost:8080> · OpenAPI UI: <http://localhost:8080/docs>
- Dashboard: <http://localhost:8090> (sign in with `AETHERDUST_ADMIN_TOKEN`)
- End-to-end demo of approve / reject / budget / idempotency / status / usage:
  `AETHERDUST_API_KEY=ad_live_… scripts/demo.sh`

The mock adapter accepts `{"format":"mock", …}` transaction envelopes — real ledger bytes are also accepted and
inspected, it is only the sponsoring that is fake.

---

## 2. Local `undeployed` chain — real sponsorship, private network

A real node, indexer and proof server at the support-matrix versions, with a genesis-funded sponsor. This is where
you find out whether your policy and your DApp actually work.

In `deploy/.env`, uncomment the `local-midnight` block (it sets `AETHERDUST_SPONSOR_ADAPTER=midnight`, the service
URLs and the genesis seed) and set `AETHERDUST_INTERNAL_SECRET`. Then:

```bash
docker compose -f deploy/docker-compose.yml --profile local-midnight up --build -d
docker compose -f deploy/docker-compose.yml run --rm worker wallet status   # synced? DUST coins > 0?
```

The worker needs a minute: it syncs the wallet, and `dust_coins` must be greater than zero before anything can be
sponsored (each in-flight sponsorship holds one DUST coin). If it is zero, run `wallet register-dust`.

Without Docker: `spikes/sponsor-spike/deploy/native/stack.sh up` runs the same three services natively (images are
cached after the first run), then `pnpm dev:api` and `pnpm dev:worker`.

---

## 3. preprod — the public testnet

Public RPC and indexer, **your own** proof server, **your own** seed.

```bash
# 1. a seed (64 hex chars). Store it in deploy/.env as AETHERDUST_SPONSOR_SEED,
#    or better, mount a file and point AETHERDUST_SPONSOR_SEED_FILE at it.
docker compose -f deploy/docker-compose.yml run --rm worker wallet new-seed

# 2. the addresses this seed owns
docker compose -f deploy/docker-compose.yml run --rm worker wallet addresses
#    → fund the *unshielded* (mn_addr…) address from the preprod faucet

# 3. register the NIGHT for DUST generation (one transaction, pays its fee from projected DUST)
docker compose -f deploy/docker-compose.yml run --rm worker wallet register-dust --wait

# 4. bring the stack up
docker compose -f deploy/docker-compose.yml --profile testnet up --build -d
docker compose -f deploy/docker-compose.yml run --rm worker wallet status
```

Set `MIDNIGHT_NETWORK=preprod` and `MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300` in `deploy/.env`.

What to expect on a public network:

| | |
|---|---|
| First wallet sync | **1–2 hours** from scratch, and it repeats on every worker restart (no persisted wallet state yet). Plan restarts. |
| NIGHT → DUST | DUST starts generating after `register-dust` confirms, and grows toward a cap. The first spendable DUST appears within a minute or two on a quiet chain. |
| Fees | Dynamic. On an empty preprod they round to **1 SPECK**; `AETHERDUST_DUST_FEE_OVERHEAD_SPECKS` must stay > 0 (see [runbooks](runbooks.md#fees-round-to-zero)). |
| Throughput | One in-flight sponsorship per DUST coin. Split NIGHT into more UTXOs to raise it. |

---

## 4. Point a DApp at it

```bash
docker compose -f deploy/docker-compose.yml run --rm api cli create-app --name MyDApp
docker compose -f deploy/docker-compose.yml run --rm api cli create-key --app <id> --env live
docker compose -f deploy/docker-compose.yml run --rm api cli set-policy --app <id> --policy my-policy.json
```

…or do the same on the dashboard's **Applications** and **Policy** pages. Then follow the
[integration guide](integration.md); the policy fields are in the [policy reference](policy.md).

---

## Verifying a deployment

```bash
curl -s localhost:8080/healthz                                    # {"ok":true,"adapter":"midnight","network":"preprod"}
curl -s -H "Authorization: Bearer $ADMIN" localhost:8080/v1/admin/wallet | jq .live
curl -s -H "Authorization: Bearer $ADMIN" localhost:8080/metrics | grep aetherdust_sponsor_wallet
```

`live` is `null` when the worker is unreachable or still syncing — the dashboard then falls back to the last
snapshot, which is written every `AETHERDUST_WALLET_SNAPSHOT_S` seconds.
