/**
 * Phase 0 live spike — proves DUST fee sponsorship end-to-end on a real Midnight network.
 *
 *   user (0 NIGHT, 0 DUST) ── proves counter.increment() ── balances WITHOUT dust ── signs ── seals
 *        │ sealed tx bytes
 *        ▼
 *   "AetherDust" (in-process here) ── inspect ── policy ── wellFormed ── estimate fee
 *        ── sponsor.balanceFinalizedTransaction(['dust']) ── sign ── prove ── merge ── submit
 *        ▼
 *   network confirms; counter value increments; sponsor DUST decreases; user paid nothing.
 *
 * Answers V1 V2 V3 V5 V6 V8 V9 V11 from IMPLEMENTATION_PLAN.md §1.2-C and records timings/fees.
 * Run: pnpm spike            (undeployed; needs deploy/standalone.yml up)
 *      MIDNIGHT_NETWORK=preprod SPONSOR_SEED=… pnpm spike
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as Rx from 'rxjs';
import { Counter } from '../contract/src/index.js';
import { loadConfig, sponsorSeed, userSeed } from './config.js';
import { checkPolicy, deserializeFinalized, inspectFinalizedBytes, specksToDust, summarize, type TxSummary } from './inspect.js';
import {
  buildWallet, publicKeysOf, registerForDust, selfPayingProviders, signRecipeWithFallback, snapshot, timed, ttl,
  userProviders, waitForSync, type Timings, type WalletContext,
} from './wallet.js';

const cfg = loadConfig();
const OUT = `fixtures/live/${cfg.network}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const report: Record<string, unknown> = { network: cfg.network, startedAt: new Date().toISOString(), versions: {
  ledger: '8.1.0', facade: '4.1.0', midnightJs: '4.1.1', compactc: '0.31.1', compactRuntime: '0.16.0', node: process.version } };
const findings: { id: string; ok: boolean; detail: string }[] = [];
const finding = (id: string, ok: boolean, detail: string) => { findings.push({ id, ok, detail }); log(`${ok ? '✓' : '✗'} [${id}] ${detail}`); };
const errText = (e: unknown): string => {
  // Effect TaggedErrors nest the real reason in `cause`; walk the chain and dump own props.
  const seen = new Set<unknown>(); const parts: string[] = []; let cur: any = e; let depth = 0;
  while (cur && typeof cur === 'object' && !seen.has(cur) && depth++ < 6) {
    seen.add(cur);
    const own: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(cur)) if (!['stack', 'cause'].includes(k)) own[k] = cur[k];
    try { parts.push(`${cur.constructor?.name ?? 'obj'}${JSON.stringify(own, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`); } catch { parts.push(String(cur.message ?? cur)); }
    cur = cur.cause;
  }
  return (parts.join(' ← ') || String(e)).slice(0, 600);
};
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${label} after ${ms}ms`)), ms))]);

const compiledCounter = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(cfg.zkConfigPath),
);
const counterOpts = { compiledContract: compiledCounter, privateStateId: 'counterPrivateState' as const, initialPrivateState: { privateCounter: 0 } };

/** Probe which wellFormed strictness combos a REAL sealed tx passes against a blank ledger state (V9 / pre-flight design). */
const probeWellFormed = (tx: ledger.FinalizedTransaction) => {
  const combos: Record<string, Partial<Record<keyof ledger.WellFormedStrictness, boolean>>> = {
    'sig+limits':            { verifySignatures: true, enforceLimits: true },
    'sig+limits+native':     { verifySignatures: true, enforceLimits: true, verifyNativeProofs: true },
    'sig+limits+contract':   { verifySignatures: true, enforceLimits: true, verifyContractProofs: true },
    'balancing-only':        { enforceBalancing: true },
  };
  const out: Record<string, string> = {};
  for (const [name, flags] of Object.entries(combos)) {
    const s = new ledger.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false; s.enforceLimits = false; s.verifySignatures = false;
    Object.assign(s, flags);
    try { tx.wellFormed(ledger.LedgerState.blank(cfg.network), s, new Date()); out[name] = 'PASS'; }
    catch (e) { out[name] = `FAIL: ${String((e as Error).message ?? e).slice(0, 110)}`; }
  }
  return out;
};

