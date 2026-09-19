# Phase 0 Spike Report — DUST fee sponsorship on Midnight

**Date:** 2026-09-20 · **Network:** `undeployed` (local, genesis-funded) · **Runs:** 4 e2e (final: 18/18 on a fresh genesis incl. deploy), 2 concurrency, 1 restart, 20 offline checks
**Stack (official support matrix 2026-09-20):** ledger-v8 8.1.0 · wallet-sdk 1.2.0 (facade 4.1.0, dust-wallet 4.2.0, shielded 3.0.2, unshielded 3.1.0, hd 3.0.3) · midnight-js 4.1.1 · compact-js 2.5.1 · compactc 0.31.1 / compact-runtime 0.16.0 / onchain-runtime-v3 3.0.0 · midnight-node 1.0.2 · indexer-standalone 4.3.5 · proof-server 8.1.0 · Node.js 24.21
**Evidence:** `fixtures/live/*/report.json` (+ captured `user-sealed-unpaid.bin`, `merged-sponsored.bin`), `fixtures/offline-results.json`, `fixtures/node-1.0.2-error-codes.rs`.

## 1. Verdict

**The AetherDust core flow works on today's released Midnight stack, with no protocol changes and no custody of user keys.**
A user holding **0 NIGHT and 0 DUST** built, proved and signed a contract call (`counter.increment`), balanced it **without** paying fees,
and a separate sponsor wallet added the DUST fee, merged, submitted, and the call was confirmed on-chain (counter 0→1→2→3 across runs).
The user's balance stayed 0/0 throughout; the sponsor's DUST coin was self-spent for the fee. Phase 0 exit criteria are met (§6).

## 2. Validation items (from IMPLEMENTATION_PLAN.md §1.2-C)

| Item | Result | Evidence / numbers |
|---|---|---|
| **V1** end-to-end sponsorship | ✅ **Confirmed** | user `balanceUnboundTransaction(['shielded','unshielded'])` → seal → sponsor `balanceFinalizedTransaction(['dust'])` → `signRecipe` → `finalizeRecipe` → `submitTransaction` → confirmed in block; 3 successful runs, e2e 19.5–22.0 s |
| **V2** confirmation key | ✅ **Resolved** | `publicDataProvider.watchForTxData(id)` resolves with **transaction identifiers**, not the tx hash. Resolves: the id `submitTransaction` returns (`identifiers.at(-1)`) and the **user's original identifier** (`userIdentifiers[0]`, unchanged by the merge). Does **not** resolve: `transactionHash()` of the merged or user tx. |
| **V3** fee estimate vs actual | ✅ **Exact** | `estimateTransactionFee` == actual sponsor `DustSpend.vFee` in every run (ratio 1.000). `calculateTransactionFee` (user tx only) is ~35 % of the total; the sponsor's own balancing intent is the rest. **Fees are dynamic**: 0.0125 (right after a deploy) → 0.0043 → 0.0009 → 0.00005 → 0.000001 DUST across runs as blocks emptied (ledger `postBlockUpdate(..blockFullness)` pricing). Estimate at request time; re-estimate at commit time. |
| **V4** one wallet, parallel sponsorships | ✅ **Bounded by coin count** | 3∥ with 5 DUST coins: 3/3 confirmed in 17.2 s (serial: 52 s). **7∥ with 5 coins: 5 confirmed, 2 failed fast** at balancing with `Insufficient Funds: could not balance dust` (before proving; nothing spent). The dust wallet does **not** chain pending outputs: each in-flight sponsorship locks one coin until confirmed. |
| **V5** restart / recovery | ✅ **Characterised** | (a) Fresh facade from the same seed after confirmations: consistent (5 coins, 0 pending). (b) Crash **between finalize and submit**: the coin lock is **process-local** — a fresh process sees the coin as available again; the persisted merged bytes **submit fine from the new process**; an immediate duplicate submit is deduped (same id, 14 ms); after the wallet syncs the spend, replay is rejected (node code 193). |
| **V6** TTL / grace windows | ✅ **Measured** | midnight-js `balanceTx` defaults the user intent TTL to **1 h**; sponsor balancing intent used 30 min (merged tx expires at the **minimum**). Full flow used < 25 s of it. DUST grace period = 10 800 s (3 h). |
| **V8** `signRecipe` proof-marker bug (example-counter workaround) | ✅ **Fixed in facade 4.1.0** | SDK `signRecipe` path succeeded for both user (UNBOUND recipe) and sponsor (FINALIZED recipe); manual fallback never triggered. |
| **V9** sponsor only pays fees | ✅ | Balancing tx contains exactly 1 `DustSpend`, 0 contract actions, 0 shielded offers; merged tx `imbalances(0, 0)` = +vFee (dust only). `tokenKindsToBalance:['dust']` never touched other kinds. |
| **V10** user tx must not carry DUST actions | ✅ | User tx: `dustSpendCount=0`; inspector flags `hasDustActions` — policy rule R6 implementable. |
| **V11** adversarial inputs | ✅ / ⚠️ | Offline: random/truncated/empty/oversize/wrong-variant bytes rejected at `deserialize`; 64 bit-flips → 48 rejected, 16 hash-changed, 0 silent. Live: unpaid user tx rejected by node (**code 138 `BalanceCheckOverspend`**); replay rejected (**193 `ReplayProtectionViolation`**); policy rejects wrong contract / entry point before any sponsor work. ⚠️ A byte flipped inside the user's **contract proof** passes signature+limit checks offline (proof verification needs the contract's on-chain state, which the v8 ledger API cannot inject); pushed through the full pipeline it is rejected at submission — **cost to sponsor: ~1.5 s proving, 0 DUST** (coins unchanged). |
| **V12** ledger v9 timeline | ℹ️ | Node 2.x RCs, proof-server 9.0.0-rc.7 / 10.0.0-alpha, ledger 9.1.0-rc.5, facade 5.0.0-beta (ledger-v9) are all published; all three public networks still run ledger 8. No date found. |
| **V7** Lace `payFees:false` in a browser | ⏭️ not in Phase 0 scope | Spec-mandated (`SPECIFICATION.md`: "wallet must not issue DustSpend"). Server-side equivalent proven here. Validate with a human + Lace on preprod in Phase 3. |

