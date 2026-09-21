/**
 * The SDK against a real AetherDust API over HTTP (api + worker in-process, mock sponsor, real Postgres), using the
 * real Phase 0 transaction bytes: what a DApp does, end to end, minus the chain.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@aetherdust/config';
import { dustToSpecks } from '@aetherdust/core';
import { MockSponsorAdapter } from '@aetherdust/midnight';
import { Worker } from '@aetherdust/worker';
import { makeLimiter, type Deps } from '../../../apps/api/src/deps.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { closeTestPool, testPool, truncateAll } from '../../../test/db.js';
import { AetherDustError, createAetherDustClient, createSponsoredMidnightProvider, toHex, type AetherDustClient } from './index.js';

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'midnight', 'fixtures');
const fixture = (n: number) => new Uint8Array(readFileSync(path.join(FX, `user-sealed-unpaid-${n}.bin`)));
const CONTRACT_1 = JSON.parse(readFileSync(path.join(FX, 'fixture-1.json'), 'utf8')).contractAddress as string;
const CONTRACT_234 = 'ae439fd430094aa22e33e7a02e702d1ed98f79fe2268b64fa37b68f6f71ccba6';
const ADMIN = 'client-it-admin-token-0123456789';
const now = () => new Date('2026-09-19T20:55:00Z'); // the fixtures were sealed on 2026-09-19 with a 1 h TTL

let pool: Pool; let app: FastifyInstance; let worker: Worker; let baseUrl: string; let client: AetherDustClient; let appId: string;

beforeAll(async () => {
  pool = await testPool();
  await truncateAll(pool);
  const config = loadConfig({ AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: ADMIN, AETHERDUST_MOCK_CONFIRM_MS: '5', AETHERDUST_WORKER_POLL_MS: '10', AETHERDUST_MAX_WAIT_MS: '30000' });
  const adapter = new MockSponsorAdapter({ feeSpecks: dustToSpecks('0.004'), confirmMs: 5, dustCoins: 5, now, ledgerNetworkId: 'undeployed' });
  const log = pino({ level: 'silent' });
  const deps: Deps = { config, pool, adapter, limiter: makeLimiter(), log, now };
  app = await buildServer(deps);
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
  worker = new Worker({ config, pool, adapter, log, now });
  await worker.start();
  const admin = (method: 'POST' | 'PUT', url: string, body: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${ADMIN}` }, payload: body });
  appId = (await admin('POST', '/v1/admin/applications', { name: 'SDK test' })).json().id;
  const token = (await admin('POST', `/v1/admin/applications/${appId}/api-keys`, { env: 'test' })).json().token;
  await admin('PUT', `/v1/admin/applications/${appId}/policy`, {
    contracts: { [CONTRACT_1]: ['increment'], [CONTRACT_234]: ['increment'] },
    limits: { period: 'daily', global_budget_dust: '1', per_user_budget_dust: '0.01', max_fee_per_tx_dust: '0.1' },
    rate_limit: { requests_per_minute_per_credential: 1000, requests_per_minute_per_user: 1000, requests_per_minute_per_ip: 10000 },
    preflight: { min_ttl_remaining_seconds: 60 },
  });
  client = createAetherDustClient({ baseUrl, apiKey: token, userId: 'alice', waitMs: 10_000, pollIntervalMs: 50 });
});
afterAll(async () => { await worker?.stop(); await app?.close(); await closeTestPool(); });

describe('@aetherdust/client against the real API', () => {
  it('sponsor(): real sealed bytes → confirmed request with the sponsored fee and audit-visible ids', async () => {
    const r = await client.sponsor({ requestId: 'sdk-1', transaction: fixture(1), contract: CONTRACT_1, entryPoint: 'increment' });
    expect(r).toMatchObject({ status: 'confirmed', internal_status: 'CONFIRMED', contract: CONTRACT_1, entry_point: 'increment', sponsored_dust: '0.004' });
    expect(r.transaction_id).toMatch(/^00[0-9a-f]{64}$/);
    expect(await client.getRequest('sdk-1')).toMatchObject({ id: r.id, status: 'confirmed' });
    const usage = await client.usage();
    expect(usage.totals).toMatchObject({ confirmed: 1 });
  });
  it('retrying the same requestId replays; the same bytes under another requestId conflicts', async () => {
    const again = await client.sponsor({ requestId: 'sdk-1', transaction: fixture(1) });
    expect(again.status).toBe('confirmed');
    await expect(client.sponsor({ requestId: 'sdk-1b', transaction: fixture(1) })).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST', status: 409 });
  });
  it('policy and budget rejections are typed errors that carry the persisted request', async () => {
    const e = await client.sponsor({ requestId: 'sdk-2', transaction: fixture(2), entryPoint: 'register' }).catch((x) => x);
    expect(e).toBeInstanceOf(AetherDustError);
    expect(e).toMatchObject({ code: 'INVALID_REQUEST', status: 400, details: { rule: 'R5' }, request: { internal_status: 'REJECTED' } });
    // per-user allowance 0.01: alice has 0.004 settled; 0.0044 more fits, a third does not
    await client.sponsor({ requestId: 'sdk-3', transaction: fixture(2) });
    const over = await client.sponsor({ requestId: 'sdk-4', transaction: fixture(3) }).catch((x) => x);
    expect(over).toMatchObject({ code: 'USER_LIMIT_EXCEEDED', status: 402, rejectedByPolicy: true });
    expect(over.request.status).toBe('rejected');
  });
  it("until:'approved' returns immediately with the user's own identifier; the outcome can be awaited later", async () => {
    const bob = createAetherDustClient({ baseUrl, apiKey: await appToken(), userId: 'bob', pollIntervalMs: 50 });
    const r = await bob.sponsor({ requestId: 'sdk-5', transaction: fixture(3), until: 'approved' });
    expect(r.status).toBe('approved');
    expect(r.user_transaction_identifiers[0]).toMatch(/^00[0-9a-f]{64}$/);
    const done = await bob.waitForOutcome('sdk-5', { timeoutMs: 20_000 });
    expect(done.status).toBe('confirmed');
  });
  it('the connector-backed midnight-js provider drives the whole flow: balanceTx (fake wallet) → submitTx → identifier', async () => {
    const carol = createAetherDustClient({ baseUrl, apiKey: await appToken(), userId: 'carol', pollIntervalMs: 50 });
    const wallet = {
      async getShieldedAddresses() { return { shieldedCoinPublicKey: 'cpk', shieldedEncryptionPublicKey: 'epk' }; },
      async balanceUnsealedTransaction(_tx: string, o?: { payFees?: boolean }) { expect(o).toEqual({ payFees: false }); return { tx: toHex(fixture(4)) }; },
    };
    const p = await createSponsoredMidnightProvider({ client: carol, wallet, requestIdPrefix: 'dapp' });
    const sealed = await p.balanceTx({ serialize: () => new Uint8Array([0]) } as any);
    const id = await p.submitTx(sealed);
    const r = await carol.getRequest(`dapp:${sealed.transactionHash()}`);
    expect(r).toMatchObject({ status: 'confirmed', transaction_id: id, user_id: 'carol' });
  });
});

const appToken = async () => {
  const r = await app.inject({ method: 'POST', url: `/v1/admin/applications/${appId}/api-keys`, headers: { authorization: `Bearer ${ADMIN}` }, payload: { env: 'test' } });
  return r.json().token as string;
};
