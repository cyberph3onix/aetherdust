# AetherDust — MVP Implementation Plan

**Status:** v1.3 (Phase 0 complete — §0.1; Phase 1 complete — §0.2; **Phase 2 complete** — §0.3) · **Date:** 2026-09-20 · **Source spec:** `prd.md` v1.0
**Scope of this document:** architecture + phased build plan. No implementation code.

---

## 0. Executive summary

AetherDust is feasible on today's Midnight stack **without any protocol modification**, because Midnight's transaction model already supports "one party builds and signs, another party pays the DUST fee":

1. The user's wallet balances and signs its transaction **with `payFees: false`** (DApp connector spec, v4).
2. The DApp posts the resulting sealed `FinalizedTransaction` bytes to AetherDust.
3. AetherDust's sponsor wallet calls `WalletFacade.balanceFinalizedTransaction(tx, keys, { tokenKindsToBalance: ['dust'] })`, signs, proves the DUST spend on its own proof server, `merge`s it with the user's transaction, and submits.

Everything else in the PRD (auth, policy, budgets, limits, rate limiting, idempotency, state machine, dashboard, Docker) is ordinary backend engineering that can be built and fully tested against a **mock sponsor adapter** while the real adapter is validated on the `undeployed` local network.

The single biggest risk is not "does the API exist" (it does — verified in source) but **operational behaviour of a single sponsor DUST wallet under load** (DUST is a UTXO self-spend; pending-spend tracking; proving latency; TTL/grace-period windows; the ledger v8→v9 hard fork). Phase 0 is a spike that measures exactly that before we commit to the control-plane design.

---

### 0.1 Phase 0 outcome (2026-09-20)

Phase 0 ran on a local `undeployed` stack at support-matrix versions (node 1.0.2, indexer 4.3.5, proof-server 8.1.0, run natively
without Docker via `spikes/sponsor-spike/deploy/native/stack.sh`). **A 0-NIGHT / 0-DUST user had `counter.increment` sponsored and
confirmed on-chain three times**; V1–V6 and V8–V12 are answered in `spikes/sponsor-spike/SPIKE_REPORT.md`. Corrections to this plan:

