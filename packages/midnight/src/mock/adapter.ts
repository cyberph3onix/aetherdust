/**
 * Mock sponsor: deterministic stand-in for the Midnight adapter so the whole control plane can be built and tested
 * without a chain. Accepts BOTH synthetic `format:"mock"` transactions (with failure injection) AND real ledger-v8
 * bytes (inspected by the real inspector, then "sponsored" by faking the DUST step). Models the Phase 0 facts:
 * concurrency bounded by DUST coins, fee = estimate, confirmation delay, in-flight coin locks.
 */
import { createHash, randomBytes } from 'node:crypto';
import { dustToSpecks, type TxSummary } from '@aetherdust/core';
import { SponsorError, type ConfirmationResult, type SponsorAdapter, type SponsorResult, type WalletStatus } from '../adapter.js';
import { isMockBytes, MOCK_MAGIC, parseMockBytes } from '../codec.js';
import { inspectFinalizedBytes } from '../inspector.js';

export interface MockAdapterOptions {
  network?: string;
  /** Real ledger-v8 bytes must be well-formed for this network id (R7). Unset = skip the check. */
  ledgerNetworkId?: string;
  feeSpecks?: bigint;
  confirmMs?: number;
  dustCoins?: number;
  dustBalanceSpecks?: bigint;
  maxTxBytes?: number;
  now?: () => Date;
}

export class MockSponsorAdapter implements SponsorAdapter {
  readonly name = 'mock' as const;
  readonly network: string;
  readonly #ledgerNetworkId?: string;
  readonly #fee: bigint;
  readonly #confirmMs: number;
  readonly #coins: number;
  #balance: bigint;
  readonly #maxTxBytes: number;
  readonly #now: () => Date;
  #inFlight = new Set<string>();
  #submitted = new Map<string, { at: number; env?: ReturnType<typeof parseMockBytes>; fee: bigint }>();
  #seen = new Set<string>();

  constructor(o: MockAdapterOptions = {}) {
    this.network = o.network ?? 'mock';
    this.#ledgerNetworkId = o.ledgerNetworkId;
    this.#fee = o.feeSpecks ?? dustToSpecks('0.004');
    this.#confirmMs = o.confirmMs ?? 300;
    this.#coins = o.dustCoins ?? 5;
    this.#balance = o.dustBalanceSpecks ?? dustToSpecks('1000');
    this.#maxTxBytes = o.maxTxBytes ?? 512 * 1024;
    this.#now = o.now ?? (() => new Date());
  }
  async start() {}
  async stop() {}

