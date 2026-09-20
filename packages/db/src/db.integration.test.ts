import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeTestPool, testPool, truncateAll } from '../../../test/db.js';
import { createApiKey, createApplication, findApiKey, getActivePolicy, putPolicy } from './index.js';
import { getBudget, release, reserve, settle } from './budgets.js';
import { claimNext, findByRequestId, insertReceived, listEvents, StaleTransitionError, transition } from './requests.js';
import { isUniqueViolation, withTx } from './client.js';
import { parseApiKey, verifySecret, type TxSummary } from '@aetherdust/core';

let pool: Pool;
const ADDR = 'ae439fd430094aa22e33e7a02e702d1ed98f79fe2268b64fa37b68f6f71ccba6';
const summary = (hash: string): TxSummary => ({ format: 'mock', txHash: hash, identifiers: [hash], byteLength: 100, calls: [{ segment: 1, address: ADDR, entryPoint: 'increment' }], deploys: 0, maintenanceUpdates: 0, hasDustActions: false, dustSpendCount: 0, dustFeeSpecks: 0n, minIntentTtl: null });
const period = { periodStart: new Date('2026-09-20T00:00:00Z'), periodEnd: new Date('2026-09-21T00:00:00Z') };

beforeEach(async () => { pool = await testPool(); await truncateAll(pool); });
afterAll(closeTestPool);

