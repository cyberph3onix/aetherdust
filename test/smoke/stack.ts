/**
 * A whole AetherDust in one process, for the dashboard smoke test: embedded Postgres (or
 * AETHERDUST_TEST_DATABASE_URL), the api, a mock-sponsor worker, and seed traffic — one confirmed sponsorship,
 * one policy rejection and one in-flight request, so every dashboard page has something to show.
 *
 * Run standalone (`pnpm smoke:stack`) to poke at the dashboard by hand — with AETHERDUST_SMOKE_WORKER=loop the
 * worker keeps polling, so new requests are sponsored too. Playwright starts it as a `webServer` and stops it again.
 */
import { loadConfig } from '@aetherdust/config';
import { dustToSpecks } from '@aetherdust/core';
import { createPool, migrate } from '@aetherdust/db';
import { MockSponsorAdapter } from '@aetherdust/midnight';
import { buildServer } from '../../apps/api/src/server.js';
import { makeLimiter } from '../../apps/api/src/deps.js';
import { createApiMetrics } from '../../apps/api/src/metrics.js';
import { createWorkerMetrics, Worker } from '../../apps/worker/src/index.js';
import pino from 'pino';
import type { Pool } from 'pg';

export const ADMIN_TOKEN = 'smoke-admin-token-0123456789';
export const CONTRACT = 'ab'.repeat(32);
const PORT = Number(process.env.AETHERDUST_SMOKE_PORT ?? 8099);

/**
 * A day of history so the charts have a shape. These rows go through the same tables the dashboard reads
 * (`sponsorship_requests` + `usage_records`); only their timestamps are older than this process.
 */
const backfill = async (pool: Pool, applicationId: string, hours = 22) => {
  const summary = (id: string) => JSON.stringify({
    format: 'mock', txHash: id, identifiers: [id], byteLength: 512, networkId: 'mock', calls: [{ address: CONTRACT, entryPoint: 'increment', segment: 0 }],
    deploys: 0, maintenanceUpdates: 0, hasDustActions: false, dustFeeSpecks: '0', minIntentTtl: null,
  });
  const users = ['alice', 'bob', 'carol', 'dave'];
  for (let h = hours; h > 0; h--) {
    for (let k = 0; k < (h % 3 === 0 ? 3 : 1); k++) {
      const at = new Date(Date.now() - h * 3_600_000 - k * 60_000);
      const id = `backfill-${h}-${k}`;
      const fee = dustToSpecks(k === 0 ? '0.004' : '0.006').toString();
      const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      const r = await pool.query(
        `INSERT INTO sponsorship_requests (application_id, request_id, user_id, tx_format, tx_hash, tx_bytes, tx_summary, policy_version,
           estimated_fee_specks, reserved_specks, actual_fee_specks, period_start, status, submitted_identifier, submitted_at, confirmed_at, block_height, created_at, updated_at)
         VALUES ($1,$2,$3,'mock',$2,'\\x00',$4::jsonb,1,$5,$5,$5,$6,'CONFIRMED',$2,$7,$8,$9,$7,$8) RETURNING id`,
        [applicationId, id, users[(h + k) % users.length], summary(id), fee, day, at, new Date(at.getTime() + 9_000), 1000 + h * 10 + k]);
      await pool.query(
        `INSERT INTO usage_records (request_id, application_id, user_id, contract, entry_point, specks, period_start, created_at) VALUES ($1,$2,$3,$4,'increment',$5,$6,$7)`,
        [r.rows[0].id, applicationId, users[(h + k) % users.length], CONTRACT, fee, day, new Date(at.getTime() + 9_000)]);
    }
  }
};

