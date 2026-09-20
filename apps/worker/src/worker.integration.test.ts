/**
 * Worker-side behaviour that Phase 2 adds: the private api→worker RPC (through the real RemoteSponsorAdapter over
 * HTTP) and the reconciler for TIMEOUT/UNKNOWN requests. Mock adapter + real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@aetherdust/config';
import { dustToSpecks, periodBounds } from '@aetherdust/core';
import { createApiKey, createApplication, findByRequestId, getBudget, insertReceived, listEvents, putPolicy, reserve, transition, withTx } from '@aetherdust/db';
import { envelopeToBytes, MockSponsorAdapter, RemoteSponsorAdapter } from '@aetherdust/midnight';
import { closeTestPool, testPool, truncateAll } from '../../../test/db.js';
import { buildInternalServer } from './internal.js';
import { Worker } from './worker.js';
import type { WorkerDeps } from './deps.js';

const ADDR = 'ab'.repeat(32);
const SECRET = 'internal-secret-0123456789';
let pool: Pool; let adapter: MockSponsorAdapter; let deps: WorkerDeps; let worker: Worker; let internal: FastifyInstance; let internalUrl: string;
let now = new Date('2026-09-20T12:00:00Z');
const clock = () => now;
let appId: string;

beforeAll(async () => {
  pool = await testPool();
  adapter = new MockSponsorAdapter({ feeSpecks: dustToSpecks('0.004'), confirmMs: 5, dustCoins: 5, now: clock });
  const config = loadConfig({ AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: 'admin-token-0123456789', AETHERDUST_INTERNAL_SECRET: SECRET, AETHERDUST_CONFIRM_TIMEOUT_S: '1', AETHERDUST_CONFIRM_GRACE_S: '3600', AETHERDUST_MIN_TTL_HEADROOM_MS: '0' });
  deps = { config, pool, adapter, log: pino({ level: 'silent' }), now: clock };
  worker = new Worker(deps);
  internal = buildInternalServer(deps);
  await internal.listen({ host: '127.0.0.1', port: 0 });
  internalUrl = `http://127.0.0.1:${(internal.server.address() as any).port}`;
});
beforeEach(async () => {
  await truncateAll(pool);
  appId = (await createApplication(pool, 'E2E')).id;
  await createApiKey(pool, appId, 'test');
  await putPolicy(pool, appId, { contracts: { [ADDR]: ['claim'] }, limits: { global_budget_dust: '10', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' } });
});
afterAll(async () => { await internal.close(); await closeTestPool(); });

/** A request already RESERVED (what the api leaves for the worker), with an optional mock failure knob. */
const reserved = async (requestId: string, extra: Record<string, unknown> = {}) => {
  const bytes = envelopeToBytes({ format: 'mock', id: requestId, calls: [{ address: ADDR, entryPoint: 'claim' }], ...extra } as any);
  const summary = adapter.inspect(bytes);
  const { start, end } = periodBounds('daily', now);
  const amount = dustToSpecks('0.0044');
  return withTx(pool, async (tx) => {
    const r = await insertReceived(tx, { applicationId: appId, requestId, userId: 'u', txFormat: 'mock', txHash: summary.txHash, txBytes: Buffer.from(bytes), txSummary: summary, policyVersion: 1, ttlAt: summary.minIntentTtl, at: now });
    const ok = await reserve(tx, { applicationId: appId, userId: 'u', periodStart: start, periodEnd: end, globalLimit: dustToSpecks('10'), userLimit: dustToSpecks('1'), amount });
    expect(ok.ok).toBe(true);
    return transition(tx, r.id, 'RECEIVED', 'RESERVED', { patch: { estimatedFeeSpecks: dustToSpecks('0.004'), reservedSpecks: amount, periodStart: start } });
  });
};
const status = async (requestId: string) => (await findByRequestId(pool, appId, requestId))!;
const budget = async () => (await getBudget(pool, appId, 'global', '*', periodBounds('daily', now).start))!;

describe('private api → worker RPC', () => {
  it('rejects requests without the shared secret', async () => {
    expect((await internal.inject({ method: 'GET', url: '/internal/health' })).statusCode).toBe(401);
    expect((await internal.inject({ method: 'GET', url: '/internal/health', headers: { 'x-aetherdust-internal-secret': 'wrong' } })).statusCode).toBe(401);
  });
  it('the RemoteSponsorAdapter (api side) gets estimates and wallet health from the worker over HTTP', async () => {
    const remote = new RemoteSponsorAdapter({ network: 'undeployed', workerUrl: internalUrl, secret: SECRET, maxTxBytes: 512 * 1024 });
    const bytes = envelopeToBytes({ format: 'mock', id: 'rpc-1', calls: [{ address: ADDR, entryPoint: 'claim' }] });
    expect((await remote.estimateFee(bytes)).feeSpecks).toBe(dustToSpecks('0.004'));
    expect(await remote.walletStatus()).toMatchObject({ adapter: 'mock', dustCoins: 5, maxInFlight: 5, dustBalanceSpecks: dustToSpecks('1000') });
    // worker-side SponsorErrors cross the wire with their code and retryability
    const low = envelopeToBytes({ format: 'mock', id: 'rpc-2', calls: [{ address: ADDR, entryPoint: 'claim' }], fail: 'balance-low' } as any);
    await expect(remote.estimateFee(low)).rejects.toMatchObject({ code: 'SPONSOR_BALANCE_LOW', retryable: true });
    const bad = new RemoteSponsorAdapter({ network: 'undeployed', workerUrl: internalUrl, secret: 'nope', maxTxBytes: 512 * 1024 });
    await expect(bad.estimateFee(bytes)).rejects.toMatchObject({ code: 'SPONSOR_UNAVAILABLE' });
  });
});

describe('reconciler (plan §14)', () => {
  it('a TIMEOUT request that later confirms is settled by the reconciler without resubmission', async () => {
    await reserved('slow', { confirmMs: 1500 }); // longer than AETHERDUST_CONFIRM_TIMEOUT_S=1
    await worker.drain();
    expect((await status('slow')).status).toBe('TIMEOUT');
    expect((await budget()).reserved).toBe(dustToSpecks('0.0044'));
    await new Promise((r) => setTimeout(r, 600));
    expect(await worker.reconcile()).toMatchObject({ confirmed: 1, expired: 0, pending: 0 });
    expect((await status('slow')).status).toBe('CONFIRMED');
    expect(await budget()).toMatchObject({ reserved: 0n, settled: dustToSpecks('0.004') });
    const ev = await listEvents(pool, (await status('slow')).id);
    expect(ev.map((e) => e.toStatus)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'TIMEOUT', 'CONFIRMED']);
  });
  it('a TIMEOUT request stays pending inside the grace window and is EXPIRED (reservation released) after it', async () => {
    await reserved('never', { fail: 'timeout' });
    await worker.drain();
    expect((await status('never')).status).toBe('TIMEOUT');
    expect(await worker.reconcile()).toMatchObject({ confirmed: 0, expired: 0, pending: 1 });
    now = new Date(now.getTime() + 2 * 3600_000 + 60_000); // past the 1 h mock TTL + 1 h grace
    expect(await worker.reconcile()).toMatchObject({ expired: 1, pending: 0 });
    expect((await status('never')).status).toBe('EXPIRED');
    expect((await budget()).reserved).toBe(0n);
    now = new Date('2026-09-20T12:00:00Z');
  });
});
