import { describe, expect, it } from 'vitest';
import {
  assertTransition, canTransition, checkFeeLimit, dustToSpecks, evaluatePolicy, fits, generateApiKey, hashSecret, MemoryRateLimitStore,
  mulCeil, parseApiKey, parsePolicy, periodBounds, RateLimiter, reservationFor, specksToDust, verifySecret, type TxSummary,
} from './index.js';

const ADDR = 'ae439fd430094aa22e33e7a02e702d1ed98f79fe2268b64fa37b68f6f71ccba6';
const summary = (over: Partial<TxSummary> = {}): TxSummary => ({
  format: 'mock', txHash: 'h', identifiers: ['id'], byteLength: 3000, calls: [{ segment: 1, address: ADDR, entryPoint: 'increment' }],
  deploys: 0, maintenanceUpdates: 0, hasDustActions: false, dustSpendCount: 0, dustFeeSpecks: 0n,
  minIntentTtl: new Date(Date.now() + 3_600_000), ...over,
});
const policy = parsePolicy({ contracts: { [ADDR]: ['increment', 'register'] }, limits: { global_budget_dust: '100', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' } });
const now = new Date();

describe('specks', () => {
  it('round-trips DUST decimals exactly', () => {
    expect(dustToSpecks('0.1')).toBe(100_000_000_000_000n);
    expect(dustToSpecks('100')).toBe(100n * 10n ** 15n);
    expect(dustToSpecks('0.000000000000001')).toBe(1n);
    expect(specksToDust(333_695_616_553_999n)).toBe('0.333695616553999');
    expect(specksToDust(0n)).toBe('0');
    expect(() => dustToSpecks('1e3')).toThrow();
    expect(() => dustToSpecks('0.0000000000000001')).toThrow();
  });
  it('mulCeil rounds up', () => {
    expect(mulCeil(100n, 1.05)).toBe(105n);
    expect(mulCeil(101n, 1.05)).toBe(107n);
    expect(reservationFor(1000n, 0.1)).toBe(1100n);
  });
});

describe('policy engine', () => {
  it('approves an allowlisted single call', () => expect(evaluatePolicy(policy, { summary: summary(), now }).ok).toBe(true));
  it('rejects disabled policy first', () => {
    const r = evaluatePolicy({ ...policy, enabled: false }, { summary: summary(), now });
    expect(r).toMatchObject({ ok: false, code: 'POLICY_DISABLED' });
  });
  it('rejects unknown contract', () => {
    const r = evaluatePolicy(policy, { summary: summary({ calls: [{ segment: 1, address: 'ff'.repeat(32), entryPoint: 'increment' }] }), now });
    expect(r).toMatchObject({ ok: false, code: 'CONTRACT_NOT_ALLOWED' });
  });
  it('rejects unknown entry point', () => {
    const r = evaluatePolicy(policy, { summary: summary({ calls: [{ segment: 1, address: ADDR, entryPoint: 'drain' }] }), now });
    expect(r).toMatchObject({ ok: false, code: 'ENTRY_POINT_NOT_ALLOWED' });
  });
  it('rejects deploys, empty, dust-carrying and multi-call txs', () => {
    expect(evaluatePolicy(policy, { summary: summary({ deploys: 1, calls: [] }), now })).toMatchObject({ ok: false, code: 'CONTRACT_NOT_ALLOWED', rule: 'R4' });
    expect(evaluatePolicy(policy, { summary: summary({ calls: [] }), now })).toMatchObject({ ok: false, code: 'INVALID_REQUEST', rule: 'R2' });
    expect(evaluatePolicy(policy, { summary: summary({ hasDustActions: true, dustSpendCount: 1 }), now })).toMatchObject({ ok: false, rule: 'R6' });
    const two = summary({ calls: [{ segment: 1, address: ADDR, entryPoint: 'increment' }, { segment: 2, address: ADDR, entryPoint: 'register' }] });
    expect(evaluatePolicy(policy, { summary: two, now })).toMatchObject({ ok: false, rule: 'R2b' });
    expect(evaluatePolicy({ ...policy, allow_multiple_calls: true }, { summary: two, now }).ok).toBe(true);
  });
  it('rejects claim mismatches (fail closed on DApp lies)', () => {
    expect(evaluatePolicy(policy, { summary: summary(), claimedContract: 'ff'.repeat(32), now })).toMatchObject({ ok: false, rule: 'R5' });
    expect(evaluatePolicy(policy, { summary: summary(), claimedEntryPoint: 'register', now })).toMatchObject({ ok: false, rule: 'R5' });
    expect(evaluatePolicy(policy, { summary: summary(), claimedContract: ADDR.toUpperCase(), claimedEntryPoint: 'increment', now }).ok).toBe(true);
  });
  it('rejects short TTL and oversize', () => {
    expect(evaluatePolicy(policy, { summary: summary({ minIntentTtl: new Date(now.getTime() + 60_000) }), now })).toMatchObject({ ok: false, rule: 'R8' });
    expect(evaluatePolicy(policy, { summary: summary({ byteLength: 10_000_000 }), now })).toMatchObject({ ok: false, rule: 'R7' });
  });
  it('fee limit', () => {
    expect(checkFeeLimit(policy, dustToSpecks('0.1')).ok).toBe(true);
    expect(checkFeeLimit(policy, dustToSpecks('0.1') + 1n)).toMatchObject({ ok: false, code: 'TRANSACTION_LIMIT_EXCEEDED' });
  });
  it('policy schema normalises addresses and defaults', () => {
    const p = parsePolicy({ contracts: { [ADDR.toUpperCase()]: ['x'] }, limits: { global_budget_dust: 1, per_user_budget_dust: '0.5', max_fee_per_tx_dust: '0.01' } });
    expect(Object.keys(p.contracts)[0]).toBe(ADDR);
    expect(p.limits.period).toBe('daily');
    expect(p.rate_limit.requests_per_minute_per_credential).toBe(60);
    expect(() => parsePolicy({ contracts: { nothex: [] }, limits: { global_budget_dust: 1, per_user_budget_dust: 1, max_fee_per_tx_dust: 1 } })).toThrow();
  });
});

describe('budget', () => {
  it('period bounds are UTC-aligned', () => {
    const d = periodBounds('daily', new Date('2026-09-20T13:45:00Z'));
    expect(d.start.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(d.end.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    const h = periodBounds('hourly', new Date('2026-09-20T13:45:00Z'));
    expect(h.start.toISOString()).toBe('2026-09-20T13:00:00.000Z');
  });
  it('fits', () => {
    expect(fits({ reserved: 10n, settled: 80n, limit: 100n }, 10n)).toBe(true);
    expect(fits({ reserved: 10n, settled: 80n, limit: 100n }, 11n)).toBe(false);
  });
});

describe('state machine', () => {
  it('allows the happy path and blocks illegal jumps', () => {
    for (const [a, b] of [['RECEIVED', 'RESERVED'], ['RESERVED', 'SPONSORING'], ['SPONSORING', 'SUBMITTED'], ['SUBMITTED', 'CONFIRMED']] as const) expect(canTransition(a, b)).toBe(true);
    expect(canTransition('CONFIRMED', 'RESERVED')).toBe(false);
    expect(canTransition('REJECTED', 'RESERVED')).toBe(false);
    expect(() => assertTransition('RECEIVED', 'CONFIRMED')).toThrow(/illegal/);
  });
});

describe('api keys', () => {
  it('generate/parse/hash/verify', async () => {
    const k = generateApiKey('test');
    const p = parseApiKey(k.token)!;
    expect(p.keyId).toBe(k.keyId);
    const h = await hashSecret(k.secret);
    expect(await verifySecret(k.secret, h)).toBe(true);
    expect(await verifySecret(k.secret + 'x', h)).toBe(false);
    expect(parseApiKey('garbage')).toBeNull();
  });
});

describe('rate limiter', () => {
  it('limits within a window and resets', async () => {
    const rl = new RateLimiter(new MemoryRateLimitStore(), 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect((await rl.hit('k', 3, t0 + i)).allowed).toBe(true);
    const r = await rl.hit('k', 3, t0 + 10);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect((await rl.hit('k', 3, t0 + 2500)).allowed).toBe(true); // two windows later
  });
});
