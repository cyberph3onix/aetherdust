/**
 * API-process adapter when the real sponsor lives in the worker (plan §3 option A). Inspection stays local and
 * offline; fee estimation and wallet health go to the worker's private RPC over a shared secret. Sponsoring,
 * submission and confirmation are worker-only and must never be called here.
 */
import type { TxSummary } from '@aetherdust/core';
import { SponsorError, type ConfirmationResult, type SponsorAdapter, type SponsorResult, type WalletStatus } from '../adapter.js';
import { inspectFinalizedBytes } from '../inspector.js';

export const INTERNAL_SECRET_HEADER = 'x-aetherdust-internal-secret';

export interface RemoteAdapterOptions {
  network: string;
  workerUrl: string;
  secret: string;
  maxTxBytes: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Wire shape of the worker's `/internal/health` (bigints as decimal strings). */
export interface WalletStatusWire extends Omit<WalletStatus, 'dustBalanceSpecks' | 'dustCapSpecks' | 'nightStars'> { dustBalanceSpecks: string; dustCapSpecks: string | null; nightStars: string | null }
export const walletStatusToWire = (w: WalletStatus): WalletStatusWire => ({ ...w, dustBalanceSpecks: w.dustBalanceSpecks.toString(), dustCapSpecks: w.dustCapSpecks?.toString() ?? null, nightStars: w.nightStars?.toString() ?? null });
export const walletStatusFromWire = (w: WalletStatusWire): WalletStatus => ({ ...w, dustBalanceSpecks: BigInt(w.dustBalanceSpecks), dustCapSpecks: w.dustCapSpecks == null ? null : BigInt(w.dustCapSpecks), nightStars: w.nightStars == null ? null : BigInt(w.nightStars) });

export class RemoteSponsorAdapter implements SponsorAdapter {
  readonly name = 'midnight' as const;
  readonly network: string;
  readonly #fetch: typeof fetch;
  constructor(private readonly o: RemoteAdapterOptions) { this.network = o.network; this.#fetch = o.fetch ?? fetch; }
  async start() {}
  async stop() {}

  inspect(bytes: Uint8Array): TxSummary {
    return inspectFinalizedBytes(bytes, { maxBytes: this.o.maxTxBytes, networkId: this.network, now: (this.o.now ?? (() => new Date()))() });
  }

  async #call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await this.#fetch(new URL(path, this.o.workerUrl), {
        method: init.method, signal: ctl.signal,
        headers: { [INTERNAL_SECRET_HEADER]: this.o.secret, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      throw new SponsorError('wallet', 'SPONSOR_UNAVAILABLE', `sponsor worker unreachable: ${(e as Error).message}`, true, undefined, { cause: e });
    } finally { clearTimeout(timer); }
    const json = await res.json().catch(() => ({})) as any;
    if (res.ok) return json as T;
    const err = json?.error ?? {};
    const code = (['INVALID_REQUEST', 'PREFLIGHT_FAILED', 'SPONSOR_BALANCE_LOW', 'SPONSOR_UNAVAILABLE'] as const).find((c) => c === err.code) ?? 'SPONSOR_UNAVAILABLE';
    throw new SponsorError('estimate', code, err.message ?? `worker responded ${res.status}`, err.retryable ?? res.status >= 500, err.details);
  }

  async estimateFee(bytes: Uint8Array): Promise<{ feeSpecks: bigint }> {
    const r = await this.#call<{ feeSpecks: string }>('/internal/estimate', { method: 'POST', body: { bytes: Buffer.from(bytes).toString('base64') } });
    return { feeSpecks: BigInt(r.feeSpecks) };
  }
  async walletStatus(): Promise<WalletStatus> {
    return walletStatusFromWire(await this.#call<WalletStatusWire>('/internal/health', { method: 'GET' }));
  }

  async sponsor(): Promise<SponsorResult> { throw new SponsorError('sponsor', 'SPONSOR_UNAVAILABLE', 'sponsor() is worker-only', false); }
  async submit(): Promise<{ identifier: string }> { throw new SponsorError('submit', 'SPONSOR_UNAVAILABLE', 'submit() is worker-only', false); }
  async waitForConfirmation(): Promise<ConfirmationResult> { throw new SponsorError('confirm', 'SPONSOR_UNAVAILABLE', 'waitForConfirmation() is worker-only', false); }
}
