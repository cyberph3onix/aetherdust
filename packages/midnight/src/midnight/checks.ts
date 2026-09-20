/**
 * Post-merge, pre-submit guarantee (plan §11 layer 3, PRD "sponsor only pays fees"). On ledger v8 `wellFormed` with
 * `enforceBalancing` cannot be evaluated against a blank state (the DUST spend needs chain state — Phase 0 probe), so
 * the check is structural: the merged transaction must be the user's transaction plus exactly one sponsor DustSpend
 * and nothing else, and every token imbalance must be ≥ 0.
 */
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import type { TxSummary } from '@aetherdust/core';
import { SponsorError } from '../adapter.js';
import { summarize } from '../inspector.js';

const fail = (msg: string, detail?: Record<string, unknown>) => new SponsorError('sponsor', 'SPONSORING_FAILED', `post-merge check failed: ${msg}`, false, detail);

const callKey = (c: { address: string; entryPoint: string }) => `${c.address}:${c.entryPoint}`;

/** True if any intent carries an unshielded offer or the tx carries a shielded (zswap) offer. */
export const hasValueOffers = (tx: ledger.Transaction<any, any, any>): boolean => {
  const t = tx as any;
  if (t.guaranteedOffer || t.fallibleOffer) return true;
  for (const intent of (tx.intents ?? new Map()).values()) {
    const i = intent as any;
    if (i.guaranteedUnshieldedOffer || i.fallibleUnshieldedOffer) return true;
  }
  return false;
};

/** The sponsor's balancing transaction alone: DUST spend(s) only, no calls, no value movement. */
export const assertBalancingIsDustOnly = (balancing: ledger.Transaction<any, any, any>): void => {
  const s = summarize(balancing, 0);
  if (s.calls.length > 0 || s.deploys > 0 || s.maintenanceUpdates > 0) throw fail('balancing transaction carries contract actions', { calls: s.calls.length, deploys: s.deploys });
  if (s.dustSpendCount === 0) throw fail('balancing transaction has no DustSpend');
  if (hasValueOffers(balancing)) throw fail('balancing transaction moves NIGHT or shielded value');
};

/** The merged transaction vs. the user's: same actions, +1 DustSpend, no residual negative imbalance. */
export const assertSponsorOnlyPaidFees = (user: TxSummary, merged: ledger.Transaction<any, any, any>, mergedByteLength: number): TxSummary => {
  const m = summarize(merged, mergedByteLength);
  const userCalls = user.calls.map(callKey).sort();
  const mergedCalls = m.calls.map(callKey).sort();
  if (JSON.stringify(userCalls) !== JSON.stringify(mergedCalls)) throw fail('merged transaction changes the contract calls', { user: userCalls, merged: mergedCalls });
  if (m.deploys !== user.deploys || m.maintenanceUpdates !== user.maintenanceUpdates) throw fail('merged transaction adds deploys or maintenance updates');
  if (m.dustSpendCount !== user.dustSpendCount + 1) throw fail('merged transaction must contain exactly one sponsor DustSpend', { user: user.dustSpendCount, merged: m.dustSpendCount });
  for (const id of user.identifiers) if (!m.identifiers.includes(id)) throw fail('user transaction identifier missing from the merged transaction', { id });
  let imbalances: Map<unknown, bigint>;
  try { imbalances = merged.imbalances(0, 0n) as Map<unknown, bigint>; } catch (e) { throw fail(`imbalances() failed: ${(e as Error).message}`); }
  for (const [token, v] of imbalances) if (v < 0n) throw fail('merged transaction still has a negative imbalance', { token: JSON.stringify(token), value: v.toString() });
  return m;
};