| Was | Now |
|---|---|
| Pre-flight uses `WalletFacade.validateTransaction` (C7, §5, §11) | **Not in facade 4.1.0 (stable v8)** — only on `main`/5.0-beta (ledger-v9). Use our `LedgerInspector` + ledger `Transaction.wellFormed(LedgerState.blank(net), {verifySignatures, enforceLimits, verifyNativeProofs}, now)`. Contract proofs cannot be verified pre-submission on v8; a bad proof costs ~1.5 s CPU and 0 DUST. |
| Single-writer worker, parallelism TBD (V4) | Parallelism is **bounded by the sponsor's DUST coin count** (= registered NIGHT UTXOs); `could not balance dust` is retryable. Worker concurrency = `min(config, availableCoins)`. |
| Restart recovery TBD (V5) | In-flight coin locks are **process-local**; on restart **drain persisted `merged_tx_bytes` first** (resubmit is idempotent: deduped or node code 193), then resume. |
| Confirmation key TBD (V2) | Watch by **transaction identifier** (`identifiers.at(-1)` returned by submit, or the user's own identifier which survives the merge); tx hash does not resolve in the indexer. |
| Fee margin TBD (V3) | `estimateTransactionFee` matched actual `vFee` exactly; fees are **dynamic** (block fullness). Reserve = estimate × small margin; set `costParameters.additionalFeeOverhead` ≈ 0 (the official example's 0.3 DUST inflates fees ~80×+). |
| Sync vs async (H2) | Facade `submitTransaction` blocks 16–20 s (waits `'Finalized'`). Worker will use `facade.submissionService.submitTransaction(tx, 'Submitted'|'InBlock')` and confirm via indexer. API: `202` + long-poll/GET. |
| Node error mapping unknown | `1010 Invalid Transaction: Custom error: N` — table in `spikes/sponsor-spike/fixtures/node-1.0.2-error-codes.rs` (138 unpaid fee, 193 replay, 196 dust double-spend, 242 TTL expired, 166 wrong network). |
| Dependency set | Pin `ledger-v8@8.1.0` **and** `onchain-runtime-v3@3.0.0` via pnpm overrides (duplicate WASM copies break `instanceof`); `InMemoryTransactionHistoryStorage` from `wallet-sdk-abstractions` with facade `WalletEntrySchema`; indexer path `/api/v4/graphql`. |

### 0.2 Phase 1 outcome (2026-09-20)

Delivered: pnpm monorepo (`packages/core|config|db|midnight`, `apps/api|worker`), Postgres schema + migration runner,
Fastify API with zod validation and generated OpenAPI (`/docs`), scrypt-hashed API keys + admin token, sliding-window
rate limits (submission vs read buckets), idempotency on `(application, request_id)` **and** `tx_hash`, real ledger-v8
inspector on Phase 0 fixtures, policy engine (R1–R9), atomic reserve/settle/release budgets (global + per-user, UTC
periods), state machine with audit events, single-writer worker with `SKIP LOCKED` claims and crash recovery, mock
sponsor adapter with failure injection and DUST-coin-bounded concurrency, operator CLI, Dockerfile + compose, CI.
Tests: 24 unit + 27 integration (real Postgres) covering AC3–AC10 plus failure paths, recovery and 20-way concurrency.
Decisions taken on §23: `202` + `?wait=` long-poll; multi-call rejected unless `allow_multiple_calls`; calendar-UTC
periods; `user_id` stored raw. Deviation from §3: repositories use plain `pg` + SQL (no ORM) — the two critical
statements (reservation guard, claim) are clearer as SQL. Tests use `embedded-postgres` when no DB URL is given.
Phase 1 review (2026-09-20) closed four gaps before sign-off: R7 (network id) is now enforced at the API edge via
`wellFormed` on real bytes (`INVALID_REQUEST`, ~10 ms/tx; expired TTL → `PREFLIGHT_FAILED`); `OVERSPEND` audit event on
settle when actual > reserved (§9); credential/ip rate limits moved to `onRequest` so they run before body parsing (§13;
the per-user limit stays post-validation since it is keyed on the body); a timing race in the `?wait=` test was fixed.
Fee estimation stays in-process (mock) — the worker estimate RPC (§3 option A) is a Phase 2 deliverable.

### 0.3 Phase 2 outcome (2026-09-20)

Delivered: `MidnightSponsorAdapter` (`packages/midnight/src/midnight/`) — seed → `WalletFacade`, sync, `estimateTransactionFee`,
`balanceFinalizedTransaction(['dust'])` → `signRecipe` → `finalizeRecipe` → **structural post-merge check** (user calls
unchanged, exactly +1 `DustSpend`, user identifier preserved, no negative imbalance — replaces the `enforceBalancing`
pre-flight, which cannot run against a blank v8 state), submit (facade `Finalized` path by default, `submissionService`
otherwise), confirmation by **identifier** via the indexer, node error mapping (Effect cause walk → `1010 … Custom error: N`;
`193`/`1013` = already applied → confirm by identifier), wallet status with `maxInFlight` = free DUST coins. Worker: private
`/internal/estimate` + `/internal/health` RPC (shared secret, §3 option A), periodic **reconciler** for `TIMEOUT`/`UNKNOWN`
(confirm / fail / expire+release after TTL + grace), `SPONSOR_BALANCE_LOW` floor, `wallet` CLI (`status`, `addresses`,
`register-dust`, `new-seed`). API: `RemoteSponsorAdapter` (local inspection, remote estimate/health; the api process never
loads wallet code). Compose profiles `local-midnight` (node 1.0.2 + indexer 4.3.5 + private proof server 8.1.0) and
`testnet`; `docker-compose.e2e.yml` override for host-side e2e. CI: nightly/on-demand e2e job.
**E2E (test/e2e, on `undeployed`):** in-process mode (api + worker inside the test, 9 + 1 tests, ~3.5 min): AC1/AC2 with a
real 0-NIGHT/0-DUST user wallet calling `counter.increment` through api → worker → chain (counter incremented, budget
settled to the real `vFee`, user still 0/0); **AC3–AC10 all on real bytes** (policy, per-tx fee, global budget, per-user
allowance, rate limit, idempotency, status tracking); kill-and-restart (persisted merged bytes resubmitted by a fresh
worker; replay of the same bytes harmless); reconciler (a missed confirmation settled from the indexer by identifier);
`SPONSOR_BALANCE_LOW`; **operator onboarding** (fresh seed: `fund` 100 NIGHT → arrives in ~23 s → `register-dust` → first
DUST ~29 s later → fee estimates work). Deployed mode (`pnpm test:e2e:deployed`, 7 tests) drives the real compose
containers (`--profile local-midnight`, `deploy/e2e.env`) and **SIGKILLs the worker container** mid-sponsorship in both
windows (during `SPONSORING` → re-queued; during `SUBMITTED` → persisted bytes resubmitted) — both confirm after restart.
README quickstart (mock profile + `scripts/demo.sh`) verified in Docker. Nightly CI runs both e2e modes. Unit/integration: 35 + 32.
Findings that changed the design: (a) `UNIQUE(tx_hash)` must **exclude `REJECTED`** rows (migration `0002`) — a policy
rejection consumes nothing and the DApp's already-signed tx must be sponsorable after the operator fixes the policy;
(b) two identical calls sealed within the same second are byte-identical (same hash, a replay on-chain) — expected, but the
e2e user provider now varies the TTL; (c) the node answers `1013 Transaction Already Imported` (not a silent dedupe) when the
facade resubmits right after inclusion; (d) compose infra: the standalone indexer requires `APP__INFRA__SPO_NODE__*` even on
`undeployed`, and the proof-server image has no shell (no exec health check possible — the worker retries instead); (e) the
Dockerfile had never copied `deploy/entrypoint.sh`/`scripts/`. Deferred to Phase 3/5: dashboard wallet page, `preprod` recorded run.

## 1. Midnight research findings

### 1.1 Evidence base (what was actually inspected)

| Source | What it establishes |
|---|---|
| `docs.midnight.network/concepts/dust-architecture` | DUST is "a shielded capacity resource only for gas. You cannot transfer DUST between users." DUST spend = 1‑to‑1 self‑spend with a fee declaration (`DustSpend { vFee, oldNullifier, newCommitment, proof }`). Generation ~1 week to cap; decays after backing NIGHT is spent. |
| `docs.midnight.network/tokens/overview` | `1 NIGHT = 10^6 STAR`, `1 DUST = 10^15 SPECK`. NIGHT is always unshielded. Registration for DUST generation required (cross-chain path ~12h; ~5 min on local). |
| `docs.midnight.network/guides/networks-and-environments` | Networks: `undeployed` (local, genesis‑funded), `preview`, `preprod`, `mainnet` (live). Public RPC/indexer URLs, faucets for preview/preprod. |
| `docs.midnight.network/relnotes/support-matrix` (today) | Ledger 8.x on all nets · Node 1.0.2 · Proof Server 8.1.0 · Indexer 4.3.x · Wallet SDK 1.2.0 · Midnight.js 4.1.1 · DApp Connector API 4.0.1 · Compact compiler 0.31.1. |
| `midnightntwrk/midnight-dapp-connector-api` (`SPECIFICATION.md`, `src/api.ts`) | `balanceUnsealedTransaction(tx, { payFees })`, `balanceSealedTransaction`, `makeTransfer`, `makeIntent` all take `payFees` (default `true`). Spec: *"If it is set to false, wallet must not issue `DustSpend` to pay fees in the transaction … the DApp might be implemented in a way, which expects the fee payment to be performed by a dedicated service."* Returned tx is "cryptographically bound, contains needed signatures, and contains needed proofs. It might contain imbalances though." |
| `midnightntwrk/midnight-wallet` `packages/facade/src/index.ts` (**`main` branch** — ahead of the published 4.1.0; `validateTransaction` is not in 4.1.0) | `WalletFacade.init(...)`, `start(shieldedKeys, dustKey)`, `balanceFinalizedTransaction(tx, {shieldedSecretKeys, dustSecretKey}, {ttl, tokenKindsToBalance})`, `balanceUnboundTransaction(...)`, `signRecipe(recipe, signSegment)`, `finalizeRecipe(recipe)` (for `FINALIZED_TRANSACTION` recipes: proves the balancing tx then `originalTransaction.merge(finalizedBalancing)`), `submitTransaction(tx) → identifiers.at(-1)`, `validateTransaction(tx, {flags:{enforceBalancing, verifySignatures, enforceLimits}, blockData})`, `calculateTransactionFee`, `estimateTransactionFee(tx, dustSecretKey, {ttl})`, `registerNightUtxosForDustGeneration`, `waitForGeneratedDust`, `state()` / `waitForSyncedState()`, `queryTxHistoryByHash`. |
| `@midnight-ntwrk/ledger-v8@8.1.2` `ledger-v8.d.ts` | `Transaction.serialize()` / `Transaction.deserialize('signature','proof','binding', bytes)`; `tx.intents: Map<number, Intent>`; `Intent.actions: (ContractCall \| ContractDeploy \| MaintenanceUpdate)[]`; `ContractCall.address`, `.entryPoint`; `Intent.dustActions.spends[].vFee`; `Intent.ttl`; `tx.fees(params)`, `feesWithMargin(params, margin)`, `imbalances(segment, fees)`, `wellFormed(state, strictness, tblock)`, `transactionHash()`, `identifiers()`, `merge()`. |
| `@midnight-ntwrk/midnight-js-types@4.1.1` / `-contracts@4.1.1` | Pipeline seams: `proofProvider.proveTx(Unproven→Unbound)`, `walletProvider.balanceTx(Unbound→Finalized)`, `midnightProvider.submitTx(Finalized→TransactionId)`; `submitTx` then blocks on `publicDataProvider.watchForTxData(txId)`; `submitTxAsync` returns the id immediately. |
| `midnightntwrk/example-counter` `counter-cli/src/api.ts`, `standalone.yml` | Official pattern for building a server-side wallet from a hex seed (HD roles `Zswap`, `NightExternal`, `Dust`), bridging facade → midnight-js providers, registering NIGHT UTXOs for DUST, genesis seed `000…0001` on `undeployed`, Docker images `midnightntwrk/midnight-node`, `midnightntwrk/indexer-standalone`, `midnightntwrk/proof-server`. Also documents a `signRecipe` proof-marker bug workaround. |
| npm registry (today) | `@midnight-ntwrk/ledger-v8@8.1.2`; `@midnightntwrk/wallet-sdk-facade@4.1.0` (latest), `5.0.0-beta.3`; `@midnight-ntwrk/midnight-js-*@4.1.1` (latest), `5.0.0-beta.9`; `dapp-connector-api@4.0.1` (latest), `4.1.0-beta.1`. Packages are migrating from `@midnight-ntwrk` to `@midnightntwrk` scope. |
| Ledger release notes | 8.1.2 (Sep 3 2026, security/deserialization strictness); 9.1.0-rc (Sep 2026, "tie Dust registration to block time"); 10.0 alpha. midnight-js 5.0-beta introduces "eras" (v9 live, v8 retained) → a hard fork is being prepared. |
| Community (dev.to, 3 articles) | Corroborate the exact two-phase recipe above. **Not** treated as authoritative; used only to confirm the flow matches SDK source. Community figures: ~0.001–0.01 DUST per tx. |

**Important nuance:** there is **no dedicated official docs page for fee sponsorship**. The primitives are official (connector spec's `payFees` clause, facade `tokenKindsToBalance`), and the facade's `FINALIZED_TRANSACTION` recipe type exists precisely to balance someone else's sealed transaction. The end-to-end recipe is assembled from those primitives and must be proven by our own spike (Phase 0).

### 1.2 Classification

#### A. Confirmed Midnight capabilities (verified in official spec/source)
- C1. DUST is non-transferable; fees are paid by a `DustSpend` inside the transaction. Sponsorship = the sponsor contributing the `DustSpend`, not "sending DUST".
- C2. A wallet can balance/sign a tx **without** paying fees (`payFees: false`) and return a bound, signed, proven tx with a fee imbalance.
- C3. `WalletFacade.balanceFinalizedTransaction(tx, keys, { tokenKindsToBalance: ['dust'] })` produces a DUST‑only balancing transaction for a third party's `FinalizedTransaction`; `finalizeRecipe` proves it and merges; `submitTransaction` submits.
- C4. Transactions serialize/deserialize deterministically (`serialize()` / `Transaction.deserialize('signature','proof','binding', …)`), so bytes are a valid wire format between DApp → AetherDust.
- C5. A received transaction can be **inspected offline** (no network) for contract address(es), entry point(s), deploys/maintenance updates, intent TTLs, and presence of DUST actions.
- C6. Fees are computable before spending: `tx.fees(params)` / `feesWithMargin`, and facade `estimateTransactionFee(tx, dustKey)` includes the sponsor's own balancing overhead.
- C7. ~~`validateTransaction`~~ — **exists only on facade `main`/5.0-beta (ledger-v9)**, not in the stable 4.1.0. On v8 the equivalent is the ledger's `Transaction.wellFormed(refState, WellFormedStrictness, tblock)` (network-id, TTL, signatures, limits, native proofs), which Phase 0 validated on real transactions.
- C8. midnight-js has clean seams (`WalletProvider.balanceTx`, `MidnightProvider.submitTx`) so a client SDK can plug into existing DApps without forking midnight-js.
- C9. Server-side sponsor wallet construction from a seed (HD roles), NIGHT-UTXO DUST registration, sync, and DUST balance/cap querying are all supported (`example-counter` pattern; facade API).
- C10. Local `undeployed` network with pre-funded genesis wallet and Docker images for node/indexer/proof server exists for CI/e2e.
- C11. Mainnet is live; preview/preprod have faucets.

#### B. Product hypotheses (PRD assumptions we adopt, not guaranteed by Midnight)
- H1. A DApp-provided opaque `user_id` is an acceptable per-user limit key for MVP (PRD §22, §5.8). Not Sybil-resistant.
- H2. Sync request/response ("approved + transaction_id") is acceptable UX even though sponsoring includes a ZK proof round-trip (seconds). We will support both sync-with-timeout and async polling.
- H3. Operators will run **their own proof server** for the sponsor wallet (required for security; see §18).
- H4. One sponsor wallet per deployment is enough for MVP throughput.
- H5. Operators accept budgets denominated in DUST with `bigint` SPECK precision (1 DUST = 10^15 SPECK).
- H6. The DApp is trusted to *claim* contract/entry point, but AetherDust **verifies** them against the transaction; mismatch = reject.

#### C. Must prototype / validate (Phase 0 spike)
- V1. End-to-end: user wallet `balance…(tokenKindsToBalance: ['shielded','unshielded'])` → sponsor `balanceFinalizedTransaction(['dust'])` → `signRecipe` → `finalizeRecipe` → `submitTransaction` → confirmed on `undeployed`, for a real contract call (counter contract).
- V2. Which identifier to watch for confirmation of the **merged** tx (`transactionHash()` vs `identifiers()`; does the user's original id still resolve in the indexer?). Which id `submitTransaction` returns (`identifiers.at(-1)`).
- V3. Actual sponsored fee extraction: sum of `vFee` over the sponsor's `dustActions.spends` in the merged tx vs `estimateTransactionFee` — measure estimate error; decide reserve margin.
- V4. Concurrency: N parallel sponsorships from one DUST wallet — does the dust wallet's pending tracking allow chaining, or must we serialize? Throughput/latency numbers (proving time on the proof server for a DustSpend).
- V5. Failure & recovery: kill the worker mid-flight; on restart, does `pendingTransactionsService`/tx history reconcile? What we must persist ourselves.
- V6. TTL/grace windows: min acceptable `intent.ttl` remaining; DUST grace period (`dustGracePeriodSeconds`) impact on how "old" a user tx can be.
- V7. Lace (browser) with `payFees: false` via `balanceUnsealedTransaction` on preview/preprod: does the shipped Lace honour the spec (0-DUST user)? (Spec is normative; implementation must be tested.)
- V8. Facade 4.1.0: is the `signRecipe` "pre-proof marker" bug (worked around in `example-counter`) still present when the *sponsor* signs a `FINALIZED_TRANSACTION` recipe?
- V9. Does `validateTransaction({ enforceBalancing: true })` after merge reliably catch the case where a user tx carries non-DUST imbalances (so the sponsor never accidentally covers NIGHT/tokens)? Also confirm `tokenKindsToBalance: ['dust']` never touches other token kinds.
- V10. Rejecting a user tx that already contains `dustActions` (user already paid / partial) — desired policy behaviour.
- V11. Adversarial inputs: malformed bytes, wrong network id, huge tx (byte limit), tx with `ContractDeploy`, multi-intent tx with one non-allowlisted call — confirm inspection + `validateTransaction` reject each before any sponsor resource is used.
- V12. Ledger v9 hard-fork timeline for preview/preprod/mainnet; migration cost of pinning v8.

### 1.3 PRD assumptions that need adjustment (flagged)

| PRD statement | Issue | Adjustment |
|---|---|---|
| "Sponsor wallet provides the required DUST" / "sponsorship amount" | DUST cannot be transferred. The sponsor *adds a DustSpend to the user's tx*. | Wording only; model "sponsored DUST" = fee paid by sponsor's `DustSpend(s)` (`vFee`). |
| `transaction.payload: "..."` (§18.1) | Must be a specific object: hex/base64 of a **sealed** `Transaction<SignatureEnabled, Proof, Binding>` produced with `payFees: false`. | Define `transaction: { format: "midnight-ledger-v8", encoding: "hex", bytes: "…" }`. |
| `contract`, `entry_point` in request | These are *claims*. | Keep for ergonomics/logging; **derive** the truth from the tx; reject on mismatch (fail closed). |
| `requested_dust` (§20) | The user doesn't request an amount; the fee is computed. | Replace with `estimated_fee_specks` (pre-flight) and `actual_fee_specks` (settled). |
| Sync `status: "approved", transaction_id` (§18.1) | Proving + submission takes seconds; a synchronous 200 hides a multi-step pipeline. | `POST` returns `202` with `status` and a `request_id`; optional `?wait=<ms>` long-poll up to a bound; `GET` for status. |
| Budgets like `0.1 DUST` | Need exact arithmetic. | Store SPECK `bigint` (`NUMERIC(39,0)` in Postgres); accept decimal DUST strings at the API/dashboard edge. |
| "sponsor wallet balance" (§19.1) | DUST balance is time‑dependent (generation/decay) and capped by registered NIGHT. | Show `dust.balance(now)`, `dust.cap`, NIGHT balance, registered-UTXO status, and time-to-refill. |
| "Rate limit before sponsorship execution" | Fine — but also required *before deserialization* (CPU DoS vector). | Rate-limit + body-size limit precede WASM deserialization. |
| "Pre-flight … request has not already been processed" | Also must guard against **the same transaction bytes** under different `request_id`s. | Idempotency on `(application_id, request_id)` **and** uniqueness on `tx_hash`. |
| State machine (§16) lacks expiry/on-chain failure | Intent TTL and dust grace period can expire in flight; submitted tx can be dropped. | Add `EXPIRED`, `SUBMISSION_FAILED`, `TIMEOUT` (already listed) as terminals from `SUBMITTED`, plus reconciliation job. |
| Docker: "Policy Engine" as a separate container (§26) | Policy engine is a pure library; a separate container adds nothing. | Containers: `api`, `worker`, `dashboard`, `postgres`, `proof-server` (+ optional local `node`/`indexer` profile). |

---

## 2. Product architecture

```
                       ┌──────────────────────────── DApp (browser) ────────────────────────────┐
  User (Lace) ◄──────► │ midnight-js providers                                                   │
   balanceUnsealed     │   proofProvider  → proves contract call                                 │
   (payFees:false)     │   walletProvider → connector.balanceUnsealedTransaction(tx,{payFees:false})
   sign                │   midnightProvider (AetherDust client SDK) → POST /v1/sponsorship/requests
                       └────────────────────────────────────────────┬───────────────────────────┘
                                                                    │ sealed tx bytes + claims
                                                                    ▼
┌──────────────────────────────── AetherDust (self-hosted) ───────────────────────────────────┐
│  api (public)                                  worker (private; holds sponsor keys)          │
│  ├ auth (API key)                              ├ claims RESERVED requests from Postgres      │
│  ├ rate limit (pre-parse)                      ├ WalletFacade (shielded/unshielded/dust)     │
│  ├ schema + size validation                    ├ validateTransaction (pre-flight, strict)    │
│  ├ idempotency                                 ├ balanceFinalizedTransaction(['dust'])       │
│  ├ tx inspection (ledger WASM, offline)        ├ signRecipe / finalizeRecipe (proof server)  │
│  ├ policy engine (pure)                        ├ validateTransaction (enforceBalancing)      │
│  ├ fee estimate (via worker RPC or shared lib) ├ submitTransaction → node                    │
│  ├ budget reservation (atomic, Postgres)       ├ confirmation watcher (indexer)              │
│  └ state machine + audit                       └ settle/release budget, reconcile on restart │
│                                                                                              │
│  postgres (requests, policies, budgets, usage, audit)      dashboard (static SPA)            │
│  proof-server (sponsor's own, private network)                                               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                    │
                                                                    ▼
                                            Midnight node (RPC) · Indexer (GraphQL)
```

Design principles applied:
- **Policy before money**: all rejection paths happen in `api` before a request is handed to `worker`; budget is *reserved* before sponsoring and *settled/released* after.
- **Key isolation**: only `worker` has the sponsor seed; `api` never loads it. The two communicate only through Postgres rows.
- **Truth from the transaction**: allowlists are enforced on the deserialized tx, not on request claims.
- **Fail closed**: any error in inspection, policy, estimation or validation → `REJECTED`/`PREFLIGHT_FAILED`, never sponsor.

---

## 3. Backend architecture

**Language/runtime:** TypeScript on Node 22 (mandatory — the Midnight SDK is TS + WASM). pnpm workspaces monorepo.

```
aetherdust/
  apps/
    api/            Fastify HTTP API (public)
    worker/         sponsorship worker (private; same Docker image, different entrypoint)
    dashboard/      React + Vite SPA (static)
  packages/
    core/           pure domain: policy engine, budget math, state machine, error codes (no I/O, no Midnight deps)
    db/             Drizzle ORM schema + migrations + repositories
    midnight/       SponsorAdapter interface + `LedgerInspector` (offline tx parsing) + real WalletFacade adapter + mock adapter
    client/         @aetherdust/client — TS SDK: MidnightProvider impl + REST client
    config/         zod-validated env schema shared by api/worker
  examples/
    example-dapp/   counter-based DApp using Lace + @aetherdust/client
  deploy/
    docker-compose.yml, docker-compose.local-midnight.yml (undeployed stack), Dockerfile
```

Key libraries: Fastify 5, zod, Drizzle ORM (Postgres), pino, `@midnight-ntwrk/ledger-v8` (pinned 8.1.x), `@midnightntwrk/wallet-sdk-facade@4.1.0` (+ shielded/unshielded/dust/hd/address-format at the versions facade 4.1.0 pins), `@midnight-ntwrk/midnight-js-*@4.1.1` (client + confirmation watcher), OpenAPI generated from zod schemas, Vitest, Testcontainers.

**Why two processes (api/worker)?** Security boundary (keys), and the sponsor wallet is stateful (sync, pending spends) and must be a **single writer** — a worker with one `WalletFacade` instance and an in-process serial queue per sponsor wallet is the simplest correct design. `api` can scale horizontally later; `worker` is a singleton per sponsor wallet.

**api ↔ worker contract:** Postgres table `sponsorship_requests` is the queue (`status='RESERVED'` rows claimed with `FOR UPDATE SKIP LOCKED`). Fee *estimation* needs ledger parameters (`blockData`) and the dust wallet; MVP option A: `api` calls a tiny internal HTTP endpoint on `worker` (`POST /internal/estimate`, network-private, mTLS/shared secret) — keeps the wallet in one process. Option B: `api` uses `LedgerParameters.initialParameters()` offline and a configured margin. **Pick A** (accurate, still keeps keys in worker); B is the fallback if latency is an issue.

---

## 4. Frontend (dashboard) architecture

- React 18 + Vite + TypeScript, TanStack Query, TanStack Table, Recharts (usage charts), Tailwind. No SSR needed.
- Served as static files from its own nginx container (or from `api` under `/dashboard` in single-container mode).
- Auth: operator **admin token** (`AETHERDUST_ADMIN_TOKEN`, separate from DApp API keys) sent as `Authorization: Bearer`; stored in memory/sessionStorage only.
- Pages: Overview (wallet DUST balance/cap, NIGHT, budget gauges, success/reject counts), Requests (table + detail drawer with full audit trail), Policy (editor with validation + "dry-run against last N requests"), Usage (time series, by contract / entry point / user, rejection reasons), Applications (create/rotate/revoke API keys — secret shown once).
- Reads only from `/v1/admin/*` endpoints; never touches Midnight directly.

---

## 5. Midnight integration (packages/midnight)

Interface (the only place Midnight types are allowed outside `packages/midnight`):

```
SponsorAdapter
  inspect(txBytes): TxSummary                      // offline, ledger WASM; used by api
  estimateFee(txBytes): { feeSpecks, ledgerParamsHash, blockHeight }   // worker
  sponsor(txBytes, ttl): { mergedTxBytes, txHash, identifiers, actualFeeSpecks }  // worker: balance(['dust'])→sign→prove→merge→validate
  submit(mergedTxBytes): { txHash }                // worker
  watch(txHash|identifier, deadline): CONFIRMED | FAILED | TIMEOUT      // worker
  walletStatus(): { dustBalance, dustCap, nightBalance, registeredUtxos, synced, network }

TxSummary
  network_id, tx_hash, identifiers[], byte_length
  calls[]: { address, entry_point, segment }
  deploys: number, maintenance_updates: number
  has_dust_actions: boolean
  min_intent_ttl: Date | null
  has_non_dust_imbalance: boolean   // from imbalances(); informational
```

Real implementation notes (all verified APIs):
- Build wallet: HD seed → `Roles.Zswap/NightExternal/Dust`; `ZswapSecretKeys.fromSeed`, `DustSecretKey.fromSeed`, `createKeystore(...)`; `WalletFacade.init({ configuration, shielded, unshielded, dust })`; `start()`; `waitForSyncedState()`. Gate on `dust.state.progress.isStrictlyComplete()` not only the top-level `isSynced` (known footgun on quiet chains).
- Sponsor path: `validateTransaction(tx, {flags:{enforceBalancing:false, verifySignatures:true, enforceLimits:false}})` → `balanceFinalizedTransaction(tx, keys, {ttl, tokenKindsToBalance:['dust']})` → `signRecipe(recipe, unshieldedKeystore.signData)` → `finalizeRecipe` (proof server) → `validateTransaction(merged, {flags:{enforceBalancing:true, verifySignatures:true, enforceLimits:true}, blockData: recipe.blockData})` → `submitTransaction`.
- Fee: `estimateTransactionFee(tx, dustSecretKey, {ttl})` for pre-flight; actual = Σ `vFee` of sponsor-added `DustSpend`s (V3 confirms).
- Confirmation: midnight-js `indexerPublicDataProvider.watchForTxData(id)` with our own deadline, plus facade tx-history (`queryTxHistoryByHash`) as a cross-check. (V2 decides which id.)
- Startup ops: check NIGHT UTXOs registered for DUST; expose `registerNightUtxosForDustGeneration` as a CLI command (`aetherdust wallet register-dust`), not an automatic action.
- Version pinning: ledger v8 line only; single `ledger.ts` re-export module so a v9 migration touches one file. Do not adopt midnight-js 5.0-beta / facade 5.0-beta until preprod moves.

Mock implementation: deterministic `TxSummary` from a JSON "fake tx" envelope, configurable fee, configurable failure injection (`estimate_fail`, `prove_fail`, `submit_fail`, `never_confirm`), simulated confirmation delay. Used by all api/worker integration tests and by `docker compose --profile mock`.

---

## 6. Sponsor wallet architecture

- **Custody:** one hex seed (`AETHERDUST_SPONSOR_SEED` or `AETHERDUST_SPONSOR_SEED_FILE`), loaded only by `worker`, held in memory, zeroed on shutdown where the SDK allows (SecretKeysResource clears keys after use in current SDK). Never in Postgres, never in logs, never in any API response.
- **Roles used:** Dust key (fee spends), NightExternal/unshielded key (signs the balancing intent; owns the NIGHT UTXOs that generate DUST), Zswap key (required by facade `start()` even though shielded balancing is never requested).
- **Single writer:** exactly one `worker` process per sponsor wallet; internal queue processes `sponsor()` strictly sequentially (V4 may relax this). Multiple sponsor wallets = post-MVP.
- **Funding model:** operator holds NIGHT in the sponsor's unshielded address, registers UTXOs for DUST generation; capacity ≈ 5 DUST per NIGHT (docs), refills over ~1 week. Dashboard shows headroom; `SPONSOR_BALANCE_LOW` threshold configurable.
- **Health:** worker exposes `/healthz` (synced, dust balance ≥ min, proof server reachable, node reachable). `api` refuses new requests with `SPONSOR_UNAVAILABLE` (503) if worker heartbeat is stale.

---

## 7. Sponsorship relay (request pipeline)

```
POST /v1/sponsorship/requests
 1. auth (API key)                      → AUTH_FAILED
 2. rate limit (credential, ip)         → RATE_LIMITED           (before body parse beyond size limit)
 3. schema validation, size limit       → INVALID_REQUEST
 4. idempotency lookup                  → return existing (200) / DUPLICATE_REQUEST if payload differs
 5. inspect tx (offline)                → INVALID_REQUEST / PREFLIGHT_FAILED
 6. policy engine (allowlists, claims match, no deploys, no dust actions, ttl margin) → CONTRACT_NOT_ALLOWED …
 7. fee estimate (worker RPC)           → PREFLIGHT_FAILED / SPONSOR_UNAVAILABLE
 8. per-tx limit                        → TRANSACTION_LIMIT_EXCEEDED
 9. atomic budget reservation (global + user) → GLOBAL_BUDGET_EXCEEDED / USER_LIMIT_EXCEEDED
10. persist RESERVED + audit; respond 202 (or long-poll)
worker:
11. claim → SPONSORING → balance/sign/prove/merge/validate
12. SUBMITTED → watch → CONFIRMED (settle actual fee) | FAILED (release reservation)
```

Sponsor resources (DUST, proof server CPU) are only touched from step 11, after every rejection path.

---

## 8. Policy engine (packages/core)

Pure, synchronous, deterministic: `evaluate(policy, ctx) → Decision`.

Policy (versioned, stored as JSONB; every request records `policy_version` used):
```
enabled: boolean
contracts.allowlist: ContractAddress[]              // exact match; no wildcards in MVP
entry_points.allowlist: string[] | per-contract map // per-contract map preferred: { [address]: string[] }
allow_multiple_calls: boolean (default false)       // multi-call intents rejected unless enabled
limits: { global_budget_specks, per_user_budget_specks, max_fee_per_tx_specks, period: 'daily'|'hourly'|'rolling_24h' }
rate_limit: { requests_per_minute_per_credential, requests_per_minute_per_user, requests_per_minute_per_ip }
preflight: { min_ttl_remaining_seconds, max_tx_bytes, reject_if_dust_actions_present: true }
```

Rules (all fail closed):
- R1 `enabled` false → `POLICY_DISABLED`.
- R2 every `ContractCall` address ∈ allowlist → else `CONTRACT_NOT_ALLOWED`.
- R3 every `(address, entryPoint)` ∈ allowlist → else `ENTRY_POINT_NOT_ALLOWED`.
- R4 deploys/maintenance updates present → `CONTRACT_NOT_ALLOWED` (MVP never sponsors deploys).
- R5 claimed `contract`/`entry_point` ≠ derived → `INVALID_REQUEST` (claim mismatch).
- R6 `has_dust_actions` → `INVALID_REQUEST` (already fee-paid / tampered).
- R7 `network_id` ≠ configured → `INVALID_REQUEST`.
- R8 `min_intent_ttl - now < min_ttl_remaining` → `PREFLIGHT_FAILED (TTL_TOO_SHORT)`.
- R9 fee > `max_fee_per_tx` → `TRANSACTION_LIMIT_EXCEEDED`.
- Budget/user/rate checks live in their own modules but are invoked by the same orchestrator; ordering is fixed and tested.

Decision object carries `reason_code`, `rule_id`, evaluated inputs — written verbatim to the audit table.

---

## 9. Budget management

- Units: SPECK `bigint`; API/dashboard convert to/from decimal DUST strings.
- Period buckets: `budget_periods(application_id, scope('global'|'user'), scope_key, period_start, period_end, reserved_specks, settled_specks)`. Bucket for the current period is created lazily.
- **Reserve/settle/release**:
  - Reserve: single `UPDATE … SET reserved = reserved + :est WHERE reserved + settled + :est <= :limit RETURNING …` for global and for user, in one transaction; if either fails → rollback, reject. This is the only place budget is consumed, and it's atomic under concurrency.
  - Settle (on `CONFIRMED`): `reserved -= est; settled += actual`. If `actual > est` (bounded by margin), settle anyway and log an `OVERSPEND` audit event — the money is already spent on-chain; the budget must reflect reality.
  - Release (on failure/expiry): `reserved -= est`.
- Reservation margin: `est × (1 + margin)` where margin defaults from Phase‑0 measurements (`feesWithMargin` exists on the ledger for this reason).
- Operator can change limits at any time; new limits apply to subsequent reservations; existing buckets aren't rewritten.

---

## 10. Per-user sponsorship limits

- Key: `user_id` supplied by the DApp (opaque string, ≤128 chars, normalized). Stored hashed? No — needed for the dashboard; store as-is but document that DApps should send pseudonymous ids (PRD §22).
- Enforced as a `budget_periods` row with `scope='user'` (same atomic reserve path) and a per-user rate limit.
- Optional hardening (post-MVP, validate V-item): bind `user_id` to a signer key found in the tx's unshielded offer so a DApp can't rotate `user_id` for the same wallet.

---

## 11. Pre-flight validation

Two layers, both before any sponsor resource is used:
1. **Offline (api):** deserialization succeeds; byte size ≤ limit; `network_id` matches; structural summary; all §8 rules.
2. **Wallet-aware (worker, still pre-commit):** `validateTransaction(tx, {enforceBalancing:false, verifySignatures:true, enforceLimits:false})` (official recommended flags for this call site); `estimateTransactionFee`; sponsor DUST balance ≥ estimate + reserve floor → else `SPONSOR_BALANCE_LOW`.
3. **Post-merge, pre-submit:** `validateTransaction(merged, {enforceBalancing:true, verifySignatures:true, enforceLimits:true})` — guarantees the sponsor only paid fees and the tx is submittable.

Explicitly out of scope: contract-state simulation (PRD §13 "advanced simulation deferred").

---

## 12. Authentication

- **DApp API keys:** `ad_<env>_<keyId>_<secret>`; DB stores `key_id`, `secret_hash` (argon2id), `application_id`, `status`, `last_used_at`. Lookup by `key_id`, verify hash. Sent as `Authorization: Bearer`. Rotation = create new + revoke old.
- **Admin token:** single env-provided token for `/v1/admin/*` and the dashboard (MVP). Post-MVP: operator users.
- **Internal api→worker:** private network + shared secret header; worker never listens on a public interface.
- **Optional per-request HMAC** (post-MVP) to bind the body to the key.

## 13. Rate limiting

- Token bucket / sliding window keyed by `credential`, `user_id`, `ip`; limits come from the app's policy. Implementation: in-process store for single-instance MVP with a `RateLimitStore` interface; Redis implementation added only if `api` is scaled out. Applied *before* body deserialization (body size limit enforced by Fastify).
- Responses: `429` + `Retry-After` + `{ error: { code: 'RATE_LIMITED' } }`. Rate-limited requests are counted (metrics) but **not** persisted as sponsorship requests (avoid DB write amplification under abuse).

## 14. Transaction lifecycle / state machine

```
RECEIVED → AUTHENTICATED → POLICY_CHECK → BUDGET_CHECK → PREFLIGHT → RESERVED
   RESERVED → SPONSORING → SUBMITTED → CONFIRMED
Terminal failures (with reason_code):
   REJECTED           (from POLICY_CHECK / BUDGET_CHECK / PREFLIGHT; no reservation held)
   SPONSORING_FAILED  (balance/prove/validate failed; reservation released)
   SUBMISSION_FAILED  (node rejected; reservation released)
   EXPIRED            (TTL passed before submission; reservation released)
   TIMEOUT            (submitted, not confirmed by deadline; reservation *kept* until reconciler resolves)
   UNKNOWN            (reconciler could not determine; manual attention; reservation kept)
```
- Transitions are a table in `packages/core` (`from → to` allowed set) enforced in one repository method; every transition writes `request_events(request_id, from, to, reason_code, details, at)`.
- **Recovery on restart:** worker re-scans `SPONSORING` (→ retry if idempotent-safe: nothing submitted yet → `RESERVED`; if merged bytes were persisted and submission is uncertain → run reconciler), `SUBMITTED` (→ resume watching), `TIMEOUT` (→ reconciler polls indexer by id; resolves to `CONFIRMED`/`SUBMISSION_FAILED` when TTL has definitely passed).
- We persist the merged tx bytes and its ids *before* calling `submitTransaction` so "did we spend?" is always answerable (PRD §24).

## 15. Database schema (Postgres)

```
applications        (id, name, status, created_at)
api_keys            (id, application_id, key_id UNIQUE, secret_hash, status, created_at, revoked_at, last_used_at)
policies            (id, application_id, version, document JSONB, enabled, created_at)      -- append-only; latest = active
budget_periods      (id, application_id, scope, scope_key, period_start, period_end,
                     reserved_specks NUMERIC(39,0), settled_specks NUMERIC(39,0), limit_specks, UNIQUE(application_id, scope, scope_key, period_start))
sponsorship_requests(id, application_id, request_id, user_id, claimed_contract, claimed_entry_point,
                     tx_hash UNIQUE, tx_bytes BYTEA, tx_summary JSONB, policy_version,
                     estimated_fee_specks, reserved_specks, actual_fee_specks, status, reason_code, reason_detail,
                     merged_tx_bytes BYTEA NULL, submitted_tx_hash NULL, submitted_at, confirmed_at, block_height,
                     ttl_at, created_at, updated_at, UNIQUE(application_id, request_id))
request_events      (id, request_id FK, from_status, to_status, reason_code, details JSONB, created_at)   -- audit trail
usage_records       (id, request_id FK, application_id, user_id, contract, entry_point, specks, period_start, created_at) -- written on CONFIRMED
sponsor_wallet_snapshots(id, dust_balance_specks, dust_cap_specks, night_balance_stars, synced, taken_at)   -- for dashboard/metrics
```
Indexes: requests by `(application_id, created_at desc)`, `(status)`, `(user_id)`; usage by `(application_id, period_start)`, `(contract)`, `(entry_point)`.

## 16. Dashboard

Backed by `/v1/admin/*`: `GET overview`, `GET requests?filters`, `GET requests/:id` (with events), `GET/PUT policy` (creates new version), `GET usage?bucket=hour|day&group_by=contract|entry_point|user|reason`, `POST/DELETE api-keys`, `GET wallet`. Overview refresh every 10s; usage charts per PRD §19.4. Policy editor validates with the same zod schema as the API and shows a diff before save.

## 17. Docker deployment

`docker-compose.yml` services: `postgres`, `proof-server` (`midnightntwrk/proof-server:8.1.0`, internal network only), `api`, `worker`, `dashboard`. Profiles: `mock` (no Midnight; `SPONSOR_ADAPTER=mock`), `local-midnight` (adds `midnight-node` + `indexer-standalone` at support-matrix versions, `MIDNIGHT_NETWORK=undeployed`, genesis-seeded sponsor), `testnet` (`preview`/`preprod`, public RPC/indexer, own proof server).

Env (all validated at boot by `packages/config`):
```
AETHERDUST_DATABASE_URL, AETHERDUST_ADMIN_TOKEN, AETHERDUST_INTERNAL_SECRET
AETHERDUST_SPONSOR_ADAPTER=real|mock
AETHERDUST_SPONSOR_SEED | AETHERDUST_SPONSOR_SEED_FILE   (worker only)
AETHERDUST_MIN_SPONSOR_DUST, AETHERDUST_FEE_MARGIN, AETHERDUST_CONFIRM_TIMEOUT_S, AETHERDUST_MAX_TX_BYTES
MIDNIGHT_NETWORK=undeployed|preview|preprod|mainnet
MIDNIGHT_NODE_URL, MIDNIGHT_INDEXER_URL, MIDNIGHT_INDEXER_WS_URL, MIDNIGHT_PROOF_SERVER_URL
```
One image, two entrypoints (`api`, `worker`); migrations run by `api` on start (`AETHERDUST_AUTO_MIGRATE=true`) or via `pnpm db:migrate`.

## 18. Security boundaries

| Boundary | Control |
|---|---|
| Public internet → `api` | API keys, rate limits, body size, strict schemas, no sponsor secrets in process |
| `api` → `worker` | Private network, shared secret, only `estimate`/`health`; queue via Postgres |
| `worker` → proof server | **Private** network only. The proof server sees the balancing tx and witness data; a public proof server must never be used for the sponsor. |
| `worker` → node/indexer | Outbound only; can be public endpoints |
| Sponsor seed | Worker memory only; env/file injection; never logged (pino redaction of known keys + never log raw config) |
| User keys | Never received: only sealed, signed tx bytes |
| Tampering | Sponsor cannot alter the user's sealed intents; user cannot make the sponsor pay non-fee imbalances (`tokenKindsToBalance:['dust']` + `enforceBalancing` validation) |
| Replay | `UNIQUE(application_id, request_id)` + `UNIQUE(tx_hash)` |
| Audit | Append-only `request_events`; every decision records policy version + inputs |
| Dashboard | Admin token; CORS locked to dashboard origin |
| Supply chain | Pin exact versions; `pnpm audit` in CI; ledger 8.1.2 security patch minimum |

## 19. What can be mocked initially

- Entire `SponsorAdapter` (mock adapter) → lets Phases 1 and 4 be built/tested with no Midnight infra.
- Proof server, node, indexer (not present in `mock` profile).
- Lace / browser flow (example DApp can use a Node-side "user wallet" via facade `balanceUnboundTransaction(['shielded','unshielded'])` — the same thing Lace does with `payFees:false`).
- Confirmation watcher (mock timer).
- Ledger parameters for fee tests (`LedgerParameters.initialParameters()` is offline and real).

## 20. What absolutely requires real Midnight integration

- Sponsor wallet: seed → keys, sync, DUST registration, DUST balance/cap (`worker`).
- `balanceFinalizedTransaction(['dust'])` + `signRecipe` + `finalizeRecipe` (proof server) + `merge` + `submitTransaction`.
- Real fee estimation error and margin (needs a synced dust wallet + live block data).
- Confirmation semantics for a merged transaction (indexer).
- Restart/reconciliation behaviour (pending spends, TTL/grace expiry).
- Lace `payFees:false` in a browser against preview/preprod (AC1/AC2 as a user would experience them).
- Tx inspection is *real ledger code* but offline; it needs no network yet must still run against real serialized transactions (fixtures captured in Phase 0).

---

## 21. Testing strategy

| Level | Scope | Tooling | Runs |
|---|---|---|---|
| Unit | policy rules, budget math (bigint), state transitions, error mapping, key hashing, SPECK↔DUST conversion | Vitest, property tests for budget arithmetic | every commit |
| Integration | API + Postgres + mock adapter: idempotency, concurrency (parallel reservations never exceed limit), rate limits, restart recovery, audit trail | Vitest + Testcontainers (Postgres) | every commit |
| Ledger fixture tests | `LedgerInspector` against real serialized txs captured from Phase 0 (allowed, disallowed contract, deploy, with dust actions, malformed, wrong network) | Vitest, ledger WASM offline | every commit |
| E2E (local) | full stack on `undeployed`: user wallet (derived from genesis) → counter contract call with fees unpaid → AetherDust sponsor → CONFIRMED; plus AC3–AC9 against real txs | Docker compose `local-midnight`, Playwright for dashboard | nightly + on demand |
| E2E (testnet) | preview/preprod with Lace + example DApp | manual runbook, recorded | before each release |
| Security | secret-leak grep in logs, dependency audit, authz matrix tests | CI | every commit |
| Load (light) | 50–200 concurrent requests, single sponsor: latency, queue depth, no double-spend | k6 against mock + one real run | Phase 5 |

Acceptance criteria mapping: AC3–AC9 proven at integration level with the mock adapter *and* at E2E with real txs; AC1/AC2/AC10/AC11 at E2E; AC12 via a fresh-machine docker runbook in CI.

---

## 22. Phased build plan (each phase = working, testable increment)

### Phase 0 — Sponsorship spike (de-risk first) · ~3–5 days
Deliverable: `spikes/sponsor-spike/` script + `SPIKE_REPORT.md`.
- Bring up `undeployed` stack at support-matrix versions.
- Two wallets from seeds (genesis sponsor; funded user), counter contract deployed.
- Prove V1–V6, V8–V11; capture serialized tx fixtures; record fee sizes, estimate error, proving/submit/confirm latencies, concurrency behaviour, restart behaviour.
- Decide: reservation margin, sync vs async default, single-writer confirmation, which tx id to expose.
- **Exit:** a sponsored contract call confirmed on `undeployed` with a 0‑DUST user; findings feed Phase 2/3 designs. If anything fundamental fails, the PRD is revised *before* building the control plane.

### Phase 1 — Control plane with mock sponsor · ~1.5–2 weeks
- Monorepo, config, Postgres schema + migrations, Fastify API, auth/API keys, rate limiting, idempotency, `LedgerInspector` (real, using Phase‑0 fixtures), policy engine, budget reserve/settle/release, state machine + audit, worker loop with mock adapter, `POST/GET /v1/sponsorship/requests`, `GET /v1/usage`, OpenAPI.
- Docker compose `mock` profile.
- **Testable:** AC3–AC9 (integration), AC10 (status), restart recovery, concurrency tests. Demo: curl through approve/reject/budget-exhaustion/idempotent-retry.

### Phase 2 — Real sponsor adapter · ~1.5–2 weeks
- `worker` with `WalletFacade`; wallet CLI (`status`, `register-dust`, `addresses`); estimate RPC; pre-flight via `validateTransaction`; sponsor pipeline; confirmation watcher; reconciler; `SPONSOR_BALANCE_LOW`; health/heartbeat.
- Docker compose `local-midnight` profile; E2E suite on `undeployed` using a Node-side user wallet.
- **Testable:** AC1, AC2 (server-side user wallet), all ACs re-run against real transactions; kill-and-restart tests.

### Phase 3 — Client SDK + example DApp (browser) · ~1 week
- `@aetherdust/client`: `createSponsoredMidnightProvider({ baseUrl, apiKey, userId })` implementing `MidnightProvider.submitTx` (POST + wait/poll → returns txId) and a `walletProvider` wrapper that calls `connector.balanceUnsealedTransaction(tx, { payFees: false })`; typed errors; `sponsor()` helper matching PRD §32.
- `examples/example-dapp`: counter DApp with Lace on preview/preprod.
- **Testable:** AC1/AC2 exactly as an end user experiences it (V7 resolved). If Lace does not honour `payFees:false` yet, this is documented as a blocker with the Node-side path as the fallback demo.

### Phase 4 — Dashboard + observability · ~1–1.5 weeks
- Admin endpoints, dashboard pages (overview, requests, policy editor, usage, api keys), Prometheus `/metrics` (PRD §25), structured logs with `request_id/transaction_id/application_id`, wallet snapshots.
- **Testable:** AC11 (usage matches Postgres and on-chain fees), Playwright smoke.

### Phase 5 — Hardening & self-host release · ~1 week
- Docs: quickstart (mock → local → preprod), integration guide, policy reference, runbooks (fund wallet, register DUST, low balance, stuck requests, key rotation), threat model.
- Security pass (§18 checklist), light load test, fresh-machine docker test in CI, version pin review (ledger v9 status), tagged `v0.1.0`.
- **Testable:** AC12; full AC matrix green on `undeployed` and a recorded preprod run.

**Critical path:** Phase 0 → Phase 2 → Phase 3. Phases 1 and 4 can proceed in parallel with 0/2 since they depend only on the mock adapter and the `SponsorAdapter` interface.

---

## 23. Open questions for the product owner

1. Sync vs async default for `POST /v1/sponsorship/requests` (recommend `202` + `?wait=` long-poll up to 30s).
2. Should MVP allow multi-call intents (several allowlisted calls in one tx)? Recommend: reject unless `allow_multiple_calls` is set.
3. Period semantics for budgets: calendar-day UTC vs rolling 24h (recommend calendar UTC for MVP; simpler to reason about on the dashboard).
4. Whether `user_id` should be shown raw in the dashboard or hashed (privacy vs operability).
5. Target network for the demo: `preprod` (recommended) or `preview`.
