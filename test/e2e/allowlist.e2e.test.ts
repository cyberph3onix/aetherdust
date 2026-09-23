/**
 * Private Allowlist Access, end to end on a real chain: a member with **0 NIGHT and 0 DUST** proves membership in
 * zero knowledge and is admitted, with AetherDust paying the fee. This is the dApp's whole claim, tested rather
 * than asserted — the contract is deployed for real, the proof is produced by the proof server, the transaction is
 * sponsored through the API, and the admission is read back from the ledger.
 *
 * Needs the local `undeployed` stack (see `sponsored.e2e.test.ts` for how to start it) and AETHERDUST_E2E=1.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig, midnightEndpoints } from '@aetherdust/config';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import { createSponsorAdapter, MidnightSponsorAdapter, RemoteSponsorAdapter } from '@aetherdust/midnight';
import { signRecipe, type SponsorWallet } from '@aetherdust/midnight/wallet';
import { buildInternalServer, Worker, type WorkerDeps } from '@aetherdust/worker';
import { createAetherDustClient, createSponsoredMidnightProvider, findAetherDustError } from '@aetherdust/client';
import { buildServer } from '../../apps/api/src/server.js';
import { makeLimiter, type Deps } from '../../apps/api/src/deps.js';
import { closeTestPool, testPool, truncateAll } from '../db.js';
import { Allowlist, commitmentFor, createPrivateState, nullifierFor, witnesses } from '../../examples/allowlist-dapp/contract/index.js';
import { connectorShim } from './connector-shim.js';
import { buildUserWallet, publicKeysOf, snapshot } from './user-wallet.js';

const E2E = process.env.AETHERDUST_E2E === '1';
const ADMIN = 'e2e-admin-token-0123456789';
const SECRET = 'e2e-internal-secret-0123456789';
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const ZK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'allowlist-dapp', 'contract', 'managed', 'allowlist');

const env = {
  AETHERDUST_DATABASE_URL: 'postgres://x', AETHERDUST_ADMIN_TOKEN: ADMIN, AETHERDUST_INTERNAL_SECRET: SECRET,
  AETHERDUST_SPONSOR_ADAPTER: 'midnight', AETHERDUST_SPONSOR_SEED: GENESIS_SEED,
  AETHERDUST_FEE_MARGIN: '0.25', AETHERDUST_CONFIRM_TIMEOUT_S: '120', AETHERDUST_MAX_WAIT_MS: '120000',
  AETHERDUST_WORKER_POLL_MS: '200', AETHERDUST_MIN_SPONSOR_DUST: '0', AETHERDUST_WORKER_CONCURRENCY: '2',
  AETHERDUST_LOG_LEVEL: process.env.AETHERDUST_LOG_LEVEL ?? 'warn', ...process.env,
} as NodeJS.ProcessEnv;
const ep = midnightEndpoints(loadConfig(env));

const compiled = CompiledContract.make('allowlist', Allowlist.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(ZK),
);

let pool: Pool; let sponsor: MidnightSponsorAdapter; let internal: FastifyInstance; let api: FastifyInstance;
let worker: Worker; let workerDeps: WorkerDeps; let apiUrl: string; let storeDir: string;
let contractAddress: string; let token: string; let appId: string;
let user: SponsorWallet; let userKeys: { coin: string; enc: string };
const memberSecret = new Uint8Array(randomBytes(32));
const strangerSecret = new Uint8Array(randomBytes(32));

const admin = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
  api.inject({ method, url, headers: { authorization: `Bearer ${ADMIN}` }, ...(body ? { payload: body as object } : {}) });

/** Providers around any wallet provider, pointed at the allowlist's ZK assets and private state. */
const providersFor = (keys: { coin: string; enc: string }, dir: string, wp: WalletProvider & MidnightProvider) => {
  const zk = new NodeZkConfigProvider<'addMember' | 'claimAccess'>(ZK);
  return {
    privateStateProvider: levelPrivateStateProvider<'allowlistPrivateState'>({
      midnightDbName: dir, privateStateStoreName: 'e2e', accountId: keys.coin,
      privateStoragePasswordProvider: () => `${Buffer.from(keys.coin, 'hex').toString('base64')}!`,
    }),
    publicDataProvider: indexerPublicDataProvider(ep.indexer, ep.indexerWs),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(ep.proofServer, zk),
    walletProvider: wp,
    midnightProvider: wp,
  };
};

