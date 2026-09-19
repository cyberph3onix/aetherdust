/**
 * Wallet construction + the two provider bridges the spike needs:
 *   - `userProviders`   : balances WITHOUT dust (what Lace does with payFees:false) and hands the
 *                         sealed tx to a "sponsor submit" callback instead of the node.
 *   - `sponsorProviders`: ordinary self-paying providers (used only to deploy the counter contract).
 *
 * Adapted from midnightntwrk/example-counter (Apache-2.0) and updated to wallet-sdk 1.2.0 / facade 4.1.0.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { getNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { WalletFacade, WalletEntrySchema, type BalancingRecipe } from '@midnightntwrk/wallet-sdk-facade';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import type { Config } from './config.js';

// GraphQL subscriptions (wallet sync) need a global WebSocket in Node.
// @ts-expect-error apollo looks for a global WebSocket
globalThis.WebSocket = WebSocket;

export const TTL_MS = 30 * 60 * 1000;
export const ttl = () => new Date(Date.now() + TTL_MS);

export interface WalletContext {
  label: string;
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

const deriveKeysFromSeed = (seedHex: string) => {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('bad seed');
  const r = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (r.type !== 'keysDerived') throw new Error('key derivation failed');
  hd.hdWallet.clear();
  return r.keys;
};

const walletConfig = (c: Config) => {
  const indexerClientConnection = { indexerHttpUrl: c.indexer, indexerWsUrl: c.indexerWS };
  const networkId = getNetworkId();
  const relayURL = new URL(c.node.replace(/^http/, 'ws'));
  const provingServerUrl = new URL(c.proofServer);
  return {
    // shielded
    networkId, indexerClientConnection, provingServerUrl, relayURL,
    // unshielded
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
    // dust — same cost parameters the official example uses
    // The official example pads every fee with 0.3 DUST (`additionalFeeOverhead`). Make it a knob so the spike can
    // measure what the network actually charges vs. what the wallet pads. DUST_FEE_OVERHEAD in specks.
    costParameters: { additionalFeeOverhead: BigInt(process.env.DUST_FEE_OVERHEAD ?? '300000000000000'), feeBlocksMargin: Number(process.env.DUST_FEE_BLOCKS_MARGIN ?? 5) },
  };
};

export const buildWallet = async (c: Config, seedHex: string, label: string): Promise<WalletContext> => {
  const keys = deriveKeysFromSeed(seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
  const cfg = walletConfig(c);
  const wallet = await WalletFacade.init({
    configuration: cfg,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  return { label, wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

/** Strict sync: all three sub-wallets strictly complete (the top-level isSynced flag already requires this in 4.1.0). */
export const waitForSync = (ctx: WalletContext, timeoutMs = 10 * 60 * 1000) =>
  Rx.firstValueFrom(
    ctx.wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((s) => s.isSynced),
      Rx.timeout({ first: timeoutMs, with: () => Rx.throwError(() => new Error(`${ctx.label}: sync timeout after ${timeoutMs}ms`)) }),
    ),
  );

export const snapshot = async (ctx: WalletContext) => {
  const s = await Rx.firstValueFrom(ctx.wallet.state());
  const now = new Date();
  return {
    label: ctx.label,
    synced: s.isSynced,
    unshieldedAddress: ctx.unshieldedKeystore.getBech32Address().toString(),
    dustAddress: MidnightBech32m.encode(getNetworkId(), s.dust.address).toString(),
    nightStars: s.unshielded.balances[unshieldedToken().raw] ?? 0n,
    nightUtxos: s.unshielded.availableCoins.length,
    nightUtxosRegisteredForDust: s.unshielded.availableCoins.filter((c: any) => c.meta?.registeredForDustGeneration === true).length,
    dustSpecks: s.dust.balance(now),
    dustCoins: s.dust.availableCoins.length,
    dustPendingCoins: s.dust.pendingCoins.length,
    // stable identity per DUST coin so a self-spend (old nullifier → new commitment) is visible even when the
    // balance instantly refills to cap (huge NIGHT holdings regenerate DUST faster than we can measure)
    dustCoinIds: s.dust.availableCoins.map((c: any) => JSON.stringify(c.token, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 96)),
    dustCoinValues: s.dust.availableCoins.map((c: any) => (c.token?.initialValue ?? 0n).toString()),
    pendingTxs: s.pending.all.length,
  };
};

export const registerForDust = async (ctx: WalletContext, log = console.log) => {
  const s = await waitForSync(ctx);
  if (s.dust.availableCoins.length > 0 && s.dust.balance(new Date()) > 0n) return 'already-has-dust';
  const utxos = s.unshielded.availableCoins.filter((c: any) => c.meta?.registeredForDustGeneration !== true);
  if (utxos.length > 0) {
    log(`${ctx.label}: registering ${utxos.length} NIGHT UTXO(s) for DUST generation`);
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      utxos, ctx.unshieldedKeystore.getPublicKey(), (p) => ctx.unshieldedKeystore.signData(p));
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    await ctx.wallet.submitTransaction(finalized);
  }
  log(`${ctx.label}: waiting for DUST to generate…`);
  await Rx.firstValueFrom(
    ctx.wallet.state().pipe(Rx.throttleTime(3_000), Rx.filter((st) => st.isSynced && st.dust.balance(new Date()) > 0n)),
  );
  return 'registered';
};

