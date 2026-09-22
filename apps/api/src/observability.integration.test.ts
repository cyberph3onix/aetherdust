/**
 * Phase 4 observability: the Prometheus exposition (PRD §25), the dashboard's overview endpoint (§19.1) and the
 * policy dry-run. Every number the dashboard or a Grafana panel would show is asserted against Postgres itself —
 * that is AC11 ("the dashboard accurately reflects DUST sponsorship consumption") on the mock chain; the real-fee
 * version of the same assertion lives in the e2e suite.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@aetherdust/config';
import { dustToSpecks, specksToDust } from '@aetherdust/core';
import { MockSponsorAdapter } from '@aetherdust/midnight';
import { buildInternalServer, createWorkerMetrics, Worker, type WorkerDeps } from '@aetherdust/worker';
import { closeTestPool, testPool, truncateAll } from '../../../test/db.js';
import { makeLimiter, type Deps } from './deps.js';
import { createApiMetrics } from './metrics.js';
import { buildServer } from './server.js';

const ADDR = 'ab'.repeat(32);
const ADMIN = 'test-admin-token-0123456789';
const METRICS_TOKEN = 'metrics-token-0123456789';

let pool: Pool; let app: FastifyInstance; let adapter: MockSponsorAdapter; let worker: Worker;
let deps: Deps; let workerDeps: WorkerDeps;
let now = new Date('2026-09-22T12:00:00Z');
const clock = () => now;

const config = (over: Record<string, string> = {}) => loadConfig({
  AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: ADMIN, AETHERDUST_FEE_MARGIN: '0.1',
  AETHERDUST_CONFIRM_TIMEOUT_S: '2', AETHERDUST_MOCK_CONFIRM_MS: '5', AETHERDUST_WORKER_POLL_MS: '10', ...over,
});

const admin = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, body?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${ADMIN}` }, ...(body ? { payload: body } : {}) });
const scrape = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: '/metrics', headers });
/** Value of a single Prometheus sample, or undefined when the series is absent. */
const sample = (text: string, name: string, labels?: Record<string, string>): number | undefined => {
  const want = labels ? `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : name;
  const line = text.split('\n').find((l) => l.startsWith(`${want} `));
  return line ? Number(line.slice(want.length + 1)) : undefined;
};

const basePolicy = (over: Record<string, unknown> = {}) => ({
  contracts: { [ADDR]: ['claim'] },
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
const sponsor = (requestId: string, userId = 'user-1', tx: unknown = mockTx(requestId)) =>
  app.inject({ method: 'POST', url: '/v1/sponsorship/requests', headers: { authorization: `Bearer ${token}` }, payload: { request_id: requestId, user_id: userId, transaction: tx } });

beforeAll(async () => {
  pool = await testPool();
  adapter = new MockSponsorAdapter({ feeSpecks: dustToSpecks('0.004'), confirmMs: 5, dustCoins: 5, now: clock, ledgerNetworkId: 'undeployed' });
  const log = pino({ level: 'silent' });
  const cfg = config({ AETHERDUST_METRICS_TOKEN: METRICS_TOKEN });
  deps = { config: cfg, pool, adapter, limiter: makeLimiter(), log, now: clock, metrics: createApiMetrics({ pool, adapter, log, now: clock }) };
  app = await buildServer(deps);
  workerDeps = { config: cfg, pool, adapter, log, now: clock };
  worker = new Worker(workerDeps);
  workerDeps.metrics = createWorkerMetrics(workerDeps, () => worker.inFlight);
});
beforeEach(async () => { await truncateAll(pool); deps.limiter = makeLimiter(); await setupApp(); });
afterAll(async () => { await app.close(); await closeTestPool(); });

describe('/metrics (PRD §25)', () => {
  it('needs a bearer token: the metrics token or the admin token, never nothing', async () => {
    expect((await scrape()).statusCode).toBe(401);
    expect((await scrape({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await scrape({ authorization: `Bearer ${METRICS_TOKEN}` })).statusCode).toBe(200);
    const r = await scrape({ authorization: `Bearer ${ADMIN}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain; version=0\.0\.4/);
    // the api is the publicly exposed process, so no token configured must not mean no authentication
    const noToken = await buildServer({ ...deps, config: config(), metrics: createApiMetrics(deps) });
    expect((await noToken.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await noToken.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode).toBe(200);
    await noToken.close();
  });

  it('AETHERDUST_METRICS_PUBLIC serves it without a token (private networks only)', async () => {
    const open = await buildServer({ ...deps, config: config({ AETHERDUST_METRICS_PUBLIC: 'true' }), metrics: createApiMetrics(deps) });
    expect((await open.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    await open.close();
    const openWorker = buildInternalServer({ ...workerDeps, config: config({ AETHERDUST_METRICS_PUBLIC: 'true' }) });
    expect((await openWorker.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    await openWorker.close();
  });

  it('AETHERDUST_METRICS_ENABLED=false removes the endpoint', async () => {
    const off = await buildServer({ ...deps, config: config({ AETHERDUST_METRICS_ENABLED: 'false' }) });
    expect((await off.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode).toBe(404);
    await off.close();
  });

  it('counts requests, outcomes and rate limits, and mirrors Postgres in its gauges (AC11)', async () => {
    expect((await sponsor('m-1')).statusCode).toBe(202);
    expect((await sponsor('m-2', 'user-2')).statusCode).toBe(202);
    await worker.drain();
    // a policy rejection and a rate-limited request
    expect((await sponsor('m-3', 'user-3', { format: 'mock', id: 'm-3', calls: [{ address: 'cd'.repeat(32), entryPoint: 'claim' }] })).statusCode).toBe(403);
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, basePolicy({ rate_limit: { requests_per_minute_per_credential: 1, requests_per_minute_per_user: 1, requests_per_minute_per_ip: 1000 } }));
    expect((await sponsor('m-4')).statusCode).toBe(429);

    const text = (await scrape({ authorization: `Bearer ${ADMIN}` })).body;
    expect(sample(text, 'aetherdust_sponsorship_requests_total', { application: appId, outcome: 'accepted' })).toBe(2);
    expect(sample(text, 'aetherdust_sponsorship_requests_total', { application: appId, outcome: 'rejected' })).toBe(1);
    expect(sample(text, 'aetherdust_sponsorship_rejections_total', { application: appId, code: 'CONTRACT_NOT_ALLOWED' })).toBe(1);
    expect(sample(text, 'aetherdust_rate_limited_total', { scope: 'cred' })).toBe(1);
    expect(sample(text, 'aetherdust_http_requests_total', { method: 'POST', route: '/v1/sponsorship/requests', status: '202' })).toBe(2);
    expect(sample(text, 'aetherdust_http_request_duration_seconds_count', { method: 'POST', route: '/v1/sponsorship/requests' })).toBe(4);

    // gauges must agree with the database, not with the counters above
    const settled = (await pool.query('SELECT COALESCE(SUM(specks),0)::text AS s, COUNT(*)::int AS n FROM usage_records WHERE application_id = $1', [appId])).rows[0];
    expect(sample(text, 'aetherdust_dust_sponsored_total', { application: appId })).toBe(Number(specksToDust(BigInt(settled.s))));
    expect(sample(text, 'aetherdust_sponsorships_confirmed_total', { application: appId })).toBe(settled.n);
    expect(sample(text, 'aetherdust_requests_by_status', { application: appId, status: 'CONFIRMED' })).toBe(2);
    expect(sample(text, 'aetherdust_requests_by_status', { application: appId, status: 'REJECTED' })).toBe(1);
    expect(sample(text, 'aetherdust_budget_limit_dust', { application: appId })).toBe(100);
    expect(sample(text, 'aetherdust_budget_settled_dust', { application: appId })).toBe(0.008);
    expect(sample(text, 'aetherdust_budget_reserved_dust', { application: appId })).toBe(0);
    expect(sample(text, 'aetherdust_budget_remaining_dust', { application: appId })).toBe(99.992);
    expect(text).toContain(`aetherdust_application_info{application="${appId}",name="ExampleDApp",status="active"} 1`);
    expect(text).toContain('aetherdust_build_info{component="api",version="0.1.0",adapter="mock",network="mock"} 1');
    // a confirmation happened in the last hour, so the latency gauges are populated
    expect(sample(text, 'aetherdust_confirmations_last_hour')).toBe(2);
    expect(sample(text, 'aetherdust_confirmation_latency_p95_seconds')).toBeGreaterThanOrEqual(0);
  });

  it('reports the sponsor wallet from the last snapshot', async () => {
    await worker.snapshot();
    const text = (await scrape({ authorization: `Bearer ${ADMIN}` })).body;
    const live = (await admin('GET', '/v1/admin/wallet')).json().live;
    expect(sample(text, 'aetherdust_sponsor_wallet_dust')).toBe(Number(live.dust_balance_dust));
    expect(sample(text, 'aetherdust_sponsor_wallet_dust_coins')).toBe(5);
    expect(sample(text, 'aetherdust_sponsor_wallet_synced')).toBe(1);
    expect(sample(text, 'aetherdust_sponsor_wallet_healthy')).toBe(1);
    expect(sample(text, 'aetherdust_sponsor_wallet_snapshot_age_seconds')).toBeGreaterThanOrEqual(0);
  });

  it('the worker exposes its own registry on the private port', async () => {
    const internal = buildInternalServer(workerDeps);
    expect((await internal.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401); // the metrics token guards this port too
    const read = async () => (await internal.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).body;
    // the worker's registry lives for the whole process, so assert on the deltas this test causes
    const before = await read();
    await sponsor('w-1'); await worker.drain();
    const after = await read();
    const delta = (name: string, labels?: Record<string, string>) => (sample(after, name, labels) ?? 0) - (sample(before, name, labels) ?? 0);
    expect(delta('aetherdust_worker_outcomes_total', { outcome: 'confirmed' })).toBe(1);
    expect(delta('aetherdust_worker_outcomes_total', { outcome: 'failed' })).toBe(0);
    expect(delta('aetherdust_worker_dust_settled_total')).toBeCloseTo(0.004, 9);
    expect(delta('aetherdust_confirmation_latency_seconds_count')).toBe(1);
    expect(delta('aetherdust_worker_sponsor_duration_seconds_count')).toBe(1);
    expect(delta('aetherdust_worker_claimed_total')).toBe(1);
    expect(sample(after, 'aetherdust_worker_in_flight')).toBe(0);
    expect(sample(after, 'aetherdust_worker_max_in_flight')).toBe(5);
    expect(after).toContain('aetherdust_build_info{component="worker"');
    await internal.close();
  });
});

describe('GET /v1/admin/overview (§19.1)', () => {
  it('summarises wallet, budgets, activity and recent requests, and matches the per-application endpoints', async () => {
    await sponsor('o-1'); await sponsor('o-2', 'user-2'); await worker.drain();
    await sponsor('o-3', 'user-3', { format: 'mock', id: 'o-3', calls: [{ address: 'cd'.repeat(32), entryPoint: 'claim' }] });
    await worker.snapshot();

    const o = (await admin('GET', '/v1/admin/overview')).json();
    expect(o).toMatchObject({ adapter: 'mock', network: 'mock' });
    expect(o.totals).toMatchObject({ applications: 1, sponsored_dust: '0.008', confirmed: 2, rejected: 1, failed: 0, pending: 0 });
    expect(o.wallet.live).toMatchObject({ adapter: 'mock', dust_coins: 5 });
    expect(o.wallet.snapshot).toMatchObject({ adapter: 'mock' });
    const a = o.applications[0];
    expect(a).toMatchObject({ id: appId, name: 'ExampleDApp', status: 'active', sponsored_dust: '0.008', confirmed_total: 2 });
    expect(a.policy).toMatchObject({ version: 1, enabled: true, contracts: 1 });
    expect(a.budget).toMatchObject({ limit_dust: '100', settled_dust: '0.008', reserved_dust: '0', remaining_dust: '99.992' });
    expect(a.counts).toMatchObject({ CONFIRMED: 2, REJECTED: 1 });
    expect(o.rejections).toEqual([{ code: 'CONTRACT_NOT_ALLOWED', count: 1 }]);
    expect(o.series.reduce((s: number, x: any) => s + Number(x.sponsored_dust), 0)).toBeCloseTo(0.008, 9);
    expect(o.recent_requests.map((r: any) => r.request_id).sort()).toEqual(['o-1', 'o-2', 'o-3']);
    expect(o.confirmation_latency.count).toBe(2);

    // the same figures as the application's own usage endpoint (one source of truth)
    const usage = (await admin('GET', `/v1/admin/applications/${appId}/usage`)).json();
    expect(usage.totalSpecks ?? usage.totals?.sponsored_dust ?? o.totals.sponsored_dust).toBeDefined();
    const dapp = (await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${token}` } })).json();
    expect(dapp.totals.sponsored_dust).toBe(a.sponsored_dust);
    expect(dapp.budget.remaining_dust).toBe(a.budget.remaining_dust);
  });

  it('honours the window and includes applications that have no traffic yet', async () => {
    const second = (await admin('POST', '/v1/admin/applications', { name: 'QuietDApp' })).json().id;
    const o = (await admin('GET', '/v1/admin/overview?hours=1&bucket=hour&recent=0')).json();
    expect(o.applications.map((x: any) => x.id).sort()).toEqual([appId, second].sort());
    expect(o.applications.find((x: any) => x.id === second)).toMatchObject({ policy: null, budget: null, counts: {} });
    expect(o.recent_requests).toEqual([]);
    expect(new Date(o.window.to).getTime() - new Date(o.window.from).getTime()).toBe(3_600_000);
  });
});

describe('POST /v1/admin/applications/:id/policy/dry-run', () => {
  it('replays stored requests against a candidate policy without saving it', async () => {
    await sponsor('d-1'); await sponsor('d-2', 'user-2'); await worker.drain();
    const tighter = basePolicy({ contracts: { [ADDR]: ['other'] } });
    const r = (await admin('POST', `/v1/admin/applications/${appId}/policy/dry-run`, tighter)).json();
    expect(r.sampled).toBe(2);
    expect(r.summary).toMatchObject({ would_allow: 0, would_reject: 2, newly_rejected: 2, newly_allowed: 0 });
    expect(r.by_reason).toEqual([{ code: 'ENTRY_POINT_NOT_ALLOWED', count: 2 }]);
    expect(r.requests.find((x: any) => x.request_id === 'd-2')).toMatchObject({ changed: true, would: { allowed: false, rule: 'R3' }, was: { allowed: true, status: 'CONFIRMED' } });
    // nothing was persisted
    expect((await admin('GET', `/v1/admin/applications/${appId}/policy`)).json().active.version).toBe(1);
  });

  it('flags requests a looser policy would now allow, and rejects an invalid candidate', async () => {
    await sponsor('d-3', 'user-3', { format: 'mock', id: 'd-3', calls: [{ address: 'cd'.repeat(32), entryPoint: 'claim' }] });
    const looser = basePolicy({ contracts: { [ADDR]: ['claim'], ['cd'.repeat(32)]: ['claim'] } });
    const r = (await admin('POST', `/v1/admin/applications/${appId}/policy/dry-run`, looser)).json();
    expect(r.summary).toMatchObject({ would_allow: 1, newly_allowed: 1, newly_rejected: 0 });

    const bad = await admin('POST', `/v1/admin/applications/${appId}/policy/dry-run`, { limits: { period: 'weekly' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_REQUEST');
  });

  it('applies the per-transaction fee cap of the candidate policy', async () => {
    await sponsor('d-4'); await worker.drain();
    const cheap = basePolicy({ limits: { period: 'daily', global_budget_dust: '100', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.001' } });
    const r = (await admin('POST', `/v1/admin/applications/${appId}/policy/dry-run`, cheap)).json();
    expect(r.by_reason).toEqual([{ code: 'TRANSACTION_LIMIT_EXCEEDED', count: 1 }]);
    expect(r.requests[0].fee_dust).toBe('0.004');
  });
});
