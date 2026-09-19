/** Minimal sponsor step (no instrumentation) shared by the concurrency probe. */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { summarize } from './inspect.js';
import { signRecipeWithFallback, ttl, type WalletContext } from './wallet.js';

export const sponsorAndSubmit = async (sponsor: WalletContext, sealed: ledger.FinalizedTransaction) => {
  const t0 = performance.now();
  const recipe = await sponsor.wallet.balanceFinalizedTransaction(sealed,
    { shieldedSecretKeys: sponsor.shieldedSecretKeys, dustSecretKey: sponsor.dustSecretKey }, { ttl: ttl(), tokenKindsToBalance: ['dust'] });
  const t1 = performance.now();
  const signed = await signRecipeWithFallback(sponsor, recipe);
  const merged = await sponsor.wallet.finalizeRecipe(signed.recipe);
  const t2 = performance.now();
  const id = await sponsor.wallet.submitTransaction(merged);
  const t3 = performance.now();
  const s = summarize(merged, 0);
  return { id, txHash: s.txHash, feeSpecks: s.dustFeeSpecks, balanceMs: Math.round(t1 - t0), proveMergeMs: Math.round(t2 - t1), submitMs: Math.round(t3 - t2) };
};