const main = async () => {
  log(`network=${cfg.network} node=${cfg.node} indexer=${cfg.indexer} proofServer=${cfg.proofServer}`);

  // ---------- wallets ----------
  const sponsor = await buildWallet(cfg, sponsorSeed(), 'sponsor');
  const user = await buildWallet(cfg, userSeed(), 'user');
  const t: Timings = {};
  await timed(t, 'sponsor_sync_ms', () => waitForSync(sponsor));
  await timed(t, 'user_sync_ms', () => waitForSync(user));
  await registerForDust(sponsor, log);
  const sponsorBefore = await snapshot(sponsor);
  const userBefore = await snapshot(user);
  log('sponsor:', json(sponsorBefore));
  log('user:   ', json(userBefore));
  finding('AC2-precondition', userBefore.nightStars === 0n && userBefore.dustSpecks === 0n,
    `user holds ${userBefore.nightStars} STAR and ${userBefore.dustSpecks} SPECK (must be 0/0 for a meaningful test)`);
  finding('sponsor-has-dust', sponsorBefore.dustSpecks > 0n, `sponsor DUST = ${specksToDust(sponsorBefore.dustSpecks)} (${sponsorBefore.dustCoins} coins)`);

  // ---------- deploy counter (sponsor pays for itself; ordinary flow) ----------
  const sk = await publicKeysOf(sponsor);
  const sp = selfPayingProviders(cfg, sponsor, sk.coin, sk.enc);
  let contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) {
    const d = await timed(t, 'deploy_counter_ms', () => deployContract(sp, counterOpts));
    contractAddress = d.deployTxData.public.contractAddress;
    log(`deployed counter at ${contractAddress} in ${t.deploy_counter_ms}ms`);
  }
  report.contractAddress = contractAddress;
  const readCounter = async () => {
    const st = await sp.publicDataProvider.queryContractState(contractAddress!);
    return st ? Counter.ledger(st.data).round : null;
  };

  // ---------- the AetherDust step ----------
  const policy = { allowed: { [contractAddress]: ['increment'] }, minTtlRemainingMs: 5 * 60_000 };
  const captured: { userSealed?: Uint8Array; merged?: Uint8Array; userSummary?: TxSummary; mergedSummary?: TxSummary;
    ids: Record<string, unknown>; fees: Record<string, string> } = { ids: {}, fees: {} };

  const aetherdust = async (sealed: ledger.FinalizedTransaction): Promise<string> => {
    // --- api process (offline, untrusted bytes) ---
    const bytes = await timed(t, 'serialize_ms', async () => sealed.serialize());
    captured.userSealed = bytes;
    writeFileSync(`${OUT}/user-sealed-unpaid.bin`, bytes);
    const summary = await timed(t, 'inspect_ms', async () => inspectFinalizedBytes(bytes));
    captured.userSummary = summary;
    log('inspect:', json({ ...summary, identifiers: summary.identifiers.length }));
    finding('V11-inspect-calls', summary.calls.length === 1 && summary.calls[0].address === contractAddress && summary.calls[0].entryPoint === 'increment',
      `derived calls=${JSON.stringify(summary.calls)}`);
    finding('V10-user-tx-has-no-dust', !summary.hasDustActions, `user tx dust spends=${summary.dustSpendCount}`);
    const verdict = checkPolicy(summary, policy);
    if (!verdict.ok) throw new Error(`policy rejected: ${verdict.code} ${verdict.detail}`);
    // --- worker process ---
    const tx = deserializeFinalized(bytes); // from bytes on purpose: this is the wire path
    report.wellFormedProbe_user = await timed(t, 'wellformed_probe_ms', async () => probeWellFormed(tx));
    log('wellFormed probe (user tx):', json(report.wellFormedProbe_user));
    const feeCalc = await timed(t, 'fee_calculate_ms', () => sponsor.wallet.calculateTransactionFee(tx));
    const feeEst = await timed(t, 'fee_estimate_ms', () => sponsor.wallet.estimateTransactionFee(tx, sponsor.dustSecretKey, { ttl: ttl() }));
    captured.fees.calculateTransactionFee = feeCalc.toString();
    captured.fees.estimateTransactionFee = feeEst.toString();
    log(`fees: calculate=${specksToDust(feeCalc)} DUST, estimate(incl. balancing)=${specksToDust(feeEst)} DUST`);
    const recipe = await timed(t, 'sponsor_balance_dust_ms', () =>
      sponsor.wallet.balanceFinalizedTransaction(tx, { shieldedSecretKeys: sponsor.shieldedSecretKeys, dustSecretKey: sponsor.dustSecretKey },
        { ttl: ttl(), tokenKindsToBalance: ['dust'] }));
    const balancingSummary = summarize(recipe.balancingTransaction, recipe.balancingTransaction.serialize().byteLength);
    finding('V9-balancing-tx-is-dust-only', balancingSummary.calls.length === 0 && balancingSummary.dustSpendCount > 0 && !balancingSummary.hasGuaranteedShieldedOffer,
      `balancing tx: dustSpends=${balancingSummary.dustSpendCount} calls=${balancingSummary.calls.length} shieldedOffer=${balancingSummary.hasGuaranteedShieldedOffer}`);
    const signed = await timed(t, 'sponsor_sign_ms', () => signRecipeWithFallback(sponsor, recipe));
    t.sponsor_sign_path = signed.path as any;
    const merged = await timed(t, 'sponsor_prove_and_merge_ms', () => sponsor.wallet.finalizeRecipe(signed.recipe));
    const mergedBytes = merged.serialize();
    captured.merged = mergedBytes;
    writeFileSync(`${OUT}/merged-sponsored.bin`, mergedBytes);
    const ms = summarize(merged, mergedBytes.byteLength);
    captured.mergedSummary = ms;
    captured.fees.actualSponsorDustFee = ms.dustFeeSpecks.toString();
    report.wellFormedProbe_merged = probeWellFormed(merged);
    log('wellFormed probe (merged tx):', json(report.wellFormedProbe_merged));
    const imb = merged.imbalances(0, 0n);
    finding('V9-merged-has-no-residual-imbalance', [...imb.values()].every((v) => v >= 0n),
      `imbalances(seg0)=${[...imb.entries()].map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(' ') || 'none'}`);
    finding('V3-actual-fee-vs-estimate', ms.dustFeeSpecks <= feeEst,
      `actual sponsor DustSpend vFee=${specksToDust(ms.dustFeeSpecks)} DUST; estimate=${specksToDust(feeEst)}; calculate=${specksToDust(feeCalc)}; ratio est/actual=${(Number(feeEst) / Number(ms.dustFeeSpecks)).toFixed(3)}`);
    captured.ids = {
      userIdentifiers: summary.identifiers, userTxHash: summary.txHash,
      mergedIdentifiers: ms.identifiers, mergedTxHash: ms.txHash, mergedSegments: [...(merged.intents?.keys() ?? [])],
    };
    const id = await timed(t, 'submit_ms', () => sponsor.wallet.submitTransaction(merged));
    captured.ids.submitReturned = id;
    log(`submitted; facade returned id=${id}`);
    return id;
  };

  // ---------- the user's DApp flow ----------
  const uk = await publicKeysOf(user);
  const up = userProviders(cfg, user, uk.coin, uk.enc, aetherdust, t);
  const counter = await findDeployedContract(up, { ...counterOpts, contractAddress });
  const before = await readCounter();
  log(`counter before = ${before}`);
  const tStart = performance.now();
  const res = await timed(t, 'e2e_increment_total_ms', () => counter.callTx.increment());
  t.e2e_wallclock_ms = Math.round(performance.now() - tStart);
  log(`confirmed: txId=${res.public.txId} block=${res.public.blockHeight} (${t.e2e_increment_total_ms}ms)`);
  const after = await readCounter();
  finding('V1-sponsored-call-confirmed', after !== null && before !== null && after === before + 1n, `counter ${before} → ${after}; block ${res.public.blockHeight}`);

  // ---------- V2: which identifier does the indexer resolve? ----------
  const probes: Record<string, string> = {};
  const probe = async (label: string, id: string | undefined) => {
    if (!id) { probes[label] = 'n/a'; return; }
    try { const d = await withTimeout(up.publicDataProvider.watchForTxData(id), 20_000, label); probes[label] = `RESOLVED block=${d.blockHeight} status=${(d as any).status ?? '?'}`; }
    catch (e) { probes[label] = `NO (${String((e as Error).message).slice(0, 60)})`; }
  };
  const ids = captured.ids as any;
  await probe('mergedTxHash', ids.mergedTxHash);
  await probe('submitReturned(identifiers.at(-1))', ids.submitReturned);
  await probe('userIdentifiers[0]', ids.userIdentifiers?.[0]);
  await probe('userTxHash(pre-merge)', ids.userTxHash);
  report.v2_identifierProbes = probes;
  log('V2 probes:', json(probes));
  finding('V2-confirmation-key', Object.values(probes).some((v) => v.startsWith('RESOLVED')), json(probes));

  // ---------- balances after ----------
  await Rx.firstValueFrom(sponsor.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const sponsorAfter = await snapshot(sponsor);
  const userAfter = await snapshot(user);
  finding('AC2-user-paid-nothing', userAfter.nightStars === 0n && userAfter.dustSpecks === 0n, `user after: ${userAfter.nightStars} STAR / ${userAfter.dustSpecks} SPECK`);
  const coinsChanged = JSON.stringify(sponsorBefore.dustCoinIds) !== JSON.stringify(sponsorAfter.dustCoinIds);
  finding('AC1-sponsor-paid', coinsChanged || sponsorAfter.dustSpecks < sponsorBefore.dustSpecks,
    `sponsor DUST ${specksToDust(sponsorBefore.dustSpecks)} → ${specksToDust(sponsorAfter.dustSpecks)} (balance refills to cap: ${sponsorBefore.nightStars / 1_000_000n} NIGHT); dust coin set changed=${coinsChanged}; coin values before=${sponsorBefore.dustCoinValues.join(',')} after=${sponsorAfter.dustCoinValues.join(',')}`);

  // ---------- negative / adversarial (V11 live) ----------
  // N1: the user's unpaid tx must be rejected by the node on its own (proves sponsorship was necessary)
  try {
    const unpaid = deserializeFinalized(captured.userSealed!);
    const id = await withTimeout(user.wallet.submitTransaction(unpaid), 30_000, 'N1');
    finding('N1-unpaid-tx-rejected-by-node', false, `node ACCEPTED unpaid tx?! id=${id}`);
  } catch (e) { finding('N1-unpaid-tx-rejected-by-node', true, errText(e)); }
  // N2: policy rejects a non-allowlisted entry point before any sponsor work
  const v2 = checkPolicy(captured.userSummary!, { allowed: { [contractAddress]: ['register'] }, minTtlRemainingMs: 0 });
  finding('N2-policy-rejects-entrypoint', !v2.ok && v2.code === 'ENTRY_POINT_NOT_ALLOWED', json(v2));
  const v3 = checkPolicy(captured.userSummary!, { allowed: { [ledger.sampleContractAddress()]: ['increment'] }, minTtlRemainingMs: 0 });
  finding('N2-policy-rejects-contract', !v3.ok && v3.code === 'CONTRACT_NOT_ALLOWED', json(v3));
  // N3: replaying the merged tx must fail (double spend of the sponsor's DUST + already-applied call)
  try {
    const again = deserializeFinalized(captured.merged!);
    const id = await withTimeout(sponsor.wallet.submitTransaction(again), 30_000, 'N3');
    finding('N3-replay-rejected', false, `replay ACCEPTED?! id=${id}`);
  } catch (e) { finding('N3-replay-rejected', true, errText(e)); }
  // N4: tampered user bytes
  {
    const b = new Uint8Array(captured.userSealed!); b[Math.floor(b.length / 2)] ^= 0x01;
    let r = '';
    try { const tx = deserializeFinalized(b); const p = probeWellFormed(tx); r = `deserialized; wellFormed sig+limits=${p['sig+limits']}`; }
    catch (e) { r = `rejected at deserialize: ${String((e as Error).message).slice(0, 80)}`; }
    // Expected on ledger v8: a flip inside the contract proof is invisible to signature/limit checks; only the node
    // (with contract state) can verify it. Recorded as an observation; N4b measures what it costs the sponsor.
    finding('N4-tampered-proof-offline-observation', true, `${r} → contract-proof corruption is NOT detectable offline on v8 (expected)`);
  }
  // N4b: push a tampered (proof-corrupted) user tx through the FULL sponsor pipeline — what does it cost the sponsor?
  {
    const b = new Uint8Array(captured.userSealed!); b[Math.floor(b.length / 2)] ^= 0x01;
    const coinsBefore = JSON.stringify((await snapshot(sponsor)).dustCoinIds);
    const t0 = performance.now();
    let outcome = '';
    try {
      const tx = deserializeFinalized(b);
      const recipe = await sponsor.wallet.balanceFinalizedTransaction(tx, { shieldedSecretKeys: sponsor.shieldedSecretKeys, dustSecretKey: sponsor.dustSecretKey }, { ttl: ttl(), tokenKindsToBalance: ['dust'] });
      const signed = await signRecipeWithFallback(sponsor, recipe);
      const merged = await sponsor.wallet.finalizeRecipe(signed.recipe);
      const id = await withTimeout(sponsor.wallet.submitTransaction(merged), 60_000, 'N4b');
      outcome = `ACCEPTED?! id=${id}`;
    } catch (e) { outcome = `rejected: ${errText(e)}`; }
    const cost = Math.round(performance.now() - t0);
    await Rx.firstValueFrom(sponsor.wallet.state().pipe(Rx.filter((st) => st.isSynced)));
    const coinsAfter = JSON.stringify((await snapshot(sponsor)).dustCoinIds);
    finding('N4b-tampered-tx-full-pipeline', outcome.startsWith('rejected'), `${outcome} | sponsor cost: ${cost}ms wall (proving+submit), dust coins changed=${coinsBefore !== coinsAfter}`);
  }
  // V6: TTL headroom of the user tx as received (midnight-js sets a 1h default TTL on balanceTx; sponsor uses 30 min)
  const ttlLeft = captured.userSummary!.minIntentTtl ? captured.userSummary!.minIntentTtl.getTime() - Date.now() : NaN;
  report.v6_ttlRemainingAtEndMs = ttlLeft;
  log(`V6: user intent TTL remaining after full flow ≈ ${Math.round(ttlLeft / 1000)}s (midnight-js default 1h); merged tx min TTL = ${captured.mergedSummary!.minIntentTtl?.toISOString()}; dust grace period = ${ledger.LedgerParameters.initialParameters().dust.dustGracePeriodSeconds}s`);
  report.feeOverheadSpecks = process.env.DUST_FEE_OVERHEAD ?? '300000000000000';

  // ---------- V5: "restart" — a fresh sponsor instance from the same seed must see consistent DUST state ----------
  const sponsor2 = await buildWallet(cfg, sponsorSeed(), 'sponsor-restarted');
  await timed(t, 'sponsor_restart_sync_ms', () => waitForSync(sponsor2));
  const s2 = await snapshot(sponsor2);
  finding('V5-restart-state-consistent', s2.dustCoins === sponsorAfter.dustCoins && s2.dustSpecks <= sponsorAfter.dustSpecks + 10n ** 15n,
    `restarted: dust=${specksToDust(s2.dustSpecks)} coins=${s2.dustCoins} pending=${s2.dustPendingCoins} vs live coins=${sponsorAfter.dustCoins}`);
  await sponsor2.wallet.stop();

  report.timings = t; report.fees = captured.fees; report.ids = captured.ids; report.findings = findings;
  report.sponsorBefore = sponsorBefore; report.sponsorAfter = sponsorAfter; report.userBefore = userBefore; report.userAfter = userAfter;
  report.userSummary = captured.userSummary; report.mergedSummary = captured.mergedSummary;
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}/report.json`, json(report));
  log(`report → ${OUT}/report.json`);
  const failed = findings.filter((f) => !f.ok);
  log(`${findings.length - failed.length}/${findings.length} findings OK${failed.length ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ''}`);
  await Promise.allSettled([sponsor.wallet.stop(), user.wallet.stop()]);
  process.exit(failed.length ? 1 : 0);
};

main().catch(async (e) => {
  console.error('SPIKE FAILED:', e);
  report.error = String(e?.stack ?? e); report.findings = findings;
  writeFileSync(`${OUT}/report.json`, json(report));
  process.exit(2);
});
