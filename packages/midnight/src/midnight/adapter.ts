/**
 * Real sponsor adapter: one WalletFacade, one sponsor seed, runs only in the worker.
 * Pipeline per request (Phase 0 V1, V9): deserialize → wellFormed → balanceFinalizedTransaction(['dust']) → signRecipe
 * → finalizeRecipe (proves the DustSpend on the private proof server, merges) → structural post-merge check → bytes.
 * Submission and confirmation are separate calls so the worker can persist the merged bytes in between (V5b).
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js/types';
import type { TxSummary } from '@aetherdust/core';
import { SponsorError, type ConfirmationResult, type SponsorAdapter, type SponsorResult, type WalletStatus } from '../adapter.js';
import { deserializeFinalized, inspectFinalizedBytes, summarize, wellFormedOrThrow } from '../inspector.js';
import { assertBalancingIsDustOnly, assertSponsorOnlyPaidFees } from './checks.js';
import { explain, isReplay, sponsoringError, submissionError } from './errors.js';
import { buildSponsorWallet, snapshot, signRecipe, waitForSync, type SponsorWallet, type SponsorWalletOptions } from './wallet.js';

export interface MidnightAdapterOptions extends SponsorWalletOptions {
  seedHex: string;
  /** TTL for the sponsor's balancing intent (default 30 min; the merged tx expires at min(user, sponsor)). */
  sponsorTtlMs: number;
  submitWait: 'Submitted' | 'InBlock' | 'Finalized';
  syncTimeoutMs: number;
  /** Reject estimates that would leave the wallet below this (SPONSOR_BALANCE_LOW). */
  minSponsorDustSpecks: bigint;
  maxTxBytes: number;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

