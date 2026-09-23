/**
 * Deploys the Private Allowlist Access contract, and adds members to it.
 *
 *   cd examples/allowlist-dapp && set -a && . ../../deploy/.env && set +a
 *   pnpm deploy-contract setup 3                  # deploy AND admit 3 freshly generated demo members, in one go
 *   pnpm deploy-contract deploy                   # deploy only; prints the contract address
 *   pnpm deploy-contract add <address> <64-hex>   # operator: add one member to an existing allowlist
 *   pnpm deploy-contract claim <address> <secret> # claim as that member, paying the fee from this wallet
 *   pnpm deploy-contract secret                   # print a fresh member secret + its commitment
 *
 * `claim` is the non-gasless path: it proves the circuit works on a real chain without AetherDust in the picture.
 * The gasless path a member actually uses is the browser DApp, where the sponsor pays.
 *
 * `setup` exists because each run of this script syncs the sponsor wallet from scratch — minutes locally, ~2 h on a
 * public network — so deploying and admitting members in separate runs would pay that cost twice.
 *
 * Both transactions are paid by the AetherDust sponsor wallet — it is the funded one; members are not, which is
 * the whole point of the DApp. On a public testnet the wallet sync alone takes ~2 h; on `undeployed`, ~30 s.
 *
 * The operator's secret is `ALLOWLIST_OWNER_SECRET` (64 hex) if set, otherwise derived from the sponsor seed, so a
 * demo works without extra configuration and the same machine always reproduces the same owner.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { loadConfig, loadSponsorSeed, midnightEndpoints } from '@aetherdust/config';
import { buildSponsorWallet, signRecipe, waitForSync } from '@aetherdust/midnight/wallet';
import * as Rx from 'rxjs';
import { Allowlist, commitmentFor, createPrivateState, witnesses } from './contract/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

// `secret` needs no chain at all — answer it before building a wallet
if (process.argv[2] === 'secret') {
  const s = new Uint8Array(randomBytes(32));
  console.log(JSON.stringify({ secret: hex(s), commitment: hex(commitmentFor(s)) }, null, 2));
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const managed = path.join(here, 'contract', 'managed', 'allowlist');
const config = loadConfig({ AETHERDUST_DATABASE_URL: 'postgres://unused', AETHERDUST_ADMIN_TOKEN: 'unused-for-deploy-0000', ...process.env });
const ep = midnightEndpoints(config);
const proofServer = process.env.MIDNIGHT_PROOF_SERVER_URL?.startsWith('http://proof-server') ? 'http://127.0.0.1:6300' : ep.proofServer;
const sponsorSeed = loadSponsorSeed(config, (p) => readFileSync(p, 'utf8'));

/** The operator's secret: explicit, or derived from the sponsor seed so a fresh checkout still works. */
const ownerSecret = process.env.ALLOWLIST_OWNER_SECRET
  ? unhex(process.env.ALLOWLIST_OWNER_SECRET)
  : new Uint8Array(createHash('sha256').update(`${sponsorSeed}:aetherdust:allowlist:owner:v1`).digest());

// fail fast: the wallet sync below takes ~2 h on a public testnet, so check the proof server BEFORE it, not after
const version = await fetch(new URL('/version', proofServer), { signal: AbortSignal.timeout(5000) })
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .catch((e) => {
    console.error(`proof server not reachable at ${proofServer} (${(e as Error).message}).`);
    console.error('With docker compose, publish it: docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --profile testnet up -d proof-server');
    process.exit(2);
  });

const action = process.argv[2] ?? 'deploy';
console.error(`${action} on ${ep.network} with the sponsor wallet (proof server ${proofServer}, v${version})…`);

const w = await buildSponsorWallet(sponsorSeed, {
  ...ep, proofServer,
  feeOverheadSpecks: BigInt(config.AETHERDUST_DUST_FEE_OVERHEAD_SPECKS),
  feeBlocksMargin: config.AETHERDUST_DUST_FEE_BLOCKS_MARGIN,
});
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