export const startStack = async () => {
  let databaseUrl = process.env.AETHERDUST_TEST_DATABASE_URL;
  let stopPg = async () => {};
  if (!databaseUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = 55000 + Math.floor(Math.random() * 900);
    const pg = new EmbeddedPostgres({ databaseDir: `.pg-data/smoke-${port}`, user: 'aetherdust', password: 'aetherdust', port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('aetherdust_smoke');
    databaseUrl = `postgres://aetherdust:aetherdust@127.0.0.1:${port}/aetherdust_smoke`;
    stopPg = () => pg.stop().catch(() => {});
  }

  const config = loadConfig({
    AETHERDUST_DATABASE_URL: databaseUrl, AETHERDUST_ADMIN_TOKEN: ADMIN_TOKEN, AETHERDUST_API_PORT: String(PORT),
    AETHERDUST_MOCK_CONFIRM_MS: '5', AETHERDUST_WORKER_POLL_MS: '20', AETHERDUST_CONFIRM_TIMEOUT_S: '5',
  });
  const pool: Pool = createPool(databaseUrl, 10);
  await migrate(pool);
  const log = pino({ level: process.env.AETHERDUST_SMOKE_LOG ?? 'silent' });
  const adapter = new MockSponsorAdapter({ feeSpecks: dustToSpecks('0.004'), confirmMs: 5, dustCoins: 5 });
  const now = () => new Date();
  const api = await buildServer({ config, pool, adapter, limiter: makeLimiter(), log, now, metrics: createApiMetrics({ pool, adapter, log, now }) });
  const workerDeps = { config, pool, adapter, log, now };
  const worker = new Worker(workerDeps);
  (workerDeps as { metrics?: unknown }).metrics = createWorkerMetrics(workerDeps, () => worker.inFlight);
  await api.listen({ host: '127.0.0.1', port: PORT });

  const admin = (method: string, url: string, body?: unknown) =>
    api.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, ...(body ? { payload: body as object } : {}) });

  // ---- seed ----
  const appId = (await admin('POST', '/v1/admin/applications', { name: 'CounterDApp' })).json().id as string;
  const token = (await admin('POST', `/v1/admin/applications/${appId}/api-keys`, { env: 'test', label: 'smoke' })).json().token as string;
  await admin('PUT', `/v1/admin/applications/${appId}/policy`, {
    contracts: { [CONTRACT]: ['increment'] },
    limits: { period: 'daily', global_budget_dust: '10', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' },
    rate_limit: { requests_per_minute_per_credential: 600, requests_per_minute_per_user: 600, requests_per_minute_per_ip: 6000 },
    preflight: { min_ttl_remaining_seconds: 60 },
  });
  const sponsor = (requestId: string, userId: string, calls: { address: string; entryPoint: string }[]) =>
    api.inject({ method: 'POST', url: '/v1/sponsorship/requests', headers: { authorization: `Bearer ${token}` },
      payload: { request_id: requestId, user_id: userId, transaction: { format: 'mock', id: requestId, calls } } });

  for (const [i, user] of ['alice', 'bob', 'carol'].entries()) {
    await sponsor(`smoke-${i}`, user, [{ address: CONTRACT, entryPoint: 'increment' }]);
  }
  await worker.drain();
  await sponsor('smoke-rejected', 'mallory', [{ address: 'cd'.repeat(32), entryPoint: 'increment' }]); // CONTRACT_NOT_ALLOWED
  await worker.snapshot();
  await backfill(pool, appId);
  // by default the worker only drains what the seed created, so the smoke assertions are deterministic;
  // AETHERDUST_SMOKE_WORKER=loop starts the polling loop, for poking the dashboard (or the load test) by hand
  if (process.env.AETHERDUST_SMOKE_WORKER === 'loop') await worker.start();

  const stop = async () => { await worker.stop(); await api.close(); await pool.end(); await stopPg(); };
  return { url: `http://127.0.0.1:${PORT}`, appId, token, adminToken: ADMIN_TOKEN, stop };
};

// standalone: keep running until killed
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startStack();
  // eslint-disable-next-line no-console
  console.log(`aetherdust smoke stack on ${s.url} (admin token: ${ADMIN_TOKEN})`);
  const bye = async () => { await s.stop(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