export class MidnightSponsorAdapter implements SponsorAdapter {
  readonly name = 'midnight' as const;
  readonly network: string;
  #w?: SponsorWallet;
  #pub?: PublicDataProvider;
  /** identifier → merged tx hash, for in-flight accounting */
  #inFlight = new Map<string, string>();
  #lastStatus?: WalletStatus;
  #minSponsorDustSpecks: bigint;
  constructor(private readonly o: MidnightAdapterOptions) { this.network = o.network; this.#minSponsorDustSpecks = o.minSponsorDustSpecks; }
  /** Operational knob: the DUST floor below which estimates are refused with SPONSOR_BALANCE_LOW. */
  setMinSponsorDustSpecks(v: bigint) { this.#minSponsorDustSpecks = v; }

  get wallet(): SponsorWallet { if (!this.#w) throw new SponsorError('wallet', 'SPONSOR_UNAVAILABLE', 'sponsor wallet is still starting (syncing with the network); try again later', true); return this.#w; }
  get publicData(): PublicDataProvider { return (this.#pub ??= indexerPublicDataProvider(this.o.indexer, this.o.indexerWs)); }

  async start(): Promise<void> {
    const t0 = Date.now();
    this.#w = await buildSponsorWallet(this.o.seedHex, this.o);
    await waitForSync(this.#w, this.o.syncTimeoutMs, (line) => this.o.log?.info({ progress: line }, 'sponsor wallet syncing'));
    const s = await snapshot(this.#w);
    this.o.log?.info({ syncMs: Date.now() - t0, dustCoins: s.dustCoins, dustSpecks: s.dustSpecks.toString(), nightStars: s.nightStars.toString(), unshieldedAddress: s.unshieldedAddress }, 'sponsor wallet synced');
    if (s.dustCoins === 0) this.o.log?.warn({ unshieldedAddress: s.unshieldedAddress }, 'sponsor has no DUST coins — fund NIGHT and run `aetherdust-wallet register-dust`');
  }
  async stop(): Promise<void> { await this.#w?.facade.stop().catch(() => {}); this.#w = undefined; }

  inspect(bytes: Uint8Array): TxSummary {
    return inspectFinalizedBytes(bytes, { maxBytes: this.o.maxTxBytes, networkId: this.network, now: new Date() });
  }

  async estimateFee(bytes: Uint8Array): Promise<{ feeSpecks: bigint }> {
    const w = this.wallet;
    const tx = deserializeFinalized(bytes);
    let feeSpecks: bigint;
    try { feeSpecks = await w.facade.estimateTransactionFee(tx, w.dustSecretKey, { ttl: new Date(Date.now() + this.o.sponsorTtlMs) }); }
    catch (e) { const x = explain(e); throw new SponsorError('estimate', x.transport ? 'SPONSOR_UNAVAILABLE' : 'PREFLIGHT_FAILED', `fee estimation failed: ${x.text}`, x.transport, undefined, { cause: e }); }
    const s = await snapshot(w);
    if (s.dustSpecks < feeSpecks + this.#minSponsorDustSpecks)
      throw new SponsorError('estimate', 'SPONSOR_BALANCE_LOW', 'sponsor DUST balance is below the configured floor', true,
        { dustSpecks: s.dustSpecks.toString(), feeSpecks: feeSpecks.toString(), floorSpecks: this.#minSponsorDustSpecks.toString() });
    return { feeSpecks };
  }

  async sponsor(bytes: Uint8Array, opts: { ttlMs: number }): Promise<SponsorResult> {
    const w = this.wallet;
    const tx = deserializeFinalized(bytes);
    const now = new Date();
    wellFormedOrThrow(tx, this.network, now); // layer-2 pre-flight with the worker's clock (TTL may have drifted since the API saw it)
    const user = summarize(tx, bytes.byteLength);
    const ttl = new Date(now.getTime() + Math.min(opts.ttlMs, this.o.sponsorTtlMs));
    let recipe;
    try { recipe = await w.facade.balanceFinalizedTransaction(tx, { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl, tokenKindsToBalance: ['dust'] }); }
    catch (e) { throw sponsoringError(e); }
    if (recipe.balancingTransaction) assertBalancingIsDustOnly(recipe.balancingTransaction);
    let merged: ledger.FinalizedTransaction;
    try {
      const signed = await signRecipe(w, recipe);
      merged = await w.facade.finalizeRecipe(signed);
    } catch (e) { throw sponsoringError(e); }
    const mergedBytes = merged.serialize();
    const m = assertSponsorOnlyPaidFees(user, merged, mergedBytes.byteLength);
    const identifiers = merged.identifiers();
    return { mergedBytes, mergedTxHash: m.txHash, identifiers, actualFeeSpecks: m.dustFeeSpecks - user.dustFeeSpecks };
  }

  /** Idempotent for identical bytes: right after inclusion the node dedupes; after the spend is synced it answers 193 (already applied). */
  async submit(mergedBytes: Uint8Array): Promise<{ identifier: string }> {
    const w = this.wallet;
    const tx = deserializeFinalized(mergedBytes);
    const identifiers = tx.identifiers();
    const identifier = identifiers.at(-1)!; // what facade.submitTransaction returns (Phase 0 V2); resolvable by the indexer
    let txHash = '';
    try { txHash = tx.transactionHash(); } catch { /* audit only */ }
    this.#inFlight.set(identifier, txHash);
    try {
      if (this.o.submitWait === 'Finalized') await w.facade.submitTransaction(tx);
      else await w.facade.submissionService.submitTransaction(tx, this.o.submitWait);
    } catch (e) {
      const err = submissionError(e);
      if (isReplay(err)) { this.o.log?.warn({ identifier }, 'node reports replay: treating as already applied, confirming by identifier'); return { identifier }; }
      if (!err.retryable) this.#inFlight.delete(identifier);
      throw err;
    }
    return { identifier };
  }

  async waitForConfirmation(identifier: string, timeoutMs: number): Promise<ConfirmationResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
    try {
      const r = await Promise.race([this.publicData.watchForTxData(identifier), timeout]);
      if (r === 'timeout') return { status: 'timeout' };
      this.#inFlight.delete(identifier);
      if (r.status === 'SucceedEntirely') return { status: 'confirmed', blockHeight: Number(r.blockHeight ?? 0) || null };
      return { status: 'failed', reason: `transaction included with status ${r.status}` };
    } catch (e) {
      const x = explain(e);
      if (x.transport) return { status: 'timeout' }; // indexer hiccup: reconcile later rather than declare failure
      return { status: 'failed', reason: x.text };
    } finally { if (timer) clearTimeout(timer); }
  }

  async walletStatus(): Promise<WalletStatus> {
    if (!this.#w) return this.#lastStatus ?? { adapter: 'midnight', network: this.network, synced: false, healthy: false, dustBalanceSpecks: 0n, dustCapSpecks: null, nightStars: null, dustCoins: 0, dustCoinsInFlight: 0, maxInFlight: 0, detail: { reason: 'wallet not started' } };
    const s = await snapshot(this.#w);
    return (this.#lastStatus = {
      adapter: 'midnight', network: this.network, synced: s.synced, healthy: s.synced && s.dustCoins + s.dustPendingCoins > 0,
      dustBalanceSpecks: s.dustSpecks, dustCapSpecks: s.dustCapSpecks, nightStars: s.nightStars,
      dustCoins: s.dustCoins + s.dustPendingCoins, dustCoinsInFlight: s.dustPendingCoins,
      // availableCoins already excludes coins locked by in-flight sponsorships (process-local, Phase 0 V4/V5)
      maxInFlight: s.dustCoins,
      detail: { unshieldedAddress: s.unshieldedAddress, dustAddress: s.dustAddress, nightUtxos: s.nightUtxos, nightUtxosRegisteredForDust: s.nightUtxosRegisteredForDust, pendingTxs: s.pendingTxs, trackedInFlight: this.#inFlight.size },
    });
  }
}
