/**
 * Acceptance criteria AC3–AC10 (+ failure paths, recovery, concurrency) against the real API + worker + Postgres,
 * with the mock sponsor adapter. Real Phase 0 transaction bytes are used where the inspector matters.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@aetherdust/config';
import { dustToSpecks, periodBounds, specksToDust } from '@aetherdust/core';
import { getBudget, insertReceived, listByStatus, listEvents, transition, withTx } from '@aetherdust/db';
import { MockSponsorAdapter } from '@aetherdust/midnight';
import { Worker } from '@aetherdust/worker';
import { closeTestPool, testPool, truncateAll } from '../../../test/db.js';
import { makeLimiter, type Deps } from './deps.js';
import { buildServer } from './server.js';

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'midnight', 'fixtures');
const fixtureHex = (n: number) => readFileSync(path.join(FX, `user-sealed-unpaid-${n}.bin`)).toString('hex');
const FIXTURE_CONTRACT_1 = JSON.parse(readFileSync(path.join(FX, 'fixture-1.json'), 'utf8')).contractAddress as string;
const FIXTURE_CONTRACT_234 = 'ae439fd430094aa22e33e7a02e702d1ed98f79fe2268b64fa37b68f6f71ccba6';
const ADDR = 'ab'.repeat(32);
const ADMIN = 'test-admin-token-0123456789';

let pool: Pool; let app: FastifyInstance; let adapter: MockSponsorAdapter; let worker: Worker; let deps: Deps;
let now = new Date('2026-09-20T12:00:00Z');
const clock = () => now;

const config = () => loadConfig({ AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: ADMIN, AETHERDUST_FEE_MARGIN: '0.1', AETHERDUST_CONFIRM_TIMEOUT_S: '2', AETHERDUST_MOCK_CONFIRM_MS: '5', AETHERDUST_WORKER_POLL_MS: '10', AETHERDUST_MIN_TTL_HEADROOM_MS: '1000' });

const admin = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, body?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${ADMIN}` }, ...(body ? { payload: body } : {}) });
const basePolicy = (over: Record<string, unknown> = {}) => ({
  contracts: { [ADDR]: ['claim', 'register'], [FIXTURE_CONTRACT_1]: ['increment'], [FIXTURE_CONTRACT_234]: ['increment'] },
  limits: { period: 'daily', global_budget_dust: '100', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' },
  rate_limit: { requests_per_minute_per_credential: 1000, requests_per_minute_per_user: 1000, requests_per_minute_per_ip: 10000 },
  preflight: { min_ttl_remaining_seconds: 60 },
  ...over,
});
let token: string; let appId: string;
const setupApp = async (policy = basePolicy()) => {
  appId = (await admin('POST', '/v1/admin/applications', { name: 'ExampleDApp' })).json().id;
  token = (await admin('POST', `/v1/admin/applications/${appId}/api-keys`, { env: 'test', label: 'ci' })).json().token;
  expect((await admin('PUT', `/v1/admin/applications/${appId}/policy`, policy)).statusCode).toBe(200);
};
const mockTx = (id: string, extra: Record<string, unknown> = {}) => ({ format: 'mock', id, calls: [{ address: ADDR, entryPoint: 'claim' }], ...extra });
const post = (body: Record<string, unknown>, query = '', tok = token) =>
  app.inject({ method: 'POST', url: `/v1/sponsorship/requests${query}`, headers: { authorization: `Bearer ${tok}` }, payload: body });
const get = (requestId: string) => app.inject({ method: 'GET', url: `/v1/sponsorship/requests/${requestId}`, headers: { authorization: `Bearer ${token}` } });
const sponsor = (requestId: string, userId = 'user-1', tx: unknown = mockTx(requestId), query = '') => post({ request_id: requestId, user_id: userId, transaction: tx }, query);
const until = async (cond: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) { if (Date.now() > deadline) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

beforeAll(async () => {
  pool = await testPool();
  adapter = new MockSponsorAdapter({ feeSpecks: dustToSpecks('0.004'), confirmMs: 5, dustCoins: 5, now: clock, ledgerNetworkId: 'undeployed' });
  const log = pino({ level: 'silent' });
  deps = { config: config(), pool, adapter, limiter: makeLimiter(), log, now: clock };
  app = await buildServer(deps);
  worker = new Worker({ config: deps.config, pool, adapter, log, now: clock });
});
beforeEach(async () => { await truncateAll(pool); deps.limiter = makeLimiter(); await setupApp(); });
afterAll(async () => { await app.close(); await closeTestPool(); });

describe('auth', () => {
  it('rejects missing, garbage and revoked keys; admin routes need the admin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/usage' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: 'Bearer ad_test_000000000000_nopenopenopenopenopenope' } })).statusCode).toBe(401);
    const keys = (await admin('GET', `/v1/admin/applications/${appId}`)).json().keys;
    expect((await admin('DELETE', `/v1/admin/api-keys/${keys[0].id}`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ error: { code: 'AUTH_FAILED' } });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/applications', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ ok: true, adapter: 'mock' });
    await worker.snapshot();
    const wallet = (await admin('GET', '/v1/admin/wallet')).json();
    expect(wallet.live).toMatchObject({ adapter: 'mock', dust_coins: 5, night: '250000000' });
    expect(wallet.snapshot).toMatchObject({ adapter: 'mock', dust_balance_dust: expect.any(String) });
    const detail = (await admin('GET', `/v1/admin/applications/${appId}`)).json();
    expect(detail).toMatchObject({ name: 'ExampleDApp', policy: { version: 1 }, current_period: { limit_dust: '100' } });
    expect((await admin('GET', `/v1/admin/applications/${appId}/usage`)).statusCode).toBe(200);
  });
});

describe('happy path (mock chain)', () => {
  it('AC10/AC11: approves, sponsors, confirms; status, audit trail and usage reflect it', async () => {
    const r = await sponsor('req-1');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ request_id: 'req-1', status: 'approved', estimated_fee_dust: '0.004', reserved_dust: '0.0044' });
    await worker.drain();
    const g = (await get('req-1')).json();
    expect(g).toMatchObject({ status: 'confirmed', sponsored_dust: '0.004', contract: ADDR, entry_point: 'claim' });
    expect(g.transaction_id).toMatch(/^00[0-9a-f]{64}$/);
    const detail = (await admin('GET', `/v1/admin/requests/${g.id}`)).json();
    expect(detail.events.map((e: any) => e.to)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED']);
    const usage = (await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.totals).toMatchObject({ sponsored_dust: '0.004', confirmed: 1, rejected: 0 });
    expect(usage.budget).toMatchObject({ limit_dust: '100', settled_dust: '0.004', reserved_dust: '0', remaining_dust: '99.996' });
    expect(usage.by_entry_point[0]).toMatchObject({ key: `${ADDR}:claim`, count: 1 });
    expect(usage.by_user[0]).toMatchObject({ user_id: 'user-1', sponsored_dust: '0.004' });
  });
  it('?wait= long-polls until confirmed', async () => {
    const p = sponsor('req-w', 'u', mockTx('req-w'), '?wait=5000');
    // the POST is still in flight (auth = scrypt ≈ 100 ms); wait until it is queued before letting the worker run
    await until(async () => (await listByStatus(pool, ['RESERVED'])).some((r) => r.requestId === 'req-w'));
    await worker.drain();
    const r = await p;
    expect(r.statusCode).toBe(202);
    expect(r.json().status).toBe('confirmed');
  });
  it('real Phase 0 bytes go through the real inspector and are sponsored (mock)', async () => {
    now = new Date('2026-09-19T20:55:00Z'); // the fixtures were sealed on 2026-09-19 with a 1h TTL
    const r = await sponsor('req-real', 'u', { format: 'midnight-ledger-v8', encoding: 'hex', bytes: fixtureHex(1) });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ contract: FIXTURE_CONTRACT_1, entry_point: 'increment' });
    await worker.drain();
    expect((await get('req-real')).json().status).toBe('confirmed');
    // claim mismatch fails closed
    const bad = await post({ request_id: 'req-real-2', user_id: 'u', contract: ADDR, transaction: { format: 'midnight-ledger-v8', encoding: 'hex', bytes: fixtureHex(2) } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'INVALID_REQUEST', details: { rule: 'R5' } });
    // garbage bytes never reach the DB
    const garbage = await post({ request_id: 'req-garbage', user_id: 'u', transaction: { format: 'midnight-ledger-v8', encoding: 'hex', bytes: 'deadbeef' } });
    expect(garbage.json().error.code).toBe('INVALID_REQUEST');
    expect((await get('req-garbage')).statusCode).toBe(404);
    // R7: a transaction sealed for another network is rejected before anything is persisted
    const otherNet = await post({ request_id: 'req-preview', user_id: 'u', transaction: { format: 'midnight-ledger-v8', encoding: 'hex', bytes: readFileSync(path.join(FX, 'finalized-deploy.preview.bin')).toString('hex') } });
    expect(otherNet.statusCode).toBe(400);
    expect(otherNet.json().error).toMatchObject({ code: 'INVALID_REQUEST', details: { rule: 'R7', expected: 'undeployed' } });
    expect((await get('req-preview')).statusCode).toBe(404);
    // an expired user tx is a pre-flight failure
    now = new Date('2026-09-20T12:00:00Z');
    const expired = await post({ request_id: 'req-expired', user_id: 'u', transaction: { format: 'midnight-ledger-v8', encoding: 'hex', bytes: fixtureHex(3) } });
    expect(expired.statusCode).toBe(422);
    expect(expired.json().error.code).toBe('PREFLIGHT_FAILED');
  });
  it('settles an actual fee above the reservation and records an OVERSPEND audit event', async () => {
    // reserve = 0.004 × 1.1 = 0.0044 DUST; the chain charges 0.006
    const r = await sponsor('req-over', 'u-over', mockTx('req-over', { actualFeeDust: '0.006' }));
    expect(r.statusCode).toBe(202);
    await worker.drain();
    expect((await get('req-over')).json()).toMatchObject({ status: 'confirmed', sponsored_dust: '0.006' });
    const detail = (await admin('GET', `/v1/admin/requests/${r.json().id}`)).json();
    const over = detail.events.find((e: any) => e.reason_code === 'OVERSPEND');
    expect(over).toMatchObject({ from: 'CONFIRMED', to: 'CONFIRMED', details: { overspendSpecks: (dustToSpecks('0.006') - dustToSpecks('0.0044')).toString() } });
    const { start } = periodBounds('daily', now);
    const user = await getBudget(pool, appId, 'user', 'u-over', start);
    expect(user).toMatchObject({ reserved: 0n, settled: dustToSpecks('0.006') });
  });
});

describe('policy (AC3, AC4, AC7)', () => {
  it('AC3 rejects a non-allowlisted contract without touching the budget', async () => {
    const r = await sponsor('req-c', 'u', mockTx('req-c', { calls: [{ address: 'cd'.repeat(32), entryPoint: 'claim' }] }));
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ status: 'rejected', error: { code: 'CONTRACT_NOT_ALLOWED' } });
    expect((await get('req-c')).json().internal_status).toBe('REJECTED');
    expect(await getBudget(pool, appId, 'global', '*', new Date('2026-09-20T00:00:00Z'))).toBeNull();
  });
  it('AC4 rejects a non-allowlisted entry point', async () => {
    const r = await sponsor('req-e', 'u', mockTx('req-e', { calls: [{ address: ADDR, entryPoint: 'drain' }] }));
    expect(r.json().error.code).toBe('ENTRY_POINT_NOT_ALLOWED');
  });
  it('a rejected transaction can be re-submitted under a new request_id once the policy allows it (nothing was consumed)', async () => {
    const tx = mockTx('req-again', { calls: [{ address: ADDR, entryPoint: 'drain' }] });
    expect((await sponsor('req-again', 'u', tx)).json().error.code).toBe('ENTRY_POINT_NOT_ALLOWED');
    // same request_id → the same (rejected) answer; new request_id + same bytes → allowed, because the first attempt spent nothing
    expect((await sponsor('req-again', 'u', tx)).json()).toMatchObject({ status: 'rejected', error: { code: 'ENTRY_POINT_NOT_ALLOWED' } });
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ contracts: { [ADDR]: ['claim', 'drain'] } }));
    const ok = await sponsor('req-again-2', 'u', tx);
    expect(ok.statusCode).toBe(202);
    await worker.drain();
    expect((await get('req-again-2')).json().internal_status).toBe('CONFIRMED');
    // ...but once it has been sponsored, a third request_id with the same bytes is a conflict
    expect((await sponsor('req-again-3', 'u', tx)).statusCode).toBe(409);
  });
  it('AC7 rejects a fee above the per-transaction limit', async () => {
    const r = await sponsor('req-f', 'u', mockTx('req-f', { feeDust: '0.5' }));
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toMatchObject({ code: 'TRANSACTION_LIMIT_EXCEEDED' });
  });
  it('rejects deploys, dust-carrying txs, short TTLs and disabled policies', async () => {
    expect((await sponsor('d', 'u', mockTx('d', { deploys: 1, calls: [] }))).json().error.code).toBe('CONTRACT_NOT_ALLOWED');
    expect((await sponsor('h', 'u', mockTx('h', { hasDustActions: true }))).json().error.code).toBe('INVALID_REQUEST');
    expect((await sponsor('t', 'u', mockTx('t', { ttlSeconds: 10 }))).json().error.code).toBe('PREFLIGHT_FAILED');
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ enabled: false }));
    expect((await sponsor('off')).json().error.code).toBe('POLICY_DISABLED');
  });
});

describe('budgets (AC5, AC6)', () => {
  it('AC5 global budget: exhaustion rejects, settlement frees the reservation delta', async () => {
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ limits: { period: 'daily', global_budget_dust: '0.01', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' } }));
    expect((await sponsor('g1', 'u1')).statusCode).toBe(202); // reserves 0.0044
    expect((await sponsor('g2', 'u2')).statusCode).toBe(202); // 0.0088
    const r3 = await sponsor('g3', 'u3');
    expect(r3.statusCode).toBe(402);
    expect(r3.json().error).toMatchObject({ code: 'GLOBAL_BUDGET_EXCEEDED', details: { scope: 'global' } });
    await worker.drain(); // settles 2 × 0.004 = 0.008 → 0.002 headroom, still < 0.0044
    expect((await sponsor('g4', 'u4')).json().error.code).toBe('GLOBAL_BUDGET_EXCEEDED');
    const usage = (await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.budget).toMatchObject({ settled_dust: '0.008', reserved_dust: '0', remaining_dust: '0.002' });
    expect(usage.rejections).toEqual([{ code: 'GLOBAL_BUDGET_EXCEEDED', count: 2 }]);
  });
  it('AC6 per-user limit is enforced independently of the global budget', async () => {
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ limits: { period: 'daily', global_budget_dust: '100', per_user_budget_dust: '0.005', max_fee_per_tx_dust: '0.1' } }));
    expect((await sponsor('u1a', 'alice')).statusCode).toBe(202);
    const r = await sponsor('u1b', 'alice');
    expect(r.json().error).toMatchObject({ code: 'USER_LIMIT_EXCEEDED', details: { scope: 'user' } });
    expect((await sponsor('u2a', 'bob')).statusCode).toBe(202);
    // a failed user reservation must not leak into the global bucket
    const g = (await getBudget(pool, appId, 'global', '*', new Date('2026-09-20T00:00:00Z')))!;
    expect(specksToDust(g.reserved)).toBe('0.0088');
  });
  it('budget periods roll over (UTC day)', async () => {
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ limits: { period: 'daily', global_budget_dust: '0.005', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' } }));
    expect((await sponsor('p1', 'u')).statusCode).toBe(202);
    expect((await sponsor('p2', 'u')).statusCode).toBe(402);
    now = new Date('2026-09-21T00:00:01Z');
    expect((await sponsor('p3', 'u')).statusCode).toBe(202);
    now = new Date('2026-09-20T12:00:00Z');
  });
  it('20 concurrent requests under a budget for 10 admit exactly 10 (API + DB path)', async () => {
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ limits: { period: 'daily', global_budget_dust: '0.044', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' } }));
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => sponsor(`c${i}`, `user${i}`)));
    expect(rs.filter((r) => r.statusCode === 202)).toHaveLength(10);
    expect(rs.filter((r) => r.json().error?.code === 'GLOBAL_BUDGET_EXCEEDED')).toHaveLength(10);
    await worker.drain();
    expect((await listByStatus(pool, ['CONFIRMED'])).length).toBe(10);
  });
});

describe('rate limiting (AC8)', () => {
  it('blocks the 4th request in a minute per credential; rate-limited requests are not persisted', async () => {
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ rate_limit: { requests_per_minute_per_credential: 3, requests_per_minute_per_user: 100, requests_per_minute_per_ip: 100 } }));
    for (let i = 0; i < 3; i++) expect((await sponsor(`rl${i}`, `u${i}`)).statusCode).toBe(202);
    const r = await sponsor('rl3', 'u3');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.json().error.code).toBe('RATE_LIMITED');
    expect((await get('rl3')).statusCode).toBe(404);
  });
  it('per-user limit', async () => {
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ rate_limit: { requests_per_minute_per_credential: 100, requests_per_minute_per_user: 1, requests_per_minute_per_ip: 100 } }));
    expect((await sponsor('a', 'same')).statusCode).toBe(202);
    expect((await sponsor('b', 'same')).statusCode).toBe(429);
    expect((await sponsor('c', 'other')).statusCode).toBe(202);
  });
});

describe('idempotency (AC9)', () => {
  it('same request_id + same tx replays; different tx conflicts; same tx under another id conflicts; concurrent retries collapse', async () => {
    const first = await sponsor('idem');
    expect(first.statusCode).toBe(202);
    const replay = await sponsor('idem');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect((await sponsor('idem', 'user-1', mockTx('other'))).json().error.code).toBe('DUPLICATE_REQUEST');
    expect((await sponsor('idem-2', 'user-1', mockTx('idem'))).json().error.code).toBe('DUPLICATE_REQUEST');
    const burst = await Promise.all(Array.from({ length: 25 }, () => sponsor('burst')));
    expect(burst.every((r) => r.statusCode === 202 || r.statusCode === 200)).toBe(true); // never 409/5xx for a same-request_id retry
    expect(new Set(burst.map((r) => r.json().id)).size).toBe(1);
    expect(burst.filter((r) => r.statusCode === 202)).toHaveLength(1);
    await worker.drain();
    const g = (await getBudget(pool, appId, 'global', '*', new Date('2026-09-20T00:00:00Z')))!;
    expect(specksToDust(g.settled)).toBe('0.008'); // idem + burst, once each
  });
});

describe('failure paths release or keep reservations correctly', () => {
  const globalBudget = async () => (await getBudget(pool, appId, 'global', '*', new Date('2026-09-20T00:00:00Z')))!;
  it('sponsoring failure → SPONSORING_FAILED, reservation released', async () => {
    await sponsor('fs', 'u', mockTx('fs', { fail: 'sponsor' })); await worker.drain();
    expect((await get('fs')).json()).toMatchObject({ status: 'failed', internal_status: 'SPONSORING_FAILED' });
    expect((await globalBudget()).reserved).toBe(0n);
  });
  it('node rejection → SUBMISSION_FAILED with the node reason, reservation released', async () => {
    await sponsor('fu', 'u', mockTx('fu', { fail: 'submit' })); await worker.drain();
    const g = (await get('fu')).json();
    expect(g.internal_status).toBe('SUBMISSION_FAILED');
    expect(g.error.message).toMatch(/Custom error: 115/);
    expect((await globalBudget()).reserved).toBe(0n);
  });
  it('dropped on-chain → SUBMISSION_FAILED', async () => {
    await sponsor('fc', 'u', mockTx('fc', { fail: 'confirm' })); await worker.drain();
    expect((await get('fc')).json().internal_status).toBe('SUBMISSION_FAILED');
  });
  it('confirmation timeout → TIMEOUT keeps the reservation; recovery later resolves it', async () => {
    await sponsor('ft', 'u', mockTx('ft', { confirmMs: 2600 })); await worker.drain();
    expect((await get('ft')).json().internal_status).toBe('TIMEOUT');
    expect(specksToDust((await globalBudget()).reserved)).toBe('0.0044');
    await new Promise((r) => setTimeout(r, 700));
    await worker.recover();
    await new Promise((r) => setTimeout(r, 200));
    await worker.drain();
    expect((await get('ft')).json().internal_status).toBe('CONFIRMED');
    expect((await globalBudget())).toMatchObject({ reserved: 0n, settled: dustToSpecks('0.004') });
  });
  it('retryable sponsor errors (all DUST coins in flight) re-queue instead of failing', async () => {
    const small = new MockSponsorAdapter({ feeSpecks: dustToSpecks('0.004'), confirmMs: 40, dustCoins: 2, now: clock });
    const w2 = new Worker({ ...worker['deps' as never] as any, adapter: small, config: { ...deps.config, AETHERDUST_WORKER_CONCURRENCY: 4 } });
    const d2: Deps = { ...deps, adapter: small };
    const app2 = await buildServer(d2);
    for (let i = 0; i < 6; i++) expect((await app2.inject({ method: 'POST', url: '/v1/sponsorship/requests', headers: { authorization: `Bearer ${token}` }, payload: { request_id: `q${i}`, user_id: `u${i}`, transaction: mockTx(`q${i}`) } })).statusCode).toBe(202);
    await w2.drain();
    expect((await listByStatus(pool, ['CONFIRMED'])).length).toBe(6);
    await app2.close();
  });
});

describe('restart recovery (Phase 0 V5)', () => {
  it('SPONSORING rows are re-queued; SUBMITTED rows with persisted bytes are resubmitted (idempotent) and confirmed', async () => {
    // simulate a crash: a request claimed but never processed
    await sponsor('crash-1'); const r1 = (await get('crash-1')).json();
    await withTx(pool, (tx) => transition(tx, r1.id, 'RESERVED', 'SPONSORING', { patch: { workerId: 'dead-worker' } }));
    // and one that was sponsored + persisted but never submitted
    await sponsor('crash-2'); const r2 = (await get('crash-2')).json();
    const bytes = (await withTx(pool, async (tx) => (await tx.query('SELECT tx_bytes FROM sponsorship_requests WHERE id = $1', [r2.id])).rows[0].tx_bytes)) as Buffer;
    const sp = await adapter.sponsor(new Uint8Array(bytes), { ttlMs: 60_000 });
    await withTx(pool, async (tx) => { await transition(tx, r2.id, 'RESERVED', 'SPONSORING'); await transition(tx, r2.id, 'SPONSORING', 'SUBMITTED', { patch: { mergedTxBytes: Buffer.from(sp.mergedBytes), submittedTxHash: sp.mergedTxHash, actualFeeSpecks: sp.actualFeeSpecks } }); });
    const stats = await worker.recover();
    expect(stats).toMatchObject({ requeued: 1, resumed: 1 });
    await new Promise((r) => setTimeout(r, 100));
    await worker.drain();
    expect((await get('crash-1')).json().internal_status).toBe('CONFIRMED');
    expect((await get('crash-2')).json().internal_status).toBe('CONFIRMED');
    const ev = await listEvents(pool, r1.id);
    expect(ev.some((e) => e.reasonCode === 'RECOVERED')).toBe(true);
  });
});
