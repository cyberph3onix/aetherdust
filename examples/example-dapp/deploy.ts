/**
 * Deploys the counter contract with the AetherDust sponsor wallet (it is funded; the demo user is not), self-paying.
 * Reads the same deploy/.env as the worker (MIDNIGHT_NETWORK, AETHERDUST_SPONSOR_SEED, MIDNIGHT_*_URL).
 *   cd examples/example-dapp && set -a && . ../../deploy/.env && set +a && pnpm deploy-counter
 * On a public testnet the wallet sync alone takes ~2 h (see IMPLEMENTATION_PLAN §0.3); on `undeployed` ~30 s.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js/contracts';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { loadConfig, loadSponsorSeed, midnightEndpoints } from '@aetherdust/config';
import { buildSponsorWallet, signRecipe, waitForSync } from '@aetherdust/midnight/wallet';
import * as Rx from 'rxjs';
import { Counter } from './contract/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig({ AETHERDUST_DATABASE_URL: 'postgres://unused', AETHERDUST_ADMIN_TOKEN: 'unused-for-deploy-0000', ...process.env });
const ep = midnightEndpoints(config);
// the proof server: from env, or the host-published one of the compose stack
const proofServer = process.env.MIDNIGHT_PROOF_SERVER_URL?.startsWith('http://proof-server') ? 'http://127.0.0.1:6300' : ep.proofServer;

console.error(`deploying the counter on ${ep.network} with the sponsor wallet (proof server ${proofServer})…`);
const w = await buildSponsorWallet(loadSponsorSeed(config, (p) => readFileSync(p, 'utf8')), { ...ep, proofServer, feeOverheadSpecks: 0n, feeBlocksMargin: 5 });
await waitForSync(w, config.AETHERDUST_WALLET_SYNC_TIMEOUT_S * 1000, (line) => console.error(`  sync: ${line}`));
const s = await Rx.firstValueFrom(w.facade.state());
const keys = { coin: s.shielded.coinPublicKey.toHexString(), enc: s.shielded.encryptionPublicKey.toHexString() };
const wp: WalletProvider & MidnightProvider = {
  getCoinPublicKey: () => keys.coin,
  getEncryptionPublicKey: () => keys.enc,
  async balanceTx(tx, ttl) {
    const recipe = await w.facade.balanceUnboundTransaction(tx, { shieldedSecretKeys: w.shieldedSecretKeys, dustSecretKey: w.dustSecretKey }, { ttl: ttl ?? new Date(Date.now() + 30 * 60_000) });
    return w.facade.finalizeRecipe(await signRecipe(w, recipe));
  },
  submitTx: (tx) => w.facade.submitTransaction(tx),
};
const zk = new NodeZkConfigProvider<'increment'>(path.join(here, 'contract', 'managed', 'counter'));
const providers = {
  privateStateProvider: levelPrivateStateProvider<'counterPrivateState'>({ midnightDbName: path.join(here, '.deploy-state'), privateStateStoreName: 'deploy', accountId: keys.coin, privateStoragePasswordProvider: () => `${keys.coin}!` }),
  publicDataProvider: indexerPublicDataProvider(ep.indexer, ep.indexerWs),
  zkConfigProvider: zk,
  proofProvider: httpClientProofProvider(proofServer, zk),
  walletProvider: wp,
  midnightProvider: wp,
};
const compiled = CompiledContract.make('counter', Counter.Contract).pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(path.join(here, 'contract', 'managed', 'counter')));
const d = await deployContract(providers, { compiledContract: compiled, privateStateId: 'counterPrivateState', initialPrivateState: { privateCounter: 0 } });
const address = d.deployTxData.public.contractAddress;
console.error(`deployed. Add this contract + entry point "increment" to the application's policy, and paste the address into the DApp.`);
console.log(JSON.stringify({ network: ep.network, contractAddress: address, txId: d.deployTxData.public.txId, blockHeight: d.deployTxData.public.blockHeight }, null, 2));
await w.facade.stop().catch(() => {});
process.exit(0);