## 3. Measurements (undeployed, 6 s blocks, local proof server, Ryzen 5 5600H)

| Step | Typical | Notes |
|---|---|---|
| sponsor wallet cold sync (fresh chain, ~100 blocks) | 34 s | restart cost; grows with chain length — keep the worker long-lived |
| user prove `increment` (proof server) | ~0.5–2 s | not on AetherDust's critical path (happens in the DApp) |
| user balance (no dust) + sign + seal | 3 + 3 ms | |
| AetherDust inspect (deserialize + summarise) | 7 ms | 3.4 KB user tx; 6.6 KB merged |
| `calculateTransactionFee` / `estimateTransactionFee` | 6 / 19 ms | |
| `balanceFinalizedTransaction(['dust'])` | 17 ms (29–122 ms under 3–5∥) | |
| `signRecipe` | 3 ms | |
| `finalizeRecipe` (prove DustSpend + merge) | **~530 ms** (0.8–2.0 s under 3–5∥) | proof server CPU-bound; scales with parallelism |
| `facade.submitTransaction` | **16–20 s** | facade calls the submission service with `'Finalized'` → blocks until GRANDPA finality. The service also supports `'Submitted'` / `'InBlock'` and is exposed as `facade.submissionService`. |
| end-to-end (DApp `callTx.increment()` resolved) | 19.5–22 s | dominated by block/finality time |
| tampered tx through full pipeline | 1.5 s, 0 DUST | |
| fee per sponsored `increment` (overhead 0) | 0.0125 → 0.000001 DUST | dynamic; with the example's `additionalFeeOverhead` (0.3 DUST) the sponsor overpays ~80–300 000× |

## 4. Design consequences for AetherDust (changes vs. IMPLEMENTATION_PLAN.md)