/** The operator: a funded wallet that pays for its own deploy and addMember calls. */
const selfPaying = (w: SponsorWallet, keys: { coin: string; enc: string }, dir: string) => providersFor(keys, dir, {
  getCoinPublicKey: () => keys.coin,
  getEncryptionPublicKey: () => keys.enc,
  async balanceTx(tx, t?) {
    const recipe = await w.facade.balanceUnboundTransaction(tx, { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl: t ?? new Date(Date.now() + 30 * 60_000) });
    return w.facade.finalizeRecipe(await signRecipe(w, recipe));
  },
  submitTx: (tx) => w.facade.submitTransaction(tx),
});

const ledgerNow = async () => {
  const st = await indexerPublicDataProvider(ep.indexer, ep.indexerWs).queryContractState(contractAddress);
  return Allowlist.ledger(st!.data);
};

/** What the member's browser does: prove locally, seal with fees unpaid, let AetherDust sponsor and submit. */
const claimAs = async (secret: Uint8Array, dir: string) => {
  const client = createAetherDustClient({ baseUrl: apiUrl, apiKey: token, userId: 'member', waitMs: 30_000, timeoutMs: 240_000 });
  let n = 0;
  const shim = connectorShim(user, () => new Date(Date.now() + 30 * 60_000 + ++n * 1000));
  const sponsored = await createSponsoredMidnightProvider({ client, wallet: shim, requestIdPrefix: 'allowlist' });
  const providers = providersFor(userKeys, dir, sponsored);
  const contract = await findDeployedContract(providers, {
    compiledContract: compiled, privateStateId: 'allowlistPrivateState',
    initialPrivateState: createPrivateState(secret), contractAddress,
  });
  return { result: await contract.callTx.claimAccess(), shim };
};

