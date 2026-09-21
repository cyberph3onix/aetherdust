/**
 * Sponsor wallet: seed → keys → WalletFacade (shielded + unshielded + dust), sync, snapshot, DUST registration.
 * Ported from the Phase 0 spike (spikes/sponsor-spike/src/wallet.ts), which proved this exact construction on
 * wallet-sdk 1.2.0 / facade 4.1.0. Worker-only: this module holds secret keys and must never load in the API.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { WalletEntrySchema, WalletFacade, type BalancingRecipe, type FacadeState } from '@midnightntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { createKeystore, PublicKey, UnshieldedWallet, type UnshieldedKeystore } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';

// GraphQL subscriptions (wallet sync) need a global WebSocket in Node.
if (!(globalThis as any).WebSocket) (globalThis as any).WebSocket = WebSocket;

export interface SponsorWalletOptions {
  network: string;
  node: string;
  indexer: string;
  indexerWs: string;
  proofServer: string;
  /** costParameters.additionalFeeOverhead in SPECK. Keep ≈ 0 (Phase 0 §4.6). */
  feeOverheadSpecks: bigint;
  feeBlocksMargin: number;
}

export interface SponsorWallet {
  facade: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  network: string;
}

const deriveKeysFromSeed = (seedHex: string) => {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('bad sponsor seed');
  const r = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('sponsor key derivation failed');
  hd.hdWallet.clear();
  return r.keys;
};

export const buildSponsorWallet = async (seedHex: string, o: SponsorWalletOptions): Promise<SponsorWallet> => {
  setNetworkId(o.network as Parameters<typeof setNetworkId>[0]);
  const keys = deriveKeysFromSeed(seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
  const configuration = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: o.indexer, indexerWsUrl: o.indexerWs },
    provingServerUrl: new URL(o.proofServer),
    relayURL: new URL(o.node.replace(/^http/, 'ws')),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
    costParameters: { additionalFeeOverhead: o.feeOverheadSpecks, feeBlocksMargin: o.feeBlocksMargin },
  };
  const facade = await WalletFacade.init({
    configuration,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);
  return { facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, network: o.network };
};

/** One line per sub-wallet: applied/highest index and connection state — enough to tell "slow" from "stuck". */
export const syncProgress = (s: FacadeState): string => {
  const p = (label: string, w: any) => {
    const pr = w?.progress;
    if (!pr) return `${label} n/a`;
    // shielded/dust report appliedIndex; unshielded reports appliedId — the SDK's own completeness check is what matters
    const applied = pr.appliedIndex ?? pr.appliedId ?? '?';
    const done = typeof pr.isStrictlyComplete === 'function' ? pr.isStrictlyComplete() : undefined;
    return `${label} ${applied}${done === true ? ' ✓' : done === false ? ' …' : ''}${pr.isConnected ? '' : ' (disconnected)'}`;
  };
  return `${p('shielded', s.shielded)} · ${p('unshielded', s.unshielded)} · ${p('dust', s.dust)} · synced=${s.isSynced}`;
};

/** Resolves once all three sub-wallets report synced (the facade's `isSynced` requires this in 4.1.0). */
export const waitForSync = (w: SponsorWallet, timeoutMs: number, onProgress?: (line: string) => void) => {
  let last = 0;
  return Rx.firstValueFrom(w.facade.state().pipe(
    Rx.throttleTime(1_000, undefined, { leading: true, trailing: true }),
    Rx.tap((s) => { if (onProgress && Date.now() - last > 30_000) { last = Date.now(); onProgress(syncProgress(s)); } }),
    Rx.filter((s) => s.isSynced),
    Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`sponsor wallet sync timeout after ${timeoutMs} ms`)) }),
  ));
};

export interface WalletSnapshot {
  synced: boolean;
  unshieldedAddress: string;
  dustAddress: string;
  nightStars: bigint;
  nightUtxos: number;
  nightUtxosRegisteredForDust: number;
  dustSpecks: bigint;
  dustCapSpecks: bigint | null;
  dustCoins: number;
  dustPendingCoins: number;
  pendingTxs: number;
}

