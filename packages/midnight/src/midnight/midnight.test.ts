/**
 * Offline tests for the real-adapter building blocks, against the Phase 0 fixtures (a real user tx and the real
 * merged, sponsored tx that confirmed on `undeployed`). The wallet itself needs a chain — see test/e2e.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SponsorError } from '../adapter.js';
import { deserializeFinalized, inspectFinalizedBytes } from '../inspector.js';
import { RemoteSponsorAdapter, walletStatusFromWire, walletStatusToWire } from '../remote/adapter.js';
import { assertBalancingIsDustOnly, assertSponsorOnlyPaidFees, hasValueOffers } from './checks.js';
import { collectMessages, explain, isReplay, sponsoringError, submissionError } from './errors.js';

const F = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');
const fx = (n: string) => new Uint8Array(readFileSync(path.join(F, n)));
const meta = JSON.parse(readFileSync(path.join(F, 'fixture-1.json'), 'utf8'));

describe('post-merge check (plan §11 layer 3)', () => {
  const user = inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'));
  const mergedBytes = fx('merged-sponsored-1.bin');
  const merged = deserializeFinalized(mergedBytes);

  it('accepts the real sponsored merge and reports the sponsor fee', () => {
    const m = assertSponsorOnlyPaidFees(user, merged, mergedBytes.byteLength);
    expect(m.dustSpendCount).toBe(1);
    expect(m.dustFeeSpecks - user.dustFeeSpecks).toBe(BigInt(meta.actualFeeSpecks));
    expect(m.txHash).toBe(meta.mergedTxHash);
  });
  it('rejects a merge whose calls differ from the user transaction', () => {
    const other = inspectFinalizedBytes(fx('user-sealed-unpaid-2.bin'));
    expect(() => assertSponsorOnlyPaidFees({ ...other, calls: [{ segment: 1, address: 'ab'.repeat(32), entryPoint: 'x' }] }, merged, mergedBytes.byteLength)).toThrow(/changes the contract calls/);
  });
  it('rejects a merge with no sponsor DustSpend (user tx passed as "merged")', () => {
    const userTx = deserializeFinalized(fx('user-sealed-unpaid-1.bin'));
    expect(() => assertSponsorOnlyPaidFees(user, userTx, 0)).toThrow(/exactly one sponsor DustSpend/);
  });
  it('rejects a merge that drops the user identifier', () => {
    expect(() => assertSponsorOnlyPaidFees({ ...user, identifiers: ['00' + 'ff'.repeat(32)] }, merged, mergedBytes.byteLength)).toThrow(/identifier missing/);
  });
  it('a merged tx with a contract call is not a valid balancing tx; the user tx moves no value', () => {
    expect(() => assertBalancingIsDustOnly(merged)).toThrow(/carries contract actions/);
    expect(hasValueOffers(deserializeFinalized(fx('user-sealed-unpaid-1.bin')))).toBe(false);
  });
});

describe('error mapping (Phase 0 §4.7)', () => {
  const fiber = (inner: unknown) => {
    const e: any = new Error('Transaction submission error');
    e.name = '(FiberFailure) SubmissionError';
    e[Symbol.for('effect/Cause')] = undefined; // not a real Cause; the plain `cause` chain carries the reason
    e.cause = { _tag: 'SubmissionError', message: 'Transaction submission error', cause: inner };
    return e;
  };
  it('extracts the node custom error code from a nested cause chain', () => {
    const e = fiber({ message: '1010: Invalid Transaction: Custom error: 193' });
    const x = explain(e);
    expect(x.nodeCode).toBe(193);
    expect(x.nodeName).toBe('ReplayProtectionViolation');
    expect(collectMessages(e)).toContain('1010: Invalid Transaction: Custom error: 193');
    const err = submissionError(e);
    expect(err).toBeInstanceOf(SponsorError);
    expect(err.retryable).toBe(false);
    expect(isReplay(err)).toBe(true);
    expect(submissionError(fiber({ message: '1010: Invalid Transaction: Custom error: 115' }))).toMatchObject({ retryable: false, detail: { code: 115, nodeName: 'InvalidProof' } });
  });
  it('transport failures are retryable; node rejections are not', () => {
    expect(submissionError(new Error('WebSocket disconnected: Normal Closure'))).toMatchObject({ code: 'SUBMISSION_FAILED', retryable: true });
    expect(submissionError(new Error('connect ECONNREFUSED 127.0.0.1:9944'))).toMatchObject({ retryable: true });
    expect(submissionError(fiber({ message: '1010: Invalid Transaction: Custom error: 138' }))).toMatchObject({ retryable: false, detail: { code: 138 } });
    // pool-level dedupe right after inclusion (seen live in the Phase 2 e2e) is an "already applied" answer, like 193
    const dup = submissionError(fiber({ message: '1013: Transaction Already Imported: Any { .. }' }));
    expect(isReplay(dup)).toBe(true);
    expect(isReplay(submissionError(fiber({ message: '1010: Invalid Transaction: Custom error: 196' })))).toBe(false);
  });
  it('"could not balance dust" is a retryable sponsoring failure (all coins in flight)', () => {
    expect(sponsoringError(new Error('Insufficient Funds: could not balance dust'))).toMatchObject({ code: 'SPONSORING_FAILED', retryable: true });
    expect(sponsoringError(new Error('proof server returned 500'))).toMatchObject({ code: 'SPONSORING_FAILED', retryable: true });
    expect(sponsoringError(new Error('binding commitment mismatch'))).toMatchObject({ code: 'SPONSORING_FAILED', retryable: false });
  });
});

describe('remote adapter (api → worker RPC)', () => {
  const status = { adapter: 'midnight' as const, network: 'undeployed', synced: true, healthy: true, dustBalanceSpecks: 123n, dustCapSpecks: null, nightStars: 5n, dustCoins: 5, dustCoinsInFlight: 1, maxInFlight: 4 };
  const mk = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
    new RemoteSponsorAdapter({ network: 'undeployed', workerUrl: 'http://worker:8081', secret: 's3cret-s3cret-s3cret', maxTxBytes: 512 * 1024, now: () => new Date('2026-09-19T20:55:00Z'), fetch: ((u: URL, i: RequestInit) => handler(String(u), i)) as any });

  it('inspects locally (offline, with the network id) and never calls the worker for it', () => {
    let calls = 0;
    const a = mk(() => { calls++; return new Response('{}'); });
    expect(a.inspect(fx('user-sealed-unpaid-3.bin')).calls[0].entryPoint).toBe('increment');
    expect(calls).toBe(0);
    expect(() => a.inspect(fx('finalized-deploy.preview.bin'))).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
  it('estimates through the worker with the shared secret; maps worker errors and outages', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const a = mk((url, init) => {
      seen.push({ url, init });
      if (url.endsWith('/internal/estimate')) return new Response(JSON.stringify({ feeSpecks: '4200' }), { status: 200 });
      return new Response(JSON.stringify(walletStatusToWire(status)), { status: 200 });
    });
    expect((await a.estimateFee(new Uint8Array([1, 2, 3]))).feeSpecks).toBe(4200n);
    expect((seen[0].init.headers as any)['x-aetherdust-internal-secret']).toBe('s3cret-s3cret-s3cret');
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ bytes: Buffer.from([1, 2, 3]).toString('base64') });
    expect(await a.walletStatus()).toEqual(status);

    const low = mk(() => new Response(JSON.stringify({ error: { code: 'SPONSOR_BALANCE_LOW', message: 'low', retryable: true, details: { dustSpecks: '1' } } }), { status: 503 }));
    await expect(low.estimateFee(new Uint8Array([1]))).rejects.toMatchObject({ code: 'SPONSOR_BALANCE_LOW', retryable: true, detail: { dustSpecks: '1' } });
    const down = mk(() => { throw new Error('fetch failed'); });
    await expect(down.estimateFee(new Uint8Array([1]))).rejects.toMatchObject({ code: 'SPONSOR_UNAVAILABLE', retryable: true });
    await expect(a.sponsor()).rejects.toMatchObject({ code: 'SPONSOR_UNAVAILABLE' });
  });
  it('wallet status survives the wire round-trip', () => {
    expect(walletStatusFromWire(JSON.parse(JSON.stringify(walletStatusToWire(status))))).toEqual(status);
  });
});