  inspect(bytes: Uint8Array): TxSummary { return this.#summarize(bytes, true); }

  /** `wellFormed` (network id, TTL, signatures) runs at the API edge; sponsor/submit re-derive the summary without it. */
  #summarize(bytes: Uint8Array, wellFormed: boolean): TxSummary {
    if (bytes.byteLength > this.#maxTxBytes) throw new SponsorError('inspect', 'INVALID_REQUEST', `transaction is ${bytes.byteLength} bytes; max ${this.#maxTxBytes}`, false);
    if (!isMockBytes(bytes)) return inspectFinalizedBytes(bytes, { maxBytes: this.#maxTxBytes, networkId: wellFormed ? this.#ledgerNetworkId : undefined, now: this.#now() });
    let env: ReturnType<typeof parseMockBytes>;
    try { env = parseMockBytes(bytes); } catch (e) { throw new SponsorError('inspect', 'INVALID_REQUEST', `invalid mock transaction: ${(e as Error).message}`, false); }
    const id = env.id ?? createHash('sha256').update(bytes).digest('hex');
    const txHash = createHash('sha256').update(`mock:${id}`).digest('hex');
    return {
      format: 'mock', txHash, identifiers: [`00${txHash}`], byteLength: env.byteLength ?? bytes.byteLength,
      calls: env.calls.map((c, i) => ({ segment: i + 1, address: c.address.toLowerCase(), entryPoint: c.entryPoint })),
      deploys: env.deploys ?? 0, maintenanceUpdates: 0, hasDustActions: env.hasDustActions ?? false, dustSpendCount: env.hasDustActions ? 1 : 0, dustFeeSpecks: 0n,
      minIntentTtl: new Date(this.#now().getTime() + (env.ttlSeconds ?? 3600) * 1000),
    };
  }

  #env(bytes: Uint8Array) { return isMockBytes(bytes) ? parseMockBytes(bytes) : undefined; }
  #feeFor(env?: ReturnType<typeof parseMockBytes>) { return env?.feeDust ? dustToSpecks(env.feeDust) : this.#fee; }

  async estimateFee(bytes: Uint8Array) {
    const env = this.#env(bytes);
    if (env?.fail === 'estimate') throw new SponsorError('estimate', 'PREFLIGHT_FAILED', 'mock: estimate failure injected', false);
    if (env?.fail === 'balance-low') throw new SponsorError('estimate', 'SPONSOR_BALANCE_LOW', 'mock: sponsor DUST balance below threshold', true);
    return { feeSpecks: this.#feeFor(env) };
  }

  async sponsor(bytes: Uint8Array, _opts: { ttlMs: number }): Promise<SponsorResult> {
    const env = this.#env(bytes);
    const summary = this.#summarize(bytes, false);
    if (this.#inFlight.size >= this.#coins)
      throw new SponsorError('sponsor', 'SPONSORING_FAILED', 'Insufficient Funds: could not balance dust (all DUST coins in flight)', true, { inFlight: this.#inFlight.size, coins: this.#coins });
    if (env?.fail === 'sponsor') throw new SponsorError('sponsor', 'SPONSORING_FAILED', 'mock: sponsor failure injected', false);
    const fee = env?.actualFeeDust ? dustToSpecks(env.actualFeeDust) : this.#feeFor(env);
    if (fee > this.#balance) throw new SponsorError('sponsor', 'SPONSOR_BALANCE_LOW', 'mock: insufficient DUST', true);
    await new Promise((r) => setTimeout(r, 5));
    const sponsorId = `00${createHash('sha256').update(`sponsor:${summary.txHash}:${randomBytes(4).toString('hex')}`).digest('hex')}`;
    // a fresh sponsorship of the same user tx is a different merged tx (new DustSpend, new randomness)
    const mergedTxHash = createHash('sha256').update(`merged:${summary.txHash}:${randomBytes(8).toString('hex')}`).digest('hex');
    const mergedBytes = new Uint8Array(Buffer.concat([Buffer.from(`${MOCK_MAGIC}MERGED:${mergedTxHash}:`), Buffer.from(bytes)]));
    this.#inFlight.add(mergedTxHash);
    return { mergedBytes, mergedTxHash, identifiers: [sponsorId, ...summary.identifiers], actualFeeSpecks: fee };
  }

  async submit(mergedBytes: Uint8Array): Promise<{ identifier: string }> {
    const head = Buffer.from(mergedBytes.subarray(0, MOCK_MAGIC.length + 7 + 64 + 1)).toString('utf8');
    const m = /MERGED:([0-9a-f]{64}):/.exec(head);
    if (!m) throw new SponsorError('submit', 'SUBMISSION_FAILED', 'mock: not a merged transaction', false);
    const mergedTxHash = m[1];
    const original = mergedBytes.subarray(MOCK_MAGIC.length + 7 + 64 + 1);
    const env = this.#env(original);
    const summary = this.#summarize(original, false);
    const identifier = summary.identifiers[0];
    if (this.#submitted.has(mergedTxHash)) return { identifier }; // dedupe, like the node right after inclusion
    if (this.#seen.has(summary.txHash)) throw new SponsorError('submit', 'SUBMISSION_FAILED', '1010: Invalid Transaction: Custom error: 193 (ReplayProtectionViolation)', false, { code: 193 });
    if (env?.fail === 'submit') { this.#inFlight.delete(mergedTxHash); throw new SponsorError('submit', 'SUBMISSION_FAILED', '1010: Invalid Transaction: Custom error: 115 (InvalidProof)', false, { code: 115 }); }
    this.#submitted.set(mergedTxHash, { at: Date.now(), env, fee: this.#feeFor(env) });
    this.#seen.add(summary.txHash);
    this.#confirmations.set(identifier, { mergedTxHash, env, at: Date.now() });
    return { identifier };
  }

  #confirmations = new Map<string, { mergedTxHash: string; env?: ReturnType<typeof parseMockBytes>; at: number }>();
  async waitForConfirmation(identifier: string, timeoutMs: number): Promise<ConfirmationResult> {
    const c = this.#confirmations.get(identifier);
    if (!c) return { status: 'failed', reason: 'unknown identifier' };
    const delay = c.env?.confirmMs ?? this.#confirmMs;
    const remaining = Math.max(0, delay - (Date.now() - c.at));
    if (c.env?.fail === 'timeout' || remaining > timeoutMs) { await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 50))); return { status: 'timeout' }; }
    await new Promise((r) => setTimeout(r, remaining));
    this.#inFlight.delete(c.mergedTxHash);
    if (c.env?.fail === 'confirm') return { status: 'failed', reason: 'mock: dropped from pool' };
    this.#balance -= this.#feeFor(c.env);
    return { status: 'confirmed', blockHeight: 1000 + this.#submitted.size };
  }

  async walletStatus(): Promise<WalletStatus> {
    return {
      adapter: 'mock', network: this.network, synced: true, healthy: true, dustBalanceSpecks: this.#balance, dustCapSpecks: this.#balance,
      nightStars: 250_000_000_000_000n, dustCoins: this.#coins, dustCoinsInFlight: this.#inFlight.size, maxInFlight: Math.max(0, this.#coins - this.#inFlight.size),
    };
  }
}