export const snapshot = async (w: SponsorWallet, now = new Date()): Promise<WalletSnapshot> => {
  const s = await Rx.firstValueFrom(w.facade.state());
  const coins: readonly any[] = s.dust.availableCoins;
  return {
    synced: s.isSynced,
    unshieldedAddress: w.unshieldedKeystore.getBech32Address().toString(),
    dustAddress: MidnightBech32m.encode(getNetworkId(), s.dust.address).toString(),
    nightStars: s.unshielded.balances[unshieldedToken().raw] ?? 0n,
    nightUtxos: s.unshielded.availableCoins.length,
    nightUtxosRegisteredForDust: s.unshielded.availableCoins.filter((c: any) => c.meta?.registeredForDustGeneration === true).length,
    dustSpecks: s.dust.balance(now),
    // the SDK does not expose the generation cap directly (initialValue is the coin's value at creation, not its cap)
    dustCapSpecks: null,
    dustCoins: coins.length,
    dustPendingCoins: s.dust.pendingCoins.length,
    pendingTxs: s.pending.all.length,
  };
};

export const signAll = (w: SponsorWallet) => (p: Uint8Array) => w.unshieldedKeystore.signData(p);
export const signRecipe = (w: SponsorWallet, recipe: BalancingRecipe) => w.facade.signRecipe(recipe, signAll(w));

/** Operator action: register every unregistered NIGHT UTXO for DUST generation and wait for the first DUST. */
export const registerForDust = async (w: SponsorWallet, waitMs: number, log: (m: string) => void = () => {}): Promise<'already-has-dust' | 'registered'> => {
  const s = await Rx.firstValueFrom(w.facade.state().pipe(Rx.filter((st) => st.isSynced)));
  if (s.dust.availableCoins.length > 0 && s.dust.balance(new Date()) > 0n) return 'already-has-dust';
  const utxos = s.unshielded.availableCoins.filter((c: any) => c.meta?.registeredForDustGeneration !== true);
  const registered = s.unshielded.availableCoins.length - utxos.length;
  if (s.unshielded.availableCoins.length === 0) throw new Error('no NIGHT UTXOs to register — fund the sponsor’s unshielded address first (see `wallet addresses`)');
  // re-runnable: UTXOs registered on an earlier run (DUST still settling, ~12 h on public testnets) just need more waiting
  if (utxos.length === 0) log(`${registered} NIGHT UTXO(s) already registered; DUST not generated yet`);
  if (utxos.length > 0) {
    // the registration pays its own fee from the DUST the UTXOs have *projected* to generate; fees are dynamic
    // (block fullness), so on a busy/fresh chain the wallet may need to wait a while before it can afford it
    const { fee } = await w.facade.estimateRegistration(utxos);
    log(`registering ${utxos.length} NIGHT UTXO(s) for DUST generation (fee ≈ ${fee} SPECK; waiting until the UTXOs have accrued that much)`);
    await w.facade.waitForGeneratedDust(utxos, fee * 12n / 10n, { timeoutMs: waitMs }); // +20 %: the fee may move while we wait
    const recipe = await w.facade.registerNightUtxosForDustGeneration(utxos, w.unshieldedKeystore.getPublicKey(), signAll(w));
    const finalized = await w.facade.finalizeRecipe(recipe);
    await w.facade.submitTransaction(finalized);
  }
  log('waiting for DUST to generate…');
  await Rx.firstValueFrom(w.facade.state().pipe(Rx.throttleTime(3_000), Rx.filter((st) => st.isSynced && st.dust.balance(new Date()) > 0n),
    Rx.timeout({ first: waitMs, with: () => Rx.throwError(() => new Error('no DUST generated within the wait window (registration may still be settling)')) })));
  return 'registered';
};

/** Operator action: send NIGHT (in STAR) to a bech32 unshielded address, paying the fee from this wallet's DUST. */
export const transferNight = async (w: SponsorWallet, toBech32: string, stars: bigint, ttlMs: number): Promise<string> => {
  const receiver = MidnightBech32m.parse(toBech32).decode(UnshieldedAddress, getNetworkId());
  const recipe = await w.facade.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: unshieldedToken().raw, receiverAddress: receiver, amount: stars }] }],
    { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl: new Date(Date.now() + ttlMs) });
  const tx = await w.facade.finalizeRecipe(await signRecipe(w, recipe));
  return w.facade.submitTransaction(tx);
};

/** Resolves once the wallet is synced and `pred` holds (e.g. funds arrived). */
export const waitForState = <T>(w: SponsorWallet, pred: (s: import('@midnightntwrk/wallet-sdk-facade').FacadeState) => T | undefined, timeoutMs: number, label = 'condition') =>
  Rx.firstValueFrom(w.facade.state().pipe(
    Rx.throttleTime(2_000, undefined, { leading: true, trailing: true }),
    Rx.filter((s) => s.isSynced),
    Rx.map(pred), Rx.filter((v): v is T => v !== undefined),
    Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`timed out waiting for ${label} after ${timeoutMs} ms`)) }),
  ));