const signAll = (ctx: WalletContext) => (p: Uint8Array) => ctx.unshieldedKeystore.signData(p);

/**
 * Sign a recipe. The official example works around a facade bug where `signRecipe` cloned proven intents
 * with a 'pre-proof' marker. We call the SDK path first and only fall back to the manual path if it throws,
 * so the spike report can state whether the bug still exists in facade 4.1.0 (V8).
 */
export const signRecipeWithFallback = async (ctx: WalletContext, recipe: BalancingRecipe) => {
  try {
    return { recipe: await ctx.wallet.signRecipe(recipe, signAll(ctx)), path: 'sdk' as const };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (recipe.type !== 'UNBOUND_TRANSACTION') throw e;
    manualSignIntents(recipe.baseTransaction, signAll(ctx), 'proof');
    if (recipe.balancingTransaction) manualSignIntents(recipe.balancingTransaction, signAll(ctx), 'pre-proof');
    return { recipe, path: `manual (sdk signRecipe failed: ${msg.slice(0, 80)})` as const };
  }
};

const manualSignIntents = (
  tx: { intents?: Map<number, any> },
  signFn: (p: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
) => {
  if (!tx.intents) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      'signature', proofMarker, 'pre-binding', intent.serialize());
    const sig = signFn(cloned.signatureData(segment));
    for (const k of ['fallibleUnshieldedOffer', 'guaranteedUnshieldedOffer'] as const) {
      const offer = cloned[k];
      if (offer) {
        const sigs = offer.inputs.map((_: unknown, i: number) => offer.signatures.at(i) ?? sig);
        (cloned as any)[k] = offer.addSignatures(sigs);
      }
    }
    tx.intents.set(segment, cloned);
  }
};

export type Timings = Record<string, number>;
export const timed = async <T>(t: Timings, key: string, fn: () => Promise<T>): Promise<T> => {
  const s = performance.now();
  try { return await fn(); } finally { t[key] = Math.round(performance.now() - s); }
};

/**
 * midnight-js providers for the USER: prove normally, balance WITHOUT dust, then hand the sealed
 * transaction to `onSealed` (the AetherDust step) instead of submitting it. `onSealed` returns the tx id
 * midnight-js should watch for.
 */
export const userProviders = (
  c: Config, ctx: WalletContext, coinPublicKey: string, encPublicKey: string,
  onSealed: (tx: ledger.FinalizedTransaction) => Promise<string>, timings: Timings,
) => {
  const zk = new NodeZkConfigProvider<'increment'>(c.zkConfigPath);
  const wp: WalletProvider & MidnightProvider = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx, t?) {
      const recipe = await timed(timings, 'user_balance_no_dust_ms', () =>
        ctx.wallet.balanceUnboundTransaction(tx, { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
          { ttl: t ?? ttl(), tokenKindsToBalance: ['shielded', 'unshielded'] }));
      const signed = await signRecipeWithFallback(ctx, recipe);
      timings.user_sign_path = signed.path as any;
      return timed(timings, 'user_finalize_ms', () => ctx.wallet.finalizeRecipe(signed.recipe));
    },
    submitTx: (tx) => onSealed(tx),
  };
  return {
    privateStateProvider: levelPrivateStateProvider<'counterPrivateState'>({
      privateStateStoreName: `spike-${ctx.label}`,
      accountId: coinPublicKey,
      privateStoragePasswordProvider: () => `${Buffer.from(coinPublicKey, 'hex').toString('base64')}!`,
    }),
    publicDataProvider: indexerPublicDataProvider(c.indexer, c.indexerWS),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(c.proofServer, zk),
    walletProvider: wp,
    midnightProvider: wp,
  };
};

/** Ordinary self-paying providers (sponsor deploys the counter with these). */
export const selfPayingProviders = (c: Config, ctx: WalletContext, coinPublicKey: string, encPublicKey: string) => {
  const zk = new NodeZkConfigProvider<'increment'>(c.zkConfigPath);
  const wp: WalletProvider & MidnightProvider = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encPublicKey,
    async balanceTx(tx, t?) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey }, { ttl: t ?? ttl() });
      const signed = await signRecipeWithFallback(ctx, recipe);
      return ctx.wallet.finalizeRecipe(signed.recipe);
    },
    submitTx: (tx) => ctx.wallet.submitTransaction(tx),
  };
  return {
    privateStateProvider: levelPrivateStateProvider<'counterPrivateState'>({
      privateStateStoreName: `spike-${ctx.label}`,
      accountId: coinPublicKey,
      privateStoragePasswordProvider: () => `${Buffer.from(coinPublicKey, 'hex').toString('base64')}!`,
    }),
    publicDataProvider: indexerPublicDataProvider(c.indexer, c.indexerWS),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(c.proofServer, zk),
    walletProvider: wp,
    midnightProvider: wp,
  };
};

export const publicKeysOf = async (ctx: WalletContext) => {
  const s = await Rx.firstValueFrom(ctx.wallet.state());
  return { coin: s.shielded.coinPublicKey.toHexString(), enc: s.shielded.encryptionPublicKey.toHexString() };
};
