/**
 * Offline inspector for real Midnight transactions (ledger-v8). Validated in Phase 0 against captured fixtures.
 * Takes the bytes a DApp POSTs (a sealed `Transaction<SignatureEnabled, Proof, Binding>` produced with `payFees:false`)
 * and derives the facts the policy engine needs — never trusting the DApp's claims.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { TxSummary } from '@aetherdust/core';
import { SponsorError } from './adapter.js';

export const entryPointToString = (ep: Uint8Array | string): string => (typeof ep === 'string' ? ep : Buffer.from(ep).toString('utf8'));

export const deserializeFinalized = (bytes: Uint8Array): ledger.FinalizedTransaction => {
  try {
    return ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes);
  } catch (e) {
    throw new SponsorError('inspect', 'INVALID_REQUEST', `not a sealed ledger-v8 transaction: ${(e as Error).message}`, false, undefined, { cause: e });
  }
};

export const summarize = (tx: ledger.Transaction<any, any, any>, byteLength: number): TxSummary => {
  const calls: TxSummary['calls'] = [];
  let deploys = 0, maintenanceUpdates = 0, dustSpendCount = 0, registrations = 0, dustFeeSpecks = 0n;
  let minIntentTtl: Date | null = null;
  for (const [segment, intent] of tx.intents ?? new Map<number, ledger.Intent<any, any, any>>()) {
    for (const action of intent.actions) {
      if (action instanceof ledger.ContractCall) calls.push({ segment, address: action.address.toLowerCase(), entryPoint: entryPointToString(action.entryPoint) });
      else if (action instanceof ledger.ContractDeploy) deploys++;
      else maintenanceUpdates++;
    }
    const spends = intent.dustActions?.spends ?? [];
    dustSpendCount += spends.length;
    registrations += intent.dustActions?.registrations?.length ?? 0;
    for (const s of spends) dustFeeSpecks += s.vFee;
    if (intent.ttl && (minIntentTtl === null || intent.ttl < minIntentTtl)) minIntentTtl = intent.ttl;
  }
  let txHash = '';
  try { txHash = tx.transactionHash(); } catch { /* only defined for proven+signed+bound */ }
  return {
    format: 'midnight-ledger-v8', txHash, identifiers: tx.identifiers(), byteLength, calls, deploys, maintenanceUpdates,
    hasDustActions: dustSpendCount > 0 || registrations > 0, dustSpendCount, dustFeeSpecks, minIntentTtl,
  };
};

export interface InspectOptions {
  maxBytes?: number;
  /** When set, the transaction must be well-formed for this network (plan §8 R7 / §11 layer 1). */
  networkId?: string;
  now?: Date;
}
export const inspectFinalizedBytes = (bytes: Uint8Array, opts: InspectOptions = {}): TxSummary => {
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  if (bytes.byteLength > maxBytes) throw new SponsorError('inspect', 'INVALID_REQUEST', `transaction is ${bytes.byteLength} bytes; max ${maxBytes}`, false);
  if (bytes.byteLength === 0) throw new SponsorError('inspect', 'INVALID_REQUEST', 'empty transaction', false);
  const tx = deserializeFinalized(bytes);
  if (opts.networkId) wellFormedOrThrow(tx, opts.networkId, opts.now);
  return summarize(tx, bytes.byteLength);
};

/**
 * Structural pre-flight against a blank ledger state: network id, TTL, signatures, byte limits, native proofs.
 * (facade 4.1.0 has no validateTransaction; this is the ledger primitive it wraps on main.) Contract proofs cannot be
 * verified here — the node is the final judge (Phase 0 N4b: a bad proof costs ~1.5 s CPU, 0 DUST).
 */
export const wellFormedOrThrow = (tx: ledger.FinalizedTransaction, networkId: string, now = new Date()): void => {
  const s = new ledger.WellFormedStrictness();
  s.enforceBalancing = false; s.verifyContractProofs = false;
  s.verifySignatures = true; s.enforceLimits = true; s.verifyNativeProofs = true;
  try {
    tx.wellFormed(ledger.LedgerState.blank(networkId), s, now);
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 200);
    // R7: a transaction sealed for another network is a bad request, not a pre-flight condition that may clear
    if (/network id/i.test(msg))
      throw new SponsorError('inspect', 'INVALID_REQUEST', `transaction is for another network: ${msg}`, false, { rule: 'R7', expected: networkId }, { cause: e });
    throw new SponsorError('inspect', 'PREFLIGHT_FAILED', `transaction is not well-formed: ${msg}`, false, undefined, { cause: e });
  }
};
