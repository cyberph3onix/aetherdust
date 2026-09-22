# Upstream bug report (ready to file)

`@midnightntwrk/wallet-sdk-dust-wallet` 4.2.0. Found on preprod on 2026-09-22 while building AetherDust; worked
around locally, still present upstream as far as we know. Paste the body below into the SDK's issue tracker.

---

**Title:** `computeBalancingRecipe` never converges (infinite loop, 100 % CPU) when the network fee rounds to 0

**Version:** `@midnightntwrk/wallet-sdk-dust-wallet@4.2.0`, via `@midnightntwrk/wallet-sdk-facade@4.1.0`,
`@midnight-ntwrk/ledger-v8@8.1.x`, Node 22. Network: **preprod** (reproducible on any chain with empty blocks).

**Summary**

`computeBalancingRecipe` is a synchronous `Effect.iterate`. When the network fee for the transaction being balanced
rounds to **0**, the loop condition can never be satisfied and the function spins forever, pinning one core and
blocking the event loop of the calling process. Both `estimateTransactionFee` and `balanceFinalizedTransaction` go
through it, so a caller cannot avoid it by choosing a different entry point.

**What happens**

1. The initial imbalance for the transaction is 0, so no DUST coin is selected.
2. The dry run of the resulting (empty) recipe yields a fee of 1 SPECK.
3. The convergence test is then `1 <= 0`, which never holds, and the iteration repeats with the same inputs.

**Reproduction**

1. Point a dust wallet at a chain whose blocks are empty (preprod at the time of writing).
2. Call `facade.estimateTransactionFee(tx, dustKey)` — or `balanceFinalizedTransaction(tx, keys,
   { tokenKindsToBalance: ['dust'] })` — for a transaction whose network fee rounds to 0, with
   `costParameters.additionalFeeOverhead = 0`.
3. The call never returns. CPU sits at 100 %; attaching an inspector shows the process inside the
   `computeBalancingRecipe` iteration.

**Impact**

A service that balances transactions on behalf of users (a fee sponsor, in our case) hangs its whole event loop —
not one request, the process. It needs an external watchdog to recover.

**Workaround**

Set `costParameters.additionalFeeOverhead` to a small non-zero value; 1e9 SPECK (0.000001 DUST) is enough to make
the first iteration select a coin and converge. Note the official example's 0.3 DUST inflates real fees by ~80×.

**Suggested fix**

Treat a zero imbalance as already balanced (return the empty recipe), or bound the iteration and surface a typed
error instead of looping. Either would turn an unrecoverable hang into something a caller can handle.

**Notes**

We also carry a defence in depth — a worker thread that SIGKILLs the process when the main loop stops heartbeating,
so a supervisor restarts it. Happy to supply a minimal reproduction repository if that helps.
