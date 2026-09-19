# Phase 0 — DUST sponsorship spike

Proves, on a real Midnight network, that a user with **0 NIGHT / 0 DUST** can have a contract call
sponsored by a separate wallet, using only released SDK primitives:

* user: `WalletFacade.balanceUnboundTransaction(tx, keys, { tokenKindsToBalance: ['shielded','unshielded'] })`
  (server-side stand-in for Lace's `balanceUnsealedTransaction(tx, { payFees: false })`)
* sponsor: `WalletFacade.balanceFinalizedTransaction(tx, keys, { tokenKindsToBalance: ['dust'] })` → `signRecipe` →
  `finalizeRecipe` (proves the DUST spend, merges) → `submitTransaction`

Pinned stack (official support matrix, 2026-09-20): ledger-v8 8.1.0 · wallet-sdk 1.2.0 (facade 4.1.0) ·
midnight-js 4.1.1 · compactc 0.31.1 / compact-runtime 0.16.0 · node 1.0.2 · indexer 4.3.5 · proof-server 8.1.0.

## Prerequisites
* Node ≥ 22 (tested on 24), pnpm
* Compact devtools: `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh && compact update 0.31.1`
* Docker with compose (for the local stack)

## Run
```bash
pnpm install
pnpm compact              # compiles contract/src/counter.compact → contract/src/managed/counter
pnpm offline              # no network: inspector, deserialization strictness, fees, merge semantics, fixtures
pnpm stack:up             # local undeployed node + indexer + proof server (pinned versions, Docker)
#   no Docker? deploy/native/stack.sh up   (pulls the same images via the registry API and runs the binaries natively)
pnpm spike                # the live end-to-end sponsorship flow + negative tests + restart check
N=6 CONTRACT_ADDRESS=<from spike> pnpm concurrency   # V4: parallel vs serial sponsoring on one DUST wallet
pnpm wallet status        # sponsor wallet addresses / NIGHT / DUST / registration
pnpm stack:down
```
Testnets: `MIDNIGHT_NETWORK=preprod SPONSOR_SEED=<hex> pnpm spike` (run your own proof server on :6300; fund the
sponsor's unshielded address from the faucet, then `pnpm wallet register-dust`).

Outputs: `fixtures/*.bin` (offline), `fixtures/live/<net>-<ts>/{report.json,user-sealed-unpaid.bin,merged-sponsored.bin}`.
Findings are summarised in `SPIKE_REPORT.md`.