1. **`WalletFacade.validateTransaction` does not exist in the stable v8 line (facade 4.1.0)** — it is on `main` / 5.0.0-beta (ledger-v9). Pre-flight on v8 = our own `LedgerInspector` + ledger `Transaction.wellFormed(LedgerState.blank(net), strictness, now)` with `verifySignatures + enforceLimits (+ verifyNativeProofs)`; **network-id mismatch is caught first** (`invalid network ID - expect 'undeployed' found 'preview'`). Contract-proof verification is **not possible pre-submission** on v8 (no API to load a contract's state into a `LedgerState`); the node is the final judge and a bad proof costs ~1.5 s CPU, no DUST. Budget must therefore be *reserved* at approval and *settled* only on confirmation (already the plan).
2. **Concurrency = number of registered NIGHT UTXOs (DUST coins).** The worker's parallelism must be `min(config, availableDustCoins)`; `Insufficient Funds: could not balance dust` is a **retryable** error (queue, don't reject). Operators scale throughput by splitting NIGHT into more UTXOs (dashboard should show coin count as "max in-flight").
3. **In-flight coin locks are process-local.** On restart the worker must first drain persisted `merged_tx_bytes` with `status = SPONSORING/SUBMITTED` (resubmit is idempotent: dedupe or code 193) **before** balancing anything new, otherwise a new sponsorship can pick the same coin and one of the two will fail with `DustDoubleSpend` (196).
4. **Submission semantics.** Use `facade.submissionService.submitTransaction(tx, 'Submitted' | 'InBlock')` in the worker to return fast, persist ids, and confirm via `watchForTxData(identifier)`; keep `'Finalized'` only if we want the SDK's pending-tracking for free. After a failed submit the node-client websocket is closed for a moment (`disconnected … Normal Closure`) — treat as retryable.
5. **Confirmation key = transaction identifier, not hash.** Return `identifiers` to the DApp; the DApp may watch its *own* identifier (unchanged by the merge) immediately, independent of AetherDust's response. The merged `transactionHash` is for our audit table only.
6. **Fee model.** Set `costParameters.additionalFeeOverhead` to 0 (or a few % of the fee), never the example's 0.3 DUST. Reserve = `estimateTransactionFee` (exact in practice) × small margin for block-fullness drift between estimate and submit; settle actual `vFee` from the merged tx.
7. **Node error taxonomy** for `SUBMISSION_FAILED.reason`: map the RPC `1010 Invalid Transaction: Custom error: N` codes with `fixtures/node-1.0.2-error-codes.rs` (138 overspend/unpaid fee, 193 replay, 196 dust double-spend, 242 intent TTL expired, 166 wrong network, 115 invalid proof, …). Unwrap Effect errors via `Cause.failures()` — `message` alone is always "Transaction submission error".
8. **TTL policy.** Require `min(intent.ttl) − now ≥ processing budget + queue wait` (e.g. ≥ 5 min); reject earlier. The sponsor's balancing TTL (30 min) bounds the merged tx.
9. **Dependency hygiene.** Duplicate WASM instances break `instanceof` (`expected instance of StateValue`). Pin with pnpm overrides: `@midnight-ntwrk/ledger-v8@8.1.0`, `@midnight-ntwrk/onchain-runtime-v3@3.0.0`; `InMemoryTransactionHistoryStorage` now lives in `@midnightntwrk/wallet-sdk-abstractions` and takes the facade's `WalletEntrySchema`; indexer API path is `/api/v4/graphql`.
10. **Wire format.** `tx.serialize()` bytes of `Transaction<SignatureEnabled, Proof, Binding>`; `Transaction.deserialize('signature','proof','binding', bytes)` is byte-stable and strict (header tag `midnight:transaction[v9]…`). API will carry it hex-encoded.

## 5. Not validated in Phase 0 (carry forward)
- Lace (browser) honouring `payFees:false` (V7) → Phase 3, human in the loop on preprod.
- A run on `preprod` with faucet NIGHT (public RPC/indexer + own proof server). The code is network-parameterised (`MIDNIGHT_NETWORK=preprod SPONSOR_SEED=…`); the sponsor needs NIGHT and a DUST registration (`pnpm wallet register-dust`, ~12 h cross-chain finality per docs).
- Parallelism > coin count with *chained* spends (SDK doesn't support it today; not needed if we bound concurrency).
- Ledger v9 migration cost (facade 5.0 adds `validateTransaction`; ledger-v9 packages are RCs).

## 6. Exit criteria
- [x] Sponsored contract call confirmed on `undeployed` with a 0-DUST user (V1) — 3 runs
- [x] V2, V3, V4, V5, V6, V8, V9, V10, V11 answered with numbers; V12 researched
- [x] Real serialized fixtures captured (`user-sealed-unpaid.bin`, `merged-sponsored.bin`) for AetherDust unit tests
- [x] Reservation margin, sync/async default, single-writer bound, confirmation key decided (§4)
- [x] Nothing fundamental failed → PRD stands; plan corrections listed in §4

## 7. Reproduce
```bash
cd spikes/sponsor-spike && pnpm install && pnpm compact
pnpm offline                                  # 20/20
deploy/native/stack.sh up                     # or: pnpm stack:up (Docker)
DUST_FEE_OVERHEAD=0 pnpm spike                # deploys counter, prints CONTRACT_ADDRESS
DUST_FEE_OVERHEAD=0 N=14 CONTRACT_ADDRESS=… pnpm concurrency
DUST_FEE_OVERHEAD=0 CONTRACT_ADDRESS=… pnpm restart-test
pnpm probe-errors                             # node rejection codes for saved fixtures
```
