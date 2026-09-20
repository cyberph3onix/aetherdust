import type { TxSummary } from '@aetherdust/core';

/** Where in the pipeline something failed, and whether a retry could help. */
export class SponsorError extends Error {
  constructor(
    readonly stage: 'inspect' | 'estimate' | 'sponsor' | 'submit' | 'confirm' | 'wallet',
    readonly code: 'INVALID_REQUEST' | 'PREFLIGHT_FAILED' | 'SPONSOR_BALANCE_LOW' | 'SPONSOR_UNAVAILABLE' | 'SPONSORING_FAILED' | 'SUBMISSION_FAILED' | 'TIMEOUT',
    message: string,
    readonly retryable: boolean,
    readonly detail?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) { super(message, options); this.name = 'SponsorError'; }
}

export interface SponsorResult {
  /** The fully balanced transaction (user tx merged with the sponsor's DUST-spend intent). Persist BEFORE submitting. */
  mergedBytes: Uint8Array;
  mergedTxHash: string;
  identifiers: string[];
  actualFeeSpecks: bigint;
}
export type ConfirmationResult =
  | { status: 'confirmed'; blockHeight: number | null }
  | { status: 'failed'; reason: string; code?: number }
  | { status: 'timeout' };

export interface WalletStatus {
  adapter: 'mock' | 'midnight';
  network: string;
  synced: boolean;
  healthy: boolean;
  dustBalanceSpecks: bigint;
  dustCapSpecks: bigint | null;
  nightStars: bigint | null;
  dustCoins: number;
  dustCoinsInFlight: number;
  /** Concurrency bound: available DUST coins (Phase 0 V4). */
  maxInFlight: number;
  detail?: Record<string, unknown>;
}

/**
 * Everything AetherDust needs from Midnight. `inspect` is offline and safe to run in the public API process;
 * the rest needs the sponsor wallet and runs only in the worker.
 */
export interface SponsorAdapter {
  readonly name: 'mock' | 'midnight';
  readonly network: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Derive what the policy engine needs from the raw bytes. Throws SponsorError(INVALID_REQUEST) on garbage. */
  inspect(bytes: Uint8Array): TxSummary;
  estimateFee(bytes: Uint8Array): Promise<{ feeSpecks: bigint }>;
  /** Balance DUST only, sign, prove, merge. Never submits. */
  sponsor(bytes: Uint8Array, opts: { ttlMs: number }): Promise<SponsorResult>;
  /** Submit previously produced merged bytes. Idempotent for identical bytes (dedupe or replay rejection). */
  submit(mergedBytes: Uint8Array): Promise<{ identifier: string }>;
  waitForConfirmation(identifier: string, timeoutMs: number): Promise<ConfirmationResult>;
  walletStatus(): Promise<WalletStatus>;
}
