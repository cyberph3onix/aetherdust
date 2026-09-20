/**
 * Phase 2 end-to-end on a real `undeployed` Midnight stack (node + indexer + proof server), the way the system is
 * deployed: api process (RemoteSponsorAdapter → worker RPC) + worker process (MidnightSponsorAdapter, genesis-funded
 * sponsor) + Postgres, and a Node-side USER wallet holding 0 NIGHT / 0 DUST that calls `counter.increment` with fees
 * unpaid. Proves AC1/AC2 with real transactions and re-runs AC3–AC10 + kill-and-restart + reconciliation on real bytes.
 *
 * Two modes:
 *   in-process (default)   api + worker + Postgres are started inside the test; every assertion runs.
 *   external               AETHERDUST_E2E_API_URL=http://localhost:8080 AETHERDUST_ADMIN_TOKEN=… → the test drives a
 *                          deployed stack (e.g. `docker compose --profile local-midnight`); worker-internal assertions skip.
 *
 *   spikes/sponsor-spike/deploy/native/stack.sh up      (or: docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --profile local-midnight up -d --wait midnight-node indexer proof-server)
 *   pnpm test:e2e                                        (AETHERDUST_E2E=1; ~3 min: wallet sync + ~20 s per confirmation)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import { loadConfig, midnightEndpoints } from '@aetherdust/config';
import { dustToSpecks } from '@aetherdust/core';
import { listEvents, transition, withTx } from '@aetherdust/db';
import { RemoteSponsorAdapter, createSponsorAdapter, inspectFinalizedBytes, type ConfirmationResult, type SponsorAdapter } from '@aetherdust/midnight';
import { buildSponsorWallet, waitForSync, type SponsorWallet } from '@aetherdust/midnight/wallet';
import type { MidnightSponsorAdapter } from '../../packages/midnight/src/midnight/adapter.js';
import { buildInternalServer, Worker, type WorkerDeps } from '@aetherdust/worker';
import { makeLimiter, type Deps } from '../../apps/api/src/deps.js';
import { buildServer } from '../../apps/api/src/server.js';
import { closeTestPool, testPool, truncateAll } from '../db.js';
import { buildUserWallet, deployCounter, findCounter, publicKeysOf, readCounter, selfPayingProviders, snapshot, userProviders } from './user-wallet.js';

const E2E = process.env.AETHERDUST_E2E === '1';
const EXTERNAL = process.env.AETHERDUST_E2E_API_URL;
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const ADMIN = EXTERNAL ? process.env.AETHERDUST_ADMIN_TOKEN! : 'e2e-admin-token-0123456789';
const SECRET = 'e2e-internal-secret-0123456789';

const env = {
  AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: ADMIN, AETHERDUST_INTERNAL_SECRET: SECRET, AETHERDUST_SPONSOR_ADAPTER: 'midnight',
  AETHERDUST_SPONSOR_SEED: process.env.AETHERDUST_SPONSOR_SEED ?? GENESIS_SEED, AETHERDUST_FEE_MARGIN: '0.25', AETHERDUST_CONFIRM_TIMEOUT_S: '120',
  AETHERDUST_MAX_WAIT_MS: '120000', AETHERDUST_WORKER_POLL_MS: '200', AETHERDUST_MIN_SPONSOR_DUST: '0', AETHERDUST_WORKER_CONCURRENCY: '3',
  AETHERDUST_LOG_LEVEL: process.env.AETHERDUST_LOG_LEVEL ?? 'warn', ...process.env,
} as NodeJS.ProcessEnv;
const ep = midnightEndpoints(loadConfig(env));

let pool: Pool; let sponsor: SponsorAdapter; let internal: FastifyInstance; let api: FastifyInstance; let worker: Worker; let workerDeps: WorkerDeps;
let deployer: SponsorWallet | undefined; // external mode: a funded wallet of our own to deploy the counter
let token: string; let appId: string; let contractAddress: string; let storeDir: string;
let user: Awaited<ReturnType<typeof buildUserWallet>>; let userKeys: { coin: string; enc: string };
let counter: Awaited<ReturnType<typeof findCounter>>;
/** What the DApp does with the sealed, unpaid tx; swapped per test (the level DB behind the providers is opened once). */
let onSealed: (tx: ledger.FinalizedTransaction) => Promise<string> = async () => { throw new Error('onSealed not set'); };