describe.skipIf(!E2E)('e2e: Private Allowlist Access on undeployed (gasless, in-process AetherDust)', () => {
  beforeAll(async () => {
    const ok = await fetch(`${ep.node}/health`).then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error(`Midnight node not reachable at ${ep.node}; start the local stack first`);
    storeDir = mkdtempSync(path.join(tmpdir(), 'allowlist-e2e-'));
    const log = pino({ level: env.AETHERDUST_LOG_LEVEL });

    pool = await testPool();
    await truncateAll(pool);
    const config = loadConfig(env);
    sponsor = (await createSponsorAdapter(config, 'worker', { log })) as MidnightSponsorAdapter;
    await sponsor.start();
    workerDeps = { config, pool, adapter: sponsor, log, now: () => new Date() };
    internal = buildInternalServer(workerDeps);
    await internal.listen({ host: '127.0.0.1', port: 0 });
    worker = new Worker(workerDeps);

    const apiConfig = loadConfig({ ...env, AETHERDUST_WORKER_URL: `http://127.0.0.1:${(internal.server.address() as { port: number }).port}` });
    const apiDeps: Deps = { config: apiConfig, pool, adapter: await createSponsorAdapter(apiConfig, 'api'), limiter: makeLimiter(), log, now: () => new Date() };
    expect(apiDeps.adapter).toBeInstanceOf(RemoteSponsorAdapter);
    api = await buildServer(apiDeps);
    await api.listen({ host: '127.0.0.1', port: 0 });
    apiUrl = `http://127.0.0.1:${(api.server.address() as { port: number }).port}`;

    // the operator deploys the allowlist and admits one member — paid by the funded sponsor wallet, not by AetherDust
    const operator = sponsor.wallet;
    const opKeys = await publicKeysOf(operator);
    const opProviders = selfPaying(operator, opKeys, path.join(storeDir, 'operator'));
    const ownerSecret = new Uint8Array(randomBytes(32));
    const deployed = await deployContract(opProviders, {
      compiledContract: compiled, privateStateId: 'allowlistPrivateState',
      initialPrivateState: createPrivateState(ownerSecret), args: [commitmentFor(ownerSecret)],
    });
    contractAddress = deployed.deployTxData.public.contractAddress;
    await deployed.callTx.addMember(commitmentFor(memberSecret));

    appId = (await admin('POST', '/v1/admin/applications', { name: `Allowlist DApp ${Date.now()}` })).json().id;
    token = (await admin('POST', `/v1/admin/applications/${appId}/api-keys`, { env: 'test', label: 'e2e' })).json().token;
    expect((await admin('PUT', `/v1/admin/applications/${appId}/policy`, {
      contracts: { [contractAddress]: ['claimAccess'] },
      limits: { period: 'daily', global_budget_dust: '5', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.5' },
      rate_limit: { requests_per_minute_per_credential: 1000, requests_per_minute_per_user: 1000, requests_per_minute_per_ip: 10000 },
      preflight: { min_ttl_remaining_seconds: 300 },
    })).statusCode).toBe(200);

    user = await buildUserWallet(ep);
    userKeys = await publicKeysOf(user);
    await worker.start();
  }, 15 * 60_000);

  afterAll(async () => {
    await worker?.stop(); await api?.close(); await internal?.close(); await sponsor?.stop();
    await user?.facade.stop().catch(() => {});
    await closeTestPool();
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  });

  it('a member holding 0 NIGHT / 0 DUST proves membership and is admitted, with the sponsor paying', async () => {
    const before = await snapshot(user);
    expect(before.nightStars).toBe(0n);
    expect(before.dustSpecks).toBe(0n);
    expect(Number((await ledgerNow()).admissions)).toBe(0);

    const { result, shim } = await claimAs(memberSecret, path.join(storeDir, 'member'));
    expect(result.public.blockHeight).toBeGreaterThan(0);
    expect(shim.calls).toEqual([{ payFees: false }]); // the wallet sealed it without paying — that is the whole trick

    const led = await ledgerNow();
    expect(Number(led.admissions)).toBe(1);
    const stamps = [...led.nullifiers];
    expect(stamps).toHaveLength(1);
    // exactly the nullifier this secret produces, and nothing that points back at the member
    expect(Buffer.from(stamps[0]!).equals(Buffer.from(nullifierFor(memberSecret)))).toBe(true);
    expect(Buffer.from(stamps[0]!).equals(Buffer.from(commitmentFor(memberSecret)))).toBe(false);
    expect(led.members.findPathForLeaf(stamps[0]!)).toBeUndefined();

    // the member paid nothing; AetherDust settled the real fee
    const after = await snapshot(user);
    expect(after.nightStars).toBe(0n);
    expect(after.dustSpecks).toBe(0n);
    const usage = (await api.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.totals.confirmed).toBe(1);
    expect(Number(usage.totals.sponsored_dust)).toBeGreaterThan(0);
  }, 6 * 60_000);

  it('the same member cannot be admitted twice — the nullifier is already spent', async () => {
    const err = await claimAs(memberSecret, path.join(storeDir, 'member-again')).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/already claimed/i);
    expect(Number((await ledgerNow()).admissions)).toBe(1); // unchanged
  }, 6 * 60_000);

  it('someone who is not on the list cannot be admitted', async () => {
    const err = await claimAs(strangerSecret, path.join(storeDir, 'stranger')).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not on the allowlist|path is not for this member/i);
    expect(findAetherDustError(err)).toBeUndefined(); // refused by the circuit, before AetherDust is ever asked
    expect(Number((await ledgerNow()).admissions)).toBe(1);
  }, 6 * 60_000);
});
