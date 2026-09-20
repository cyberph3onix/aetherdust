import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, parsePolicy } from '@aetherdust/core';
import { deserializeFinalized, envelopeToBytes, inspectFinalizedBytes, MockSponsorAdapter, SponsorError, wellFormedOrThrow } from './index.js';

const F = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fx = (n: string) => new Uint8Array(readFileSync(path.join(F, n)));
const meta = JSON.parse(readFileSync(path.join(F, 'fixture-1.json'), 'utf8'));

describe('ledger inspector on Phase 0 fixtures', () => {
  it('derives the contract call, no dust, identifiers and hash from a real sealed user tx', () => {
    const s = inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'));
    expect(s.format).toBe('midnight-ledger-v8');
    expect(s.calls).toEqual([{ segment: expect.any(Number), address: meta.contractAddress, entryPoint: 'increment' }]);
    expect(s.hasDustActions).toBe(false);
    expect(s.txHash).toBe(meta.userTxHash);
    expect(s.identifiers).toEqual(meta.userIdentifiers);
    expect(s.minIntentTtl).toBeInstanceOf(Date);
  });
  it('sees the sponsor DustSpend and fee in the merged tx', () => {
    const s = inspectFinalizedBytes(fx('merged-sponsored-1.bin'));
    expect(s.hasDustActions).toBe(true);
    expect(s.dustSpendCount).toBe(1);
    expect(s.dustFeeSpecks).toBe(BigInt(meta.actualFeeSpecks));
    expect(s.txHash).toBe(meta.mergedTxHash);
    expect(s.identifiers).toEqual(meta.mergedIdentifiers);
  });
  it('four distinct fixtures have four distinct hashes (usable as unique test transactions)', () => {
    const hashes = [1, 2, 3, 4].map((i) => inspectFinalizedBytes(fx(`user-sealed-unpaid-${i}.bin`)).txHash);
    expect(new Set(hashes).size).toBe(4);
  });
  it('rejects garbage, deploys, and the wrong variant', () => {
    expect(() => inspectFinalizedBytes(new Uint8Array([1, 2, 3]))).toThrow(SponsorError);
    expect(() => inspectFinalizedBytes(new Uint8Array())).toThrow(/empty/);
    expect(() => inspectFinalizedBytes(fx('unproven-call.undeployed.bin'))).toThrow(/not a sealed/);
    expect(inspectFinalizedBytes(fx('finalized-deploy.undeployed.bin')).deploys).toBe(1);
    expect(() => inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'), { maxBytes: 100 })).toThrow(/max 100/);
  });
  it('wellFormed catches a wrong network id, accepts the real user tx', () => {
    const user = deserializeFinalized(fx('user-sealed-unpaid-1.bin'));
    expect(() => wellFormedOrThrow(user, 'undeployed', new Date('2026-09-19T20:55:00Z'))).not.toThrow();
    expect(() => wellFormedOrThrow(user, 'preview', new Date('2026-09-19T20:55:00Z'))).toThrow(/invalid network ID/);
    // R7 through the inspector: wrong network is INVALID_REQUEST; an expired TTL is PREFLIGHT_FAILED
    expect(() => inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'), { networkId: 'preview', now: new Date('2026-09-19T20:55:00Z') }))
      .toThrow(expect.objectContaining({ code: 'INVALID_REQUEST', detail: { rule: 'R7', expected: 'preview' } }));
    expect(() => inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'), { networkId: 'undeployed', now: new Date('2026-09-20T12:00:00Z') }))
      .toThrow(expect.objectContaining({ code: 'PREFLIGHT_FAILED' }));
    expect(inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'), { networkId: 'undeployed', now: new Date('2026-09-19T20:55:00Z') }).calls).toHaveLength(1);
  });
  it('policy engine approves the real fixture under an allowlist and rejects under another', () => {
    const s = inspectFinalizedBytes(fx('user-sealed-unpaid-1.bin'));
    const now = new Date('2026-09-19T20:55:00Z');
    const ok = parsePolicy({ contracts: { [meta.contractAddress]: ['increment'] }, limits: { global_budget_dust: 1, per_user_budget_dust: 1, max_fee_per_tx_dust: 1 } });
    expect(evaluatePolicy(ok, { summary: s, now }).ok).toBe(true);
    const wrong = parsePolicy({ contracts: { [meta.contractAddress]: ['register'] }, limits: { global_budget_dust: 1, per_user_budget_dust: 1, max_fee_per_tx_dust: 1 } });
    expect(evaluatePolicy(wrong, { summary: s, now })).toMatchObject({ ok: false, code: 'ENTRY_POINT_NOT_ALLOWED' });
  });
});

describe('mock adapter', () => {
  it('sponsors real fixture bytes and synthetic mock txs; bounds parallelism by coins; dedupes and replays', async () => {
    const a = new MockSponsorAdapter({ dustCoins: 2, confirmMs: 10 });
    const real = fx('user-sealed-unpaid-2.bin');
    expect(a.inspect(real).format).toBe('midnight-ledger-v8');
    const r1 = await a.sponsor(real, { ttlMs: 60_000 });
    const mock = envelopeToBytes({ format: 'mock', calls: [{ address: 'ab'.repeat(32), entryPoint: 'claim' }], id: 'm1' });
    expect(a.inspect(mock).calls[0].entryPoint).toBe('claim');
    const r2 = await a.sponsor(mock, { ttlMs: 60_000 });
    await expect(a.sponsor(envelopeToBytes({ format: 'mock', calls: [], id: 'm2' }), { ttlMs: 1 })).rejects.toMatchObject({ retryable: true, code: 'SPONSORING_FAILED' });
    const s1 = await a.submit(r1.mergedBytes);
    expect(await a.submit(r1.mergedBytes)).toEqual(s1); // dedupe
    expect(await a.waitForConfirmation(s1.identifier, 1000)).toMatchObject({ status: 'confirmed' });
    expect((await a.walletStatus()).dustCoinsInFlight).toBe(1);
    const again = await a.sponsor(real, { ttlMs: 60_000 });
    await expect(a.submit(again.mergedBytes)).rejects.toMatchObject({ detail: { code: 193 } }); // replay of same user tx
    const s2 = await a.submit(r2.mergedBytes);
    expect(await a.waitForConfirmation(s2.identifier, 1000)).toMatchObject({ status: 'confirmed' });
  });
  it('failure injection', async () => {
    const a = new MockSponsorAdapter({ confirmMs: 1 });
    const mk = (fail: any, id: string) => envelopeToBytes({ format: 'mock', calls: [{ address: 'ab'.repeat(32), entryPoint: 'x' }], id, fail });
    await expect(a.estimateFee(mk('estimate', 'e'))).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' });
    await expect(a.estimateFee(mk('balance-low', 'b'))).rejects.toMatchObject({ code: 'SPONSOR_BALANCE_LOW', retryable: true });
    await expect(a.sponsor(mk('sponsor', 's'), { ttlMs: 1 })).rejects.toMatchObject({ code: 'SPONSORING_FAILED', retryable: false });
    const sub = await a.sponsor(mk('submit', 'u'), { ttlMs: 1 });
    await expect(a.submit(sub.mergedBytes)).rejects.toMatchObject({ code: 'SUBMISSION_FAILED' });
    const c = await a.sponsor(mk('confirm', 'c'), { ttlMs: 1 });
    expect(await a.waitForConfirmation((await a.submit(c.mergedBytes)).identifier, 1000)).toMatchObject({ status: 'failed' });
    const t = await a.sponsor(mk('timeout', 't'), { ttlMs: 1 });
    expect(await a.waitForConfirmation((await a.submit(t.mergedBytes)).identifier, 100)).toMatchObject({ status: 'timeout' });
  });
});