const zk = new NodeZkConfigProvider<'addMember' | 'claimAccess'>(managed);
const providers = {
  privateStateProvider: levelPrivateStateProvider<'allowlistPrivateState'>({
    midnightDbName: path.join(here, '.deploy-state'), privateStateStoreName: 'deploy',
    accountId: keys.coin, privateStoragePasswordProvider: () => `${keys.coin}!`,
  }),
  publicDataProvider: indexerPublicDataProvider(ep.indexer, ep.indexerWs),
  zkConfigProvider: zk,
  proofProvider: httpClientProofProvider(proofServer, zk),
  walletProvider: wp,
  midnightProvider: wp,
};

// the operator runs these, so the private state carries the operator's secret
const compiled = CompiledContract.make('allowlist', Allowlist.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(managed),
);
const opts = { compiledContract: compiled, privateStateId: 'allowlistPrivateState' as const, initialPrivateState: createPrivateState(ownerSecret) };

if (action === 'deploy' || action === 'setup') {
  const d = await deployContract(providers as any, { ...opts, args: [commitmentFor(ownerSecret)] } as any);
  const address = d.deployTxData.public.contractAddress;
  console.error(`deployed at ${address}`);

  // `setup`: admit some demo members while the wallet is already synced and the contract is already in hand
  const members: { secret: string; commitment: string; txId?: string }[] = [];
  if (action === 'setup') {
    const count = Number(process.argv[3] ?? 3);
    const contract = await findDeployedContract(providers as any, { ...opts, contractAddress: address } as any);
    for (let i = 0; i < count; i++) {
      const s = new Uint8Array(randomBytes(32));
      const tx = await (contract as any).callTx.addMember(commitmentFor(s));
      members.push({ secret: hex(s), commitment: hex(commitmentFor(s)), txId: tx.public.txId });
      console.error(`  admitted member ${i + 1}/${count} (${hex(commitmentFor(s)).slice(0, 12)}…) in block ${tx.public.blockHeight}`);
    }
  }
  console.log(JSON.stringify({ network: ep.network, contractAddress: address, ownerCommitment: hex(commitmentFor(ownerSecret)), members }, null, 2));
  console.error('Add this contract with entry points "addMember" and "claimAccess" to the AetherDust policy, then put the address in the DApp.');
} else if (action === 'claim') {
  const [, , , addressArg, memberSecret] = process.argv;
  if (!addressArg || !/^[0-9a-f]{64}$/i.test(memberSecret ?? '')) {
    console.error('usage: pnpm deploy-contract claim <contract address> <64-hex member secret>');
    process.exit(2);
  }
  // this wallet pays, but the *proof* is the member's: the private state carries their secret, not the operator's
  const member = { ...opts, initialPrivateState: createPrivateState(unhex(memberSecret!)) };
  // the store is scoped per contract, so the address has to be set before any state is written
  providers.privateStateProvider.setContractAddress(addressArg!);
  await providers.privateStateProvider.set('allowlistPrivateState', createPrivateState(unhex(memberSecret!)));
  const contract = await findDeployedContract(providers as any, { ...member, contractAddress: addressArg } as any);
  const tx = await (contract as any).callTx.claimAccess();
  const state = await providers.publicDataProvider.queryContractState(addressArg);
  const led = Allowlist.ledger(state!.data);
  console.log(JSON.stringify({
    admitted: true, txId: tx.public.txId, block: tx.public.blockHeight,
    admissions: Number(led.admissions), nullifiers: [...led.nullifiers].map(hex),
  }, null, 2));
} else if (action === 'add') {
  const [, , , addressArg, commitment] = process.argv;
  if (!addressArg || !/^[0-9a-f]{64}$/i.test(commitment ?? '')) {
    console.error('usage: pnpm deploy-contract add <contract address> <64-hex member commitment>');
    process.exit(2);
  }
  const contract = await findDeployedContract(providers as any, { ...opts, contractAddress: addressArg } as any);
  const tx = await (contract as any).callTx.addMember(unhex(commitment!));
  console.log(JSON.stringify({ added: commitment, txId: tx.public.txId, block: tx.public.blockHeight }, null, 2));
} else {
  console.error('usage: pnpm deploy-contract [setup <count> | deploy | add <address> <commitment> | secret]');
  process.exit(2);
}
process.exit(0);
