/**
 * V4 — what happens when N sponsorships hit ONE sponsor DUST wallet at once?
 * DUST spends are 1-to-1 self-spends of a Dust UTXO, so parallel balancing may contend for the same coin.
 * We prepare N sealed user txs (sequentially — proving), then sponsor them (a) all in parallel, (b) strictly serial,
 * and record success/failure, error classes and latencies for each mode.
 * Run: N=4 pnpm concurrency   (requires CONTRACT_ADDRESS from a previous `pnpm spike`, or deploys one)
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Counter } from '../contract/src/index.js';
import { loadConfig, sponsorSeed, userSeed } from './config.js';
import { specksToDust } from './inspect.js';
import { sponsorAndSubmit } from './sponsor.js';
import { buildWallet, publicKeysOf, registerForDust, selfPayingProviders, snapshot, userProviders, waitForSync, type Timings } from './wallet.js';

const cfg = loadConfig();
const N = Number(process.env.N ?? 4);
const OUT = `fixtures/live/concurrency-${cfg.network}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

const compiledCounter = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(cfg.zkConfigPath));
const counterOpts = { compiledContract: compiledCounter, privateStateId: 'counterPrivateState' as const, initialPrivateState: { privateCounter: 0 } };

const main = async () => {
  const sponsor = await buildWallet(cfg, sponsorSeed(), 'sponsor');
  const user = await buildWallet(cfg, userSeed(), 'user');
  await waitForSync(sponsor); await waitForSync(user);
  await registerForDust(sponsor, log);
  const sk = await publicKeysOf(sponsor);
  const sp = selfPayingProviders(cfg, sponsor, sk.coin, sk.enc);
  let contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) contractAddress = (await deployContract(sp, counterOpts)).deployTxData.public.contractAddress;
  log(`contract ${contractAddress}; sponsor before:`, json(await snapshot(sponsor)));

  // Capture N sealed (unpaid) user txs by intercepting submitTx. Each call is built against current chain state.
  const sealedTxs: ledger.FinalizedTransaction[] = [];
  const uk = await publicKeysOf(user);
  const capture = async (tx: ledger.FinalizedTransaction) => { sealedTxs.push(tx); throw new Error('CAPTURED'); };
  const up = userProviders(cfg, user, uk.coin, uk.enc, capture, {} as Timings);
  const counter = await findDeployedContract(up, { ...counterOpts, contractAddress });
  for (let i = 0; i < N; i++) {
    try { await counter.callTx.increment(); } catch (e) { if (!String((e as Error).message).includes('CAPTURED')) throw e; }
    log(`prepared user tx ${i + 1}/${N}`);
  }

  const run = async (mode: 'parallel' | 'serial', txs: ledger.FinalizedTransaction[]) => {
    const t0 = performance.now();
    const results: any[] = [];
    if (mode === 'parallel') {
      const settled = await Promise.allSettled(txs.map((tx) => sponsorAndSubmit(sponsor, tx)));
      for (const s of settled) results.push(s.status === 'fulfilled' ? { ok: true, ...s.value } : { ok: false, error: String((s.reason as Error).message).slice(0, 200) });
    } else {
      for (const tx of txs) {
        try { results.push({ ok: true, ...(await sponsorAndSubmit(sponsor, tx)) }); }
        catch (e) { results.push({ ok: false, error: String((e as Error).message).slice(0, 200) }); }
      }
    }
    const wall = Math.round(performance.now() - t0);
    // wait for confirmations of the successful ones (bounded)
    const confirmed: string[] = [];
    await Promise.allSettled(results.filter((r) => r.ok).map(async (r) => {
      await Promise.race([sp.publicDataProvider.watchForTxData(r.id), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 90_000))]);
      confirmed.push(r.id);
    }));
    return { mode, n: txs.length, wallMs: wall, submitted: results.filter((r) => r.ok).length, confirmed: confirmed.length, results };
  };

  const half = Math.ceil(sealedTxs.length / 2);
  const par = await run('parallel', sealedTxs.slice(0, half));
  log('parallel:', json(par));
  const ser = await run('serial', sealedTxs.slice(half));
  log('serial:', json(ser));
  const after = await snapshot(sponsor);
  const out = { network: cfg.network, N, contractAddress, parallel: par, serial: ser, sponsorAfter: after,
    totalFeeDust: specksToDust([...par.results, ...ser.results].filter((r) => r.ok).reduce((a, r) => a + BigInt(r.feeSpecks), 0n)) };
  writeFileSync(`${OUT}/report.json`, json(out));
  log(`report → ${OUT}/report.json`);
  await Promise.allSettled([sponsor.wallet.stop(), user.wallet.stop()]);
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(2); });
