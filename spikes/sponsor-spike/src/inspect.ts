/**
 * Offline transaction inspector — the part of AetherDust's pre-flight that needs no network.
 *
 * Takes the bytes a DApp would POST (a sealed `Transaction<SignatureEnabled, Proof, Binding>`
 * produced by the user's wallet with `payFees: false`) and derives what the policy engine needs:
 * every contract call (address + entry point), any deploys/maintenance updates, TTLs, and whether
 * the user already attached DUST actions. Nothing here trusts the DApp's claims.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';

export type TxSummary = {
  txHash: string;
  identifiers: string[];
  byteLength: number;
  calls: { segment: number; address: string; entryPoint: string }[];
  deploys: number;
  maintenanceUpdates: number;
  hasDustActions: boolean;
  dustSpendCount: number;
  dustFeeSpecks: bigint;
  minIntentTtl: Date | null;
  hasGuaranteedShieldedOffer: boolean;
  fallibleShieldedOfferSegments: number;
};

export class InspectError extends Error {
  constructor(
    public readonly code: 'DESERIALIZE_FAILED' | 'TOO_LARGE' | 'NO_INTENTS',
    message: string,
  ) {
    super(message);
  }
}

export const entryPointToString = (ep: Uint8Array | string): string =>
  typeof ep === 'string' ? ep : Buffer.from(ep).toString('utf8');

export const deserializeFinalized = (bytes: Uint8Array): ledger.FinalizedTransaction => {
  try {
    return ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes);
  } catch (e) {
    throw new InspectError('DESERIALIZE_FAILED', `not a sealed ledger-v8 transaction: ${(e as Error).message}`);
  }
};

/** Summarise any transaction variant (used for both user-supplied and merged transactions). */
export const summarize = (tx: ledger.Transaction<any, any, any>, byteLength: number): TxSummary => {
  const calls: TxSummary['calls'] = [];
  let deploys = 0;
  let maintenanceUpdates = 0;
  let dustSpendCount = 0;
  let dustFeeSpecks = 0n;
  let minIntentTtl: Date | null = null;

  const intents = tx.intents ?? new Map<number, ledger.Intent<any, any, any>>();
  for (const [segment, intent] of intents) {
    for (const action of intent.actions) {
      if (action instanceof ledger.ContractCall) {
        calls.push({ segment, address: action.address, entryPoint: entryPointToString(action.entryPoint) });
      } else if (action instanceof ledger.ContractDeploy) {
        deploys++;
      } else {
        maintenanceUpdates++;
      }
    }
    const spends = intent.dustActions?.spends ?? [];
    dustSpendCount += spends.length;
    for (const s of spends) dustFeeSpecks += s.vFee;
    const ttl = intent.ttl;
    if (ttl && (minIntentTtl === null || ttl < minIntentTtl)) minIntentTtl = ttl;
  }

  let txHash = '';
  try {
    txHash = tx.transactionHash();
  } catch {
    /* only defined for proven+signed+bound transactions */
  }

  return {
    txHash,
    identifiers: tx.identifiers(),
    byteLength,
    calls,
    deploys,
    maintenanceUpdates,
    hasDustActions: dustSpendCount > 0 || [...intents.values()].some((i) => (i.dustActions?.registrations?.length ?? 0) > 0),
    dustSpendCount,
    dustFeeSpecks,
    minIntentTtl,
    hasGuaranteedShieldedOffer: tx.guaranteedOffer != null,
    fallibleShieldedOfferSegments: tx.fallibleOffer?.size ?? 0,
  };
};

export const inspectFinalizedBytes = (bytes: Uint8Array, maxBytes = 512 * 1024): TxSummary => {
  if (bytes.byteLength > maxBytes) throw new InspectError('TOO_LARGE', `${bytes.byteLength} bytes > ${maxBytes}`);
  const tx = deserializeFinalized(bytes);
  return summarize(tx, bytes.byteLength);
};

/** Tiny policy check used by the spike to mirror AetherDust rules R2–R6 on a summary. */
export type PolicyVerdict = { ok: true } | { ok: false; code: string; detail: string };
export const checkPolicy = (
  s: TxSummary,
  policy: { allowed: Record<string, string[]>; minTtlRemainingMs: number; now?: Date },
): PolicyVerdict => {
  const now = policy.now ?? new Date();
  if (s.deploys > 0 || s.maintenanceUpdates > 0) return { ok: false, code: 'CONTRACT_NOT_ALLOWED', detail: 'deploy/maintenance present' };
  if (s.calls.length === 0) return { ok: false, code: 'INVALID_REQUEST', detail: 'no contract calls' };
  if (s.hasDustActions) return { ok: false, code: 'INVALID_REQUEST', detail: 'transaction already carries DUST actions' };
  for (const c of s.calls) {
    const eps = policy.allowed[c.address];
    if (!eps) return { ok: false, code: 'CONTRACT_NOT_ALLOWED', detail: c.address };
    if (!eps.includes(c.entryPoint)) return { ok: false, code: 'ENTRY_POINT_NOT_ALLOWED', detail: `${c.address}:${c.entryPoint}` };
  }
  if (s.minIntentTtl && s.minIntentTtl.getTime() - now.getTime() < policy.minTtlRemainingMs)
    return { ok: false, code: 'PREFLIGHT_FAILED', detail: `ttl ${s.minIntentTtl.toISOString()} too close` };
  return { ok: true };
};

export const specksToDust = (specks: bigint): string => {
  const whole = specks / 1_000_000_000_000_000n;
  const frac = (specks % 1_000_000_000_000_000n).toString().padStart(15, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};
