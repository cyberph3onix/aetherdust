/**
 * What the policy engine knows about a transaction. Produced by the ledger inspector (packages/midnight) from the
 * actual bytes — never from the DApp's claims. Kept here so core has no Midnight dependency.
 */
export interface TxCall {
  segment: number;
  address: string;
  entryPoint: string;
}
export interface TxSummary {
  format: 'midnight-ledger-v8' | 'mock';
  txHash: string;
  identifiers: string[];
  byteLength: number;
  calls: TxCall[];
  deploys: number;
  maintenanceUpdates: number;
  hasDustActions: boolean;
  dustSpendCount: number;
  dustFeeSpecks: bigint;
  minIntentTtl: Date | null;
}
