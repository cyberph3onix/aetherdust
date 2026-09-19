/**
 * V5b — crash-between-finalize-and-submit recovery.
 * Process A: sponsor a user tx (balance → sign → prove → merge), persist the merged bytes, then "crash" (stop the
 * wallet without submitting). Process B: a fresh facade from the same seed submits the persisted bytes.
 * Answers: does a restart lose the in-flight DUST coin? can persisted merged bytes be submitted later? what state
 * does B see (pending coins)? Also: submitting the SAME persisted bytes twice → second must be rejected (idempotent replay).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { Counter } from '../contract/src/index.js';
import * as Rx from 'rxjs';
import { loadConfig, sponsorSeed, userSeed } from './config.js';
import { deserializeFinalized, summarize, specksToDust } from './inspect.js';
import { buildWallet, publicKeysOf, signRecipeWithFallback, snapshot, ttl, userProviders, waitForSync, type Timings } from './wallet.js';

const cfg = loadConfig();
const OUT = `fixtures/live/restart-${cfg.network}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const findings: { id: string; ok: boolean; detail: string }[] = [];
const finding = (id: string, ok: boolean, detail: string) => { findings.push({ id, ok, detail }); log(`${ok ? '✓' : '✗'} [${id}] ${detail}`); };
const contractAddress = process.env.CONTRACT_ADDRESS!;
if (!contractAddress) throw new Error('CONTRACT_ADDRESS required');
const compiledCounter = CompiledContract.make('counter', Counter.Contract).pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(cfg.zkConfigPath));

const main = async () => {
  // ---- Process A ----
  const sponsorA = await buildWallet(cfg, sponsorSeed(), 'sponsor-A');
  const user = await buildWallet(cfg, userSeed(), 'user');
  await waitForSync(sponsorA); await waitForSync(user);
  const sealed: ledger.FinalizedTransaction[] = [];
  const uk = await publicKeysOf(user);
  const up = userProviders(cfg, user, uk.coin, uk.enc, async (tx) => { sealed.push(tx); throw new Error('CAPTURED'); }, {} as Timings);
  const counter = await findDeployedContract(up, { compiledContract: compiledCounter, privateStateId: 'counterPrivateState', initialPrivateState: { privateCounter: 0 }, contractAddress });
  try { await counter.callTx.increment(); } catch (e) { if (!String((e as Error).message).includes('CAPTURED')) throw e; }
  const before = await snapshot(sponsorA);
  const recipe = await sponsorA.wallet.balanceFinalizedTransaction(sealed[0], { shieldedSecretKeys: sponsorA.shieldedSecretKeys, dustSecretKey: sponsorA.dustSecretKey }, { ttl: ttl(), tokenKindsToBalance: ['dust'] });
  const signed = await signRecipeWithFallback(sponsorA, recipe);
  const merged = await sponsorA.wallet.finalizeRecipe(signed.recipe);
  const bytes = merged.serialize();
  writeFileSync(`${OUT}/merged-unsubmitted.bin`, bytes);
  const duringA = await snapshot(sponsorA);
  finding('V5b-A-pending-coin-locked', duringA.dustPendingCoins > 0 || duringA.dustCoins < before.dustCoins,
    `A after finalize (not submitted): available=${duringA.dustCoins} pending=${duringA.dustPendingCoins} (before: ${before.dustCoins}/${before.dustPendingCoins})`);
  log('A: "crashing" without submitting; merged bytes persisted');
  await sponsorA.wallet.stop();

  // ---- Process B ----
  const sponsorB = await buildWallet(cfg, sponsorSeed(), 'sponsor-B');
  await waitForSync(sponsorB);
  const bStart = await snapshot(sponsorB);
  finding('V5b-B-sees-coin-available-again', bStart.dustCoins === before.dustCoins && bStart.dustPendingCoins === 0,
    `B fresh sync: available=${bStart.dustCoins} pending=${bStart.dustPendingCoins} — in-flight lock is process-local, not persisted`);
  const tx = deserializeFinalized(new Uint8Array(readFileSync(`${OUT}/merged-unsubmitted.bin`)));
  const s = summarize(tx, bytes.byteLength);
  let id = '';
  try {
    id = await sponsorB.wallet.submitTransaction(tx);
    finding('V5b-B-resubmit-persisted-bytes', true, `submitted from B: id=${id} fee=${specksToDust(s.dustFeeSpecks)} DUST`);
  } catch (e) { finding('V5b-B-resubmit-persisted-bytes', false, String((e as Error).message).slice(0, 200)); }
  // Immediately re-submit the SAME bytes: is it rejected (replay) or deduped? Either is safe (identical bytes cannot double-spend).
  {
    const t0 = performance.now();
    try {
      const again = await sponsorB.wallet.submitTransaction(deserializeFinalized(new Uint8Array(readFileSync(`${OUT}/merged-unsubmitted.bin`))));
      finding('V5b-B-immediate-resubmit', true, `same bytes re-submitted right after finality → accepted/deduped in ${Math.round(performance.now() - t0)}ms, same id=${again === id}`);
    } catch (e) { finding('V5b-B-immediate-resubmit', true, `same bytes re-submitted → rejected in ${Math.round(performance.now() - t0)}ms: ${String((e as Error).message).slice(0, 120)}`); }
  }
  // Wait for B to observe the spend (coin set changes), then re-submit once more: after sync the replay must be rejected.
  const bEnd = await Rx.firstValueFrom(sponsorB.wallet.state().pipe(
    Rx.throttleTime(1000), Rx.filter((st) => st.isSynced), Rx.map(() => null),
    Rx.switchMap(async () => snapshot(sponsorB)),
    Rx.filter((sn) => JSON.stringify(sn.dustCoinIds) !== JSON.stringify(bStart.dustCoinIds)),
    Rx.timeout({ first: 90_000, with: () => Rx.throwError(() => new Error('coin set never changed')) }),
  )).catch(async (e) => { log(String(e)); return snapshot(sponsorB); });
  finding('V5b-B-coin-set-changed-once', JSON.stringify(bEnd.dustCoinIds) !== JSON.stringify(bStart.dustCoinIds) && bEnd.dustCoins === bStart.dustCoins,
    `B after sync: available=${bEnd.dustCoins} pending=${bEnd.dustPendingCoins}`);
  {
    const t0 = performance.now();
    try {
      const again = await sponsorB.wallet.submitTransaction(deserializeFinalized(new Uint8Array(readFileSync(`${OUT}/merged-unsubmitted.bin`))));
      finding('V5b-B-resubmit-after-sync-rejected', false, `ACCEPTED after sync?! ${again} (${Math.round(performance.now() - t0)}ms)`);
    } catch (e) { finding('V5b-B-resubmit-after-sync-rejected', true, `rejected in ${Math.round(performance.now() - t0)}ms (replay protection, node code 193)`); }
  }
  writeFileSync(`${OUT}/report.json`, json({ findings, before, duringA, bStart, bEnd, ids: s.identifiers, txHash: s.txHash }));
  log(`report → ${OUT}/report.json`);
  await Promise.allSettled([sponsorB.wallet.stop(), user.wallet.stop()]);
  process.exit(findings.some((f) => !f.ok) ? 1 : 0);
};
main().catch((e) => { console.error(e); process.exit(2); });
