/**
 * The USER side of the e2e flow, Node-side stand-in for a browser wallet (plan §19): a wallet built from a seed that
 * holds 0 NIGHT / 0 DUST, and midnight-js providers that prove normally, balance WITHOUT dust (what Lace does with
 * `payFees:false`) and hand the sealed transaction to AetherDust instead of the node. Ported from the Phase 0 spike.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { MidnightEndpoints } from '@aetherdust/config';
import { buildSponsorWallet, signRecipe, snapshot, waitForSync, type SponsorWallet } from '@aetherdust/midnight/wallet';
import * as Rx from 'rxjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Counter } from './counter/index.js';

// A deterministic, *unfunded* seed: the point of the test is a user with 0 NIGHT / 0 DUST.
export const USER_SEED = '00000000000000000000000000000000000000000000000000000000000000a7';
export const ZK_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'counter', 'managed', 'counter');

export const compiledCounter = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
);
export const counterOpts = { compiledContract: compiledCounter, privateStateId: 'counterPrivateState' as const, initialPrivateState: { privateCounter: 0 } };

export type UserWallet = SponsorWallet; // same construction; different seed, no funds

export const buildUserWallet = async (ep: MidnightEndpoints, seed = USER_SEED, syncTimeoutMs = 120_000): Promise<UserWallet> => {
  const w = await buildSponsorWallet(seed, { ...ep, feeOverheadSpecks: 0n, feeBlocksMargin: 5 });
  await waitForSync(w, syncTimeoutMs);
  return w;
};

export const publicKeysOf = async (w: SponsorWallet) => {
  const s = await Rx.firstValueFrom(w.facade.state());
  return { coin: s.shielded.coinPublicKey.toHexString(), enc: s.shielded.encryptionPublicKey.toHexString() };
};

const ttl30 = () => new Date(Date.now() + 30 * 60_000);

const baseProviders = (ep: MidnightEndpoints, keys: { coin: string; enc: string }, storeDir: string, wp: WalletProvider & MidnightProvider) => {
  const zk = new NodeZkConfigProvider<'increment'>(ZK_CONFIG_PATH);
  return {
    privateStateProvider: levelPrivateStateProvider<'counterPrivateState'>({
      midnightDbName: storeDir, privateStateStoreName: 'e2e', accountId: keys.coin,
      privateStoragePasswordProvider: () => `${Buffer.from(keys.coin, 'hex').toString('base64')}!`,
    }),
    publicDataProvider: indexerPublicDataProvider(ep.indexer, ep.indexerWs),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(ep.proofServer, zk),
    walletProvider: wp,
    midnightProvider: wp,
  };
};

/**
 * Providers for the USER: balance with `tokenKindsToBalance: ['shielded','unshielded']` (no DUST → fees unpaid),
 * sign, seal, then hand the sealed tx to `onSealed` (the AetherDust step), which returns the tx id to watch.
 */
export const userProviders = (ep: MidnightEndpoints, w: UserWallet, keys: { coin: string; enc: string }, storeDir: string, onSealed: (tx: ledger.FinalizedTransaction) => Promise<string>, ttl?: () => Date) => {
  const wp: WalletProvider & MidnightProvider = {
    getCoinPublicKey: () => keys.coin,
    getEncryptionPublicKey: () => keys.enc,
    async balanceTx(tx, t?) {
      // `ttl` override: two identical calls sealed within the same second are byte-identical (same hash, a replay on-chain)
      const recipe = await w.facade.balanceUnboundTransaction(tx, { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl: ttl ? ttl() : t ?? ttl30(), tokenKindsToBalance: ['shielded', 'unshielded'] });
      return w.facade.finalizeRecipe(await signRecipe(w, recipe));
    },
    submitTx: (tx) => onSealed(tx),
  };
  return baseProviders(ep, keys, storeDir, wp);
};

/** Ordinary self-paying providers (used to deploy the counter with the funded sponsor wallet). */
export const selfPayingProviders = (ep: MidnightEndpoints, w: SponsorWallet, keys: { coin: string; enc: string }, storeDir: string) => {
  const wp: WalletProvider & MidnightProvider = {
    getCoinPublicKey: () => keys.coin,
    getEncryptionPublicKey: () => keys.enc,
    async balanceTx(tx, t?) {
      const recipe = await w.facade.balanceUnboundTransaction(tx, { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl: t ?? ttl30() });
      return w.facade.finalizeRecipe(await signRecipe(w, recipe));
    },
    submitTx: (tx) => w.facade.submitTransaction(tx),
  };
  return baseProviders(ep, keys, storeDir, wp);
};

export const deployCounter = async (providers: ReturnType<typeof selfPayingProviders>) => {
  const d = await deployContract(providers, counterOpts);
  return d.deployTxData.public.contractAddress;
};
export const findCounter = (providers: ReturnType<typeof userProviders>, contractAddress: string) =>
  findDeployedContract(providers, { ...counterOpts, contractAddress });
export const readCounter = async (ep: MidnightEndpoints, contractAddress: string): Promise<bigint | null> => {
  const st = await indexerPublicDataProvider(ep.indexer, ep.indexerWs).queryContractState(contractAddress);
  return st ? Counter.ledger(st.data).round : null;
};
export { snapshot };