// ---- HTTP helpers: fastify.inject in-process, fetch against a deployed stack ----
interface Res { statusCode: number; headers: Record<string, string>; json: () => any }
const call = async (method: 'GET' | 'POST' | 'PUT', url: string, auth: string, body?: unknown): Promise<Res> => {
  if (!EXTERNAL) {
    const r = await api.inject({ method, url, headers: { authorization: `Bearer ${auth}` }, ...(body ? { payload: body } : {}) });
    return { statusCode: r.statusCode, headers: r.headers as any, json: () => r.json() };
  }
  const r = await fetch(new URL(url, EXTERNAL), { method, headers: { authorization: `Bearer ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { statusCode: r.status, headers: Object.fromEntries(r.headers.entries()), json: () => JSON.parse(text) };
};
const admin = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => call(method, url, ADMIN, body);
const post = (body: Record<string, unknown>, query = '') => call('POST', `/v1/sponsorship/requests${query}`, token, body);
const get = (requestId: string) => call('GET', `/v1/sponsorship/requests/${requestId}`, token);
const usage = async () => (await call('GET', '/v1/usage', token)).json();
const hex = (tx: ledger.FinalizedTransaction) => Buffer.from(tx.serialize()).toString('hex');
const real = (tx: ledger.FinalizedTransaction) => ({ format: 'midnight-ledger-v8', encoding: 'hex', bytes: hex(tx) });
const policyDoc = (entryPoints: string[], over: Record<string, unknown> = {}, rate: Record<string, number> = {}) => ({
  contracts: { [contractAddress]: entryPoints },
  limits: { period: 'daily', global_budget_dust: '5', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.5', ...over },
  rate_limit: { requests_per_minute_per_credential: 1000, requests_per_minute_per_user: 1000, requests_per_minute_per_ip: 10000, ...rate },
  preflight: { min_ttl_remaining_seconds: 300 },
});
const setPolicy = async (entryPoints: string[], over: Record<string, unknown> = {}, rate: Record<string, number> = {}) => {
  expect((await admin('PUT', `/v1/admin/applications/${appId}/policy`, policyDoc(entryPoints, over, rate))).statusCode).toBe(200);
};
/** Capture the user's sealed, unpaid tx for a `counter.increment` without sending it anywhere. */
const sealIncrement = async (): Promise<ledger.FinalizedTransaction> => {
  let sealed: ledger.FinalizedTransaction | undefined;
  onSealed = async (tx) => { sealed = tx; throw new Error('CAPTURED'); };
  await counter.callTx.increment().catch((e) => { if (!String(e?.message).includes('CAPTURED')) throw e; });
  return sealed!;
};
const pollUntil = async (requestId: string, done: (s: any) => boolean, timeoutMs = 120_000, seen: string[] = []) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = (await get(requestId)).json();
    if (seen.at(-1) !== s.status) seen.push(s.status);
    if (done(s)) return s;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${requestId}; last ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
const inFlight = async () => (EXTERNAL ? 0 : (await sponsor.walletStatus()).dustCoinsInFlight);

describe.skipIf(!E2E)(`e2e: sponsored contract calls on undeployed (${EXTERNAL ? 'external api ' + EXTERNAL : 'in-process'})`, () => {
  beforeAll(async () => {
    const health = await fetch(`${ep.node}/health`).then((r) => r.ok).catch(() => false);
    if (!health) throw new Error(`Midnight node not reachable at ${ep.node}; start the local stack first (see file header)`);
    storeDir = mkdtempSync(path.join(tmpdir(), 'aetherdust-e2e-'));
    const log = pino({ level: env.AETHERDUST_LOG_LEVEL });
    let deployWallet: SponsorWallet;
    if (!EXTERNAL) {
      pool = await testPool();
      await truncateAll(pool);
      // worker process
      const config = loadConfig(env);
      sponsor = await createSponsorAdapter(config, 'worker', { log });
      await sponsor.start();
      workerDeps = { config, pool, adapter: sponsor, log, now: () => new Date() };
      internal = buildInternalServer(workerDeps);
      await internal.listen({ host: '127.0.0.1', port: 0 });
      worker = new Worker(workerDeps);
      // api process
      const apiConfig = loadConfig({ ...env, AETHERDUST_WORKER_URL: `http://127.0.0.1:${(internal.server.address() as any).port}` });
      const apiDeps: Deps = { config: apiConfig, pool, adapter: await createSponsorAdapter(apiConfig, 'api'), limiter: makeLimiter(), log, now: () => new Date() };
      expect(apiDeps.adapter).toBeInstanceOf(RemoteSponsorAdapter);
      api = await buildServer(apiDeps);
      deployWallet = (sponsor as MidnightSponsorAdapter).wallet;
    } else {
      expect((await fetch(new URL('/healthz', EXTERNAL))).ok).toBe(true);
      // the deployed worker syncs its wallet on boot (30 s … minutes on a long chain); wait until the api sees it live
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        const w = (await admin('GET', '/v1/admin/wallet')).json();
        if (w.live?.synced) break;
        if (Date.now() > deadline) throw new Error(`deployed worker never reported a synced wallet: ${JSON.stringify(w)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
      deployer = await buildSponsorWallet(GENESIS_SEED, { ...ep, feeOverheadSpecks: 0n, feeBlocksMargin: 5 });
      await waitForSync(deployer, 600_000);
      deployWallet = deployer;
    }
    // a DApp + the counter contract (deployed by a funded wallet, self-paying, unless one is given)
    appId = (await admin('POST', '/v1/admin/applications', { name: `E2E Counter DApp ${Date.now()}` })).json().id;
    token = (await admin('POST', `/v1/admin/applications/${appId}/api-keys`, { env: 'test', label: 'e2e' })).json().token;
    contractAddress = process.env.CONTRACT_ADDRESS ?? (await deployCounter(selfPayingProviders(ep, deployWallet, await publicKeysOf(deployWallet), path.join(storeDir, 'sponsor'))));
    await setPolicy(['increment']);
    user = await buildUserWallet(ep);
    userKeys = await publicKeysOf(user);
    let seals = 0; // distinct TTL per seal → distinct transactions (see userProviders)
    counter = await findCounter(userProviders(ep, user, userKeys, path.join(storeDir, 'user'), (tx) => onSealed(tx), () => new Date(Date.now() + 30 * 60_000 + ++seals * 1000)), contractAddress);
    if (!EXTERNAL) await worker.start();
  }, 15 * 60_000);
  afterAll(async () => {
    await worker?.stop(); await api?.close(); await internal?.close(); await sponsor?.stop(); await user?.facade.stop().catch(() => {}); await deployer?.facade.stop().catch(() => {});
    if (!EXTERNAL) await closeTestPool();
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  });

  it('AC1/AC2: a 0-NIGHT/0-DUST user has counter.increment sponsored and confirmed; the user paid nothing', async () => {
    const userBefore = await snapshot(user);
    expect(userBefore.nightStars).toBe(0n); expect(userBefore.dustSpecks).toBe(0n);
    const wallet = (await admin('GET', '/v1/admin/wallet')).json();
    expect(wallet.live).toMatchObject({ adapter: 'midnight', network: 'undeployed', synced: true });
    expect(wallet.live.dust_coins).toBeGreaterThan(0);
    const before = await readCounter(ep, contractAddress);

    // the DApp's provider: seal with fees unpaid → POST to AetherDust → long-poll → return the id midnight-js should watch
    const requestId = `e2e-${Date.now()}`;
    let posted: any;
    onSealed = async (tx) => {
      const r = await post({ request_id: requestId, user_id: 'alice', contract: contractAddress, entry_point: 'increment', transaction: real(tx) }, '?wait=120000');
      posted = r.json();
      if (r.statusCode !== 202 || posted.status !== 'confirmed') throw new Error(`sponsorship not confirmed: ${r.statusCode} ${JSON.stringify(posted)}`);
      return posted.transaction_id;
    };
    const res = await counter.callTx.increment();
    expect(res.public.blockHeight).toBeGreaterThan(0);

    expect(posted).toMatchObject({ status: 'confirmed', internal_status: 'CONFIRMED', contract: contractAddress, entry_point: 'increment' });
    expect(dustToSpecks(posted.sponsored_dust)).toBeGreaterThan(0n);
    expect(await readCounter(ep, contractAddress)).toBe((before ?? 0n) + 1n);

    // audit trail, budget settled to the real on-chain fee, usage recorded
    const detail = (await admin('GET', `/v1/admin/requests/${posted.id}`)).json();
    expect(detail.events.map((e: any) => e.to)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED']);
    const u = await usage();
    expect(u.totals).toMatchObject({ confirmed: 1, rejected: 0 });
    expect(u.budget.settled_dust).toBe(posted.sponsored_dust);
    expect(u.budget.reserved_dust).toBe('0');

    const userAfter = await snapshot(user);
    expect(userAfter.nightStars).toBe(0n); expect(userAfter.dustSpecks).toBe(0n);
  }, 5 * 60_000);

  it('AC10: the operator can follow a request from submission to confirmation (public status + audit trail)', async () => {
    const sealed = await sealIncrement();
    const r = await post({ request_id: 'e2e-status', user_id: 'alice', transaction: real(sealed) });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ status: 'approved', internal_status: 'RESERVED', estimated_fee_dust: expect.any(String) });
    const seen: string[] = [r.json().status];
    const final = await pollUntil('e2e-status', (s) => ['confirmed', 'failed', 'rejected'].includes(s.status), 120_000, seen);
    expect(final.status).toBe('confirmed');
    expect(final.transaction_id).toMatch(/^00[0-9a-f]{64}$/);
    // statuses only ever move forward
    const order = ['approved', 'submitted', 'confirmed'];
    expect(seen.map((s) => order.indexOf(s))).toEqual([...seen.map((s) => order.indexOf(s))].sort((a, b) => a - b));
    const detail = (await admin('GET', `/v1/admin/requests/${final.id}`)).json();
    expect(detail.events.map((e: any) => e.to)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED']);
    const times = detail.events.map((e: any) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(detail.sponsored_dust).toBe(final.sponsored_dust);
  }, 4 * 60_000);

  it('AC3/AC4/AC7 with real bytes: policy rejections happen before any sponsor work', async () => {
    const sealed = await sealIncrement();
    const bytes = real(sealed);
    const coinsBefore = await inFlight();
    await setPolicy(['register']);
    const r4 = await post({ request_id: 'e2e-ep', user_id: 'bob', transaction: bytes });
    expect(r4.statusCode).toBe(403); expect(r4.json().error.code).toBe('ENTRY_POINT_NOT_ALLOWED');
    await admin('PUT', `/v1/admin/applications/${appId}/policy`, { contracts: { ['ab'.repeat(32)]: ['increment'] }, limits: { global_budget_dust: '5', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.5' } });
    const r3 = await post({ request_id: 'e2e-contract', user_id: 'bob', transaction: bytes });
    expect(r3.statusCode).toBe(403); expect(r3.json().error.code).toBe('CONTRACT_NOT_ALLOWED');
    await setPolicy(['increment'], { max_fee_per_tx_dust: '0.000000000000001' });
    const r7 = await post({ request_id: 'e2e-fee', user_id: 'bob', transaction: bytes });
    expect(r7.statusCode).toBe(402); expect(r7.json().error.code).toBe('TRANSACTION_LIMIT_EXCEEDED');
    expect(await inFlight()).toBe(coinsBefore);
    // rejections consume nothing: once the operator fixes the policy, the same signed transaction is sponsorable
    await setPolicy(['increment']);
    const ok = await post({ request_id: 'e2e-fixed', user_id: 'bob', transaction: bytes }, '?wait=120000');
    expect(ok.statusCode).toBe(202); expect(ok.json().status).toBe('confirmed');
  }, 4 * 60_000);

  it('AC5/AC6 with real bytes: global budget and per-user allowance reject with a real fee estimate, nothing reserved', async () => {
    const sealed = await sealIncrement();
    const before = (await usage()).budget;
    await setPolicy(['increment'], { global_budget_dust: '0.000000000000001' }); // 1 SPECK: below any real reservation
    const r5 = await post({ request_id: 'e2e-global', user_id: 'carol', transaction: real(sealed) });
    expect(r5.statusCode).toBe(402);
    expect(r5.json().error).toMatchObject({ code: 'GLOBAL_BUDGET_EXCEEDED', details: { scope: 'global' } });
    expect(BigInt(r5.json().error.details.requested_specks)).toBeGreaterThan(0n);
    await setPolicy(['increment'], { per_user_budget_dust: '0.000000000000001' });
    const r6 = await post({ request_id: 'e2e-user', user_id: 'carol', transaction: real(sealed) });
    expect(r6.statusCode).toBe(402);
    expect(r6.json().error).toMatchObject({ code: 'USER_LIMIT_EXCEEDED', details: { scope: 'user' } });
    // neither rejection leaked a reservation into the global bucket
    await setPolicy(['increment']);
    const after = (await usage()).budget;
    expect(after.reserved_dust).toBe('0');
    expect(after.settled_dust).toBe(before.settled_dust);
    expect((await get('e2e-global')).json().internal_status).toBe('REJECTED');
    expect((await get('e2e-user')).json().internal_status).toBe('REJECTED');
  }, 3 * 60_000);

  it('AC8 with real bytes: excess requests are rate limited before inspection and never persisted', async () => {
    const sealed = await sealIncrement();
    await setPolicy([], {}, { requests_per_minute_per_user: 1 }); // nothing allowed → no sponsorship can be triggered either way
    const first = await post({ request_id: 'e2e-rl-1', user_id: 'dave', transaction: real(sealed) });
    expect(first.statusCode).toBe(403); // policy, i.e. it got through the limiter
    const second = await post({ request_id: 'e2e-rl-2', user_id: 'dave', transaction: real(sealed) });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatchObject({ code: 'RATE_LIMITED', details: { key: 'user' } });
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get('e2e-rl-2')).statusCode).toBe(404); // not persisted
    const other = await post({ request_id: 'e2e-rl-3', user_id: 'erin', transaction: real(sealed) });
    expect(other.statusCode).toBe(403); // another user is unaffected
    await setPolicy(['increment']);
  }, 3 * 60_000);

  it('AC9 with real bytes: retry is a replay; the same transaction under a new request_id is a conflict', async () => {
    const sealed = await sealIncrement();
    const bytes = real(sealed);
    const first = await post({ request_id: 'e2e-idem', user_id: 'carol', transaction: bytes }, '?wait=120000');
    expect(first.statusCode).toBe(202); expect(first.json().status).toBe('confirmed');
    const again = await post({ request_id: 'e2e-idem', user_id: 'carol', transaction: bytes });
    expect(again.statusCode).toBe(200); expect(again.json().id).toBe(first.json().id);
    const dup = await post({ request_id: 'e2e-idem-2', user_id: 'carol', transaction: bytes });
    expect(dup.statusCode).toBe(409); expect(dup.json().error.code).toBe('DUPLICATE_REQUEST');
    expect((await get('e2e-idem')).json().internal_status).toBe('CONFIRMED');
  }, 4 * 60_000);

  it.skipIf(!!EXTERNAL)('kill-and-restart (Phase 0 V5b): a crash after the merged bytes were persisted is recovered by resubmitting them', async () => {
    const sealed = await sealIncrement();
    const r = await post({ request_id: 'e2e-crash', user_id: 'dave', transaction: real(sealed) });
    expect(r.statusCode).toBe(202);
    // stop the worker before it can claim, do the sponsoring step "by hand" and persist as SUBMITTED, never submit
    await worker.stop();
    const id = r.json().id as string;
    const sp = await sponsor.sponsor(sealed.serialize(), { ttlMs: 30 * 60_000 });
    await withTx(pool, async (tx) => { await transition(tx, id, 'RESERVED', 'SPONSORING', { patch: { workerId: 'crashed' } }); await transition(tx, id, 'SPONSORING', 'SUBMITTED', { patch: { mergedTxBytes: Buffer.from(sp.mergedBytes), submittedTxHash: sp.mergedTxHash, submittedAt: new Date(), actualFeeSpecks: sp.actualFeeSpecks } }); });
    // "new process": a fresh worker (the same wallet instance stands in for a re-synced one; coin locks are process-local either way)
    const w2 = new Worker(workerDeps);
    const stats = await w2.recover();
    expect(stats.resumed).toBe(1);
    await pollUntil('e2e-crash', (s) => s.internal_status === 'CONFIRMED');
    const ev = await listEvents(pool, id);
    expect(ev.map((e) => e.toStatus)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED']);
    // replaying the same merged bytes is harmless: the node dedupes or answers 193 and the identifier still confirms
    const again = await sponsor.submit(sp.mergedBytes);
    expect(again.identifier).toBe((await get('e2e-crash')).json().transaction_id);
    await w2.stop();
    worker = new Worker(workerDeps); await worker.start();
  }, 5 * 60_000);

  it.skipIf(!!EXTERNAL)('reconciler on a real chain: a confirmation the watcher missed is settled from the indexer by identifier', async () => {
    const sealed = await sealIncrement();
    await worker.stop();
    // an adapter whose first confirmation wait "loses" the indexer (as if it were down) — everything else is the real thing
    let lost = 1;
    const flaky: SponsorAdapter = new Proxy(sponsor, {
      get: (t, k) => {
        if (k === 'waitForConfirmation') return async (id: string, ms: number): Promise<ConfirmationResult> => (lost-- > 0 ? { status: 'timeout' } : t.waitForConfirmation(id, ms));
        const v = Reflect.get(t, k, t); // bind to the real adapter: its private fields are not reachable through the proxy
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const w3 = new Worker({ ...workerDeps, adapter: flaky });
    const r = await post({ request_id: 'e2e-reconcile', user_id: 'frank', transaction: real(sealed) });
    expect(r.statusCode).toBe(202);
    await w3.drain(6000); // ≈ 25 ms per round; a real sponsorship takes ~20 s
    const parked = (await get('e2e-reconcile')).json();
    expect(parked).toMatchObject({ status: 'submitted', internal_status: 'TIMEOUT' });
    expect((await usage()).budget.reserved_dust).not.toBe('0'); // reservation kept while unresolved
    const stats = await w3.reconcile();
    expect(stats).toMatchObject({ confirmed: 1, expired: 0, pending: 0 });
    const done = (await get('e2e-reconcile')).json();
    expect(done.internal_status).toBe('CONFIRMED');
    expect(dustToSpecks(done.sponsored_dust)).toBeGreaterThan(0n);
    expect((await usage()).budget.reserved_dust).toBe('0');
    const ev = await listEvents(pool, done.id);
    expect(ev.map((e) => e.toStatus)).toEqual(['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'TIMEOUT', 'CONFIRMED']);
    await w3.stop();
    worker = new Worker(workerDeps); await worker.start();
  }, 5 * 60_000);

  const WORKER_CONTAINER = process.env.AETHERDUST_E2E_WORKER_CONTAINER; // external mode only: e.g. aetherdust-worker-1
  it.skipIf(!EXTERNAL || !WORKER_CONTAINER)('real kill-and-restart: the worker container is SIGKILLed mid-sponsorship and the request still confirms after restart', async () => {
    const { execFileSync } = await import('node:child_process');
    const sealed = await sealIncrement();
    const r = await post({ request_id: 'e2e-kill', user_id: 'grace', transaction: real(sealed) });
    expect(r.statusCode).toBe(202);
    // kill as soon as the worker has claimed it: either before anything was sent (→ re-queued) or with the merged bytes
    // persisted and the submission in flight (→ resubmitted, Phase 0 V5b). Both must end CONFIRMED.
    const killIn = process.env.AETHERDUST_E2E_KILL_IN ? [process.env.AETHERDUST_E2E_KILL_IN] : ['SPONSORING', 'SUBMITTED'];
    const claimed = await pollUntil('e2e-kill', (s) => killIn.includes(s.internal_status), 60_000);
    execFileSync('docker', ['kill', '-s', 'KILL', WORKER_CONTAINER!]);
    const killedIn = claimed.internal_status;
    await new Promise((res) => setTimeout(res, 3000));
    expect(['SPONSORING', 'SUBMITTED']).toContain((await get('e2e-kill')).json().internal_status); // parked, nothing lost
    execFileSync('docker', ['start', WORKER_CONTAINER!]);
    const done = await pollUntil('e2e-kill', (s) => ['confirmed', 'failed'].includes(s.status), 10 * 60_000); // includes the wallet re-sync
    expect(done.status).toBe('confirmed');
    const detail = (await admin('GET', `/v1/admin/requests/${done.id}`)).json();
    const chain = detail.events.map((e: any) => e.to);
    expect(chain.at(-1)).toBe('CONFIRMED');
    if (killedIn === 'SPONSORING') expect(chain).toContain('RESERVED'); // requeued by recover()
    console.log(`[kill-and-restart] killed while ${killedIn}; events: ${chain.join(' → ')}`);
    expect(dustToSpecks(done.sponsored_dust)).toBeGreaterThan(0n);
  }, 12 * 60_000);

  it.skipIf(!!EXTERNAL)('SPONSOR_BALANCE_LOW: the api refuses when the worker reports the wallet below its floor (no request reserved)', async () => {
    const sealed = await sealIncrement();
    (sponsor as MidnightSponsorAdapter).setMinSponsorDustSpecks(2n ** 200n); // above any possible balance
    try {
      const r = await post({ request_id: 'e2e-low', user_id: 'erin', transaction: real(sealed) });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('SPONSOR_BALANCE_LOW');
      expect((await get('e2e-low')).json().internal_status).toBe('REJECTED');
    } finally { (sponsor as MidnightSponsorAdapter).setMinSponsorDustSpecks(0n); }
    expect((await usage()).budget.reserved_dust).toBe('0');
    // sanity: the real inspector agrees with what the api stored
    expect(inspectFinalizedBytes(sealed.serialize()).calls[0]).toMatchObject({ address: contractAddress, entryPoint: 'increment' });
  }, 3 * 60_000);
});