describe('applications & keys', () => {
  it('creates an app, a key, and verifies the key', async () => {
    const app = await createApplication(pool, 'ExampleDApp');
    const { key, token } = await createApiKey(pool, app.id, 'test', 'ci');
    const parsed = parseApiKey(token)!;
    const found = (await findApiKey(pool, parsed.keyId))!;
    expect(found.id).toBe(key.id);
    expect(await verifySecret(parsed.secret, found.secretHash)).toBe(true);
    expect(found.applicationStatus).toBe('active');
  });
  it('policy versions append', async () => {
    const app = await createApplication(pool, 'a');
    const doc = { contracts: { [ADDR]: ['increment'] }, limits: { global_budget_dust: '100', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' } };
    expect((await putPolicy(pool, app.id, doc)).version).toBe(1);
    expect((await putPolicy(pool, app.id, { ...doc, enabled: false })).version).toBe(2);
    expect((await getActivePolicy(pool, app.id))!.policy.enabled).toBe(false);
    await expect(putPolicy(pool, app.id, { contracts: {}, limits: {} } as any)).rejects.toThrow();
  });
});

describe('budget reservations', () => {
  it('50 concurrent reservations against a limit of 10 units admit exactly 10', async () => {
    const app = await createApplication(pool, 'a');
    const args = { applicationId: app.id, userId: 'u1', ...period, globalLimit: 10n, userLimit: 1000n, amount: 1n };
    const results = await Promise.all(Array.from({ length: 50 }, () => withTx(pool, async (tx) => {
      const r = await reserve(tx, args);
      if (!r.ok) throw Object.assign(new Error('budget'), { scope: r.scope });
      return true;
    }).catch((e) => e.scope as string)));
    expect(results.filter((r) => r === true)).toHaveLength(10);
    expect(results.filter((r) => r === 'global')).toHaveLength(40);
    const g = (await getBudget(pool, app.id, 'global', '*', period.periodStart))!;
    expect(g.reserved).toBe(10n);
  });
  it('per-user limit is independent of global; settle/release adjust correctly', async () => {
    const app = await createApplication(pool, 'a');
    const base = { applicationId: app.id, ...period, globalLimit: 100n, userLimit: 3n, amount: 2n };
    expect((await withTx(pool, (tx) => reserve(tx, { ...base, userId: 'u1' }))).ok).toBe(true);
    const second = await withTx(pool, async (tx) => { const r = await reserve(tx, { ...base, userId: 'u1' }); if (!r.ok) throw Object.assign(new Error('x'), { r }); return r; }).catch((e) => e.r);
    expect(second).toMatchObject({ ok: false, scope: 'user' });
    // the failed attempt's global increment must have been rolled back
    expect((await getBudget(pool, app.id, 'global', '*', period.periodStart))!.reserved).toBe(2n);
    expect((await withTx(pool, (tx) => reserve(tx, { ...base, userId: 'u2' }))).ok).toBe(true);
    await withTx(pool, (tx) => settle(tx, { applicationId: app.id, userId: 'u1', periodStart: period.periodStart }, 2n, 1n));
    const u1 = (await getBudget(pool, app.id, 'user', 'u1', period.periodStart))!;
    expect(u1).toMatchObject({ reserved: 0n, settled: 1n });
    await withTx(pool, (tx) => release(tx, { applicationId: app.id, userId: 'u2', periodStart: period.periodStart }, 2n));
    expect((await getBudget(pool, app.id, 'global', '*', period.periodStart))!).toMatchObject({ reserved: 0n, settled: 1n });
  });
});

describe('requests', () => {
  it('enforces request_id and tx_hash uniqueness, optimistic transitions, audit trail, SKIP LOCKED claims', async () => {
    const app = await createApplication(pool, 'a');
    const base = { applicationId: app.id, userId: 'u', txFormat: 'mock', txBytes: Buffer.from('x'), policyVersion: 1, ttlAt: null };
    const r1 = await withTx(pool, (tx) => insertReceived(tx, { ...base, requestId: 'req-1', txHash: 'h1', txSummary: summary('h1') }));
    await expect(withTx(pool, (tx) => insertReceived(tx, { ...base, requestId: 'req-1', txHash: 'h2', txSummary: summary('h2') }))).rejects.toSatisfy((e) => isUniqueViolation(e, 'sponsorship_requests_application_id_request_id_key'));
    await expect(withTx(pool, (tx) => insertReceived(tx, { ...base, requestId: 'req-2', txHash: 'h1', txSummary: summary('h1') }))).rejects.toSatisfy((e) => isUniqueViolation(e, 'sponsorship_requests_tx_hash_uidx'));

    await withTx(pool, (tx) => transition(tx, r1.id, 'RECEIVED', 'RESERVED', { patch: { estimatedFeeSpecks: 5n, reservedSpecks: 6n, periodStart: period.periodStart } }));
    await expect(withTx(pool, (tx) => transition(tx, r1.id, 'RECEIVED', 'REJECTED'))).rejects.toBeInstanceOf(StaleTransitionError);
    await expect(withTx(pool, (tx) => transition(tx, r1.id, 'RESERVED', 'CONFIRMED'))).rejects.toThrow(/illegal/);

    // two workers race for one RESERVED row: exactly one wins
    const [a, b] = await Promise.all([withTx(pool, (tx) => claimNext(tx, 'w1')), withTx(pool, (tx) => claimNext(tx, 'w2'))]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const claimed = (a ?? b)!;
    expect(claimed.status).toBe('SPONSORING');
    expect(claimed.attempts).toBe(1);
    await withTx(pool, (tx) => transition(tx, claimed.id, 'SPONSORING', 'SUBMITTED', { patch: { submittedIdentifier: 'id1', submittedAt: new Date(), mergedTxBytes: Buffer.from('m') } }));
    await withTx(pool, (tx) => transition(tx, claimed.id, 'SUBMITTED', 'CONFIRMED', { patch: { actualFeeSpecks: 4n, confirmedAt: new Date(), blockHeight: 12 } }));
    const final = (await findByRequestId(pool, app.id, 'req-1'))!;
    expect(final).toMatchObject({ status: 'CONFIRMED', actualFeeSpecks: 4n, reservedSpecks: 6n, blockHeight: 12, submittedIdentifier: 'id1' });
    expect(final.txSummary.calls[0].address).toBe(ADDR);
    const events = await listEvents(pool, claimed.id);
    expect(events.map((e) => e.toStatus)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED']);
  });
});
