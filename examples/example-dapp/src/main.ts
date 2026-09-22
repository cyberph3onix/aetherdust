/**
 * Counter DApp on Lace + AetherDust. The interesting 20 lines are in `providers()`:
 *   createSponsoredMidnightProvider({ client, wallet })  →  walletProvider (payFees:false) + midnightProvider (sponsor)
 * Everything else is ordinary midnight-js contract wiring and UI.
 */
import '@midnight-ntwrk/dapp-connector-api'; // window.midnight typings
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { createAetherDustClient, createSponsoredMidnightProvider, findAetherDustError, type SponsorshipRequest } from '@aetherdust/client';
import { Counter } from '../contract/index.js';

// ---------- tiny UI helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $('log');
const log = (msg: string, cls = '') => { const line = document.createElement('div'); line.className = cls; line.textContent = `${new Date().toISOString().slice(11, 19)}  ${msg}`; logEl.prepend(line); (cls === 'bad' ? console.error : console.log)(`[aetherdust] ${msg}`); };
window.addEventListener('error', (e) => log(`page error: ${e.message}`, 'bad'));
window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${(e.reason as Error)?.message ?? e.reason}`, 'bad'));
const field = (id: string, key: string, def = '') => {
  const el = $<HTMLInputElement>(id);
  el.value = localStorage.getItem(`aetherdust.${key}`) ?? def;
  el.addEventListener('input', () => localStorage.setItem(`aetherdust.${key}`, el.value));
  return () => el.value.trim();
};
const network = field('network', 'network', 'preprod');
const baseUrl = field('baseUrl', 'baseUrl', 'http://localhost:8080');
const apiKey = field('apiKey', 'apiKey');
const userId = field('userId', 'userId', 'demo-user-1');
const contractAddress = field('contract', 'contract');
const proofServerField = field('proofServer', 'proofServer', 'http://localhost:6300');

// ---------- wallet ----------
let connected: ConnectedAPI | undefined;
let networkId = '';
let config: Awaited<ReturnType<ConnectedAPI['getConfiguration']>> | undefined;

const walletsAvailable = (): [string, InitialAPI][] => Object.entries(window.midnight ?? {});

const showBalances = async () => {
  if (!connected) return;
  const [dust, unshielded] = await Promise.all([connected.getDustBalance(), connected.getUnshieldedBalances()]);
  const night = Object.values(unshielded).reduce((a, b) => a + b, 0n);
  $('balances').textContent = `NIGHT: ${night} STAR · DUST: ${dust.balance} SPECK (cap ${dust.cap})${night === 0n && dust.balance === 0n ? '  ← a user with nothing, exactly the demo' : ''}`;
};

$('connect').addEventListener('click', async () => {
  try {
    const wallets = walletsAvailable();
    if (wallets.length === 0) throw new Error('no Midnight wallet found on window.midnight — is Lace installed and enabled for this site?');
    const [id, api] = wallets.find(([k]) => /lace/i.test(k)) ?? wallets[0];
    log(`connecting to ${api.name} (${id}, api ${api.apiVersion}) on ${network()}…`);
    connected = await api.connect(network());
    const status = await connected.getConnectionStatus();
    if (status.status !== 'connected') throw new Error('wallet did not connect');
    if (status.networkId !== network()) throw new Error(`wallet is on ${status.networkId}, this page is set to ${network()} — switch one of them`);
    config = await connected.getConfiguration();
    networkId = status.networkId;
    setNetworkId(networkId as Parameters<typeof setNetworkId>[0]);
    const addr = await connected.getShieldedAddresses();
    $('wallet').textContent = `${api.name} · ${networkId} · ${addr.shieldedAddress.slice(0, 24)}…`;
    log(`connected on ${networkId}; indexer ${config.indexerUri}; proof server ${config.proverServerUri ?? '(none from wallet)'}`, 'ok');
    await showBalances();
    $<HTMLButtonElement>('increment').disabled = false;
    await refresh();
  } catch (e) { log(`connect failed: ${(e as Error).message}`, 'bad'); }
});

// ---------- contract + providers ----------
// In the browser the ZK assets come from the FetchZkConfigProvider (by circuit id); the assets path is only a label here.
const compiledCounter = CompiledContract.make('counter', Counter.Contract).pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets('/counter'));

const publicData = () => indexerPublicDataProvider(config!.indexerUri, config!.indexerWsUri);

const refresh = async () => {
  if (!config || !contractAddress()) return;
  try {
    const st = await publicData().queryContractState(contractAddress());
    $('value').textContent = st ? String(Counter.ledger(st.data).round) : '(not found)';
  } catch (e) { log(`read failed: ${(e as Error).message}`, 'bad'); }
};
$('refresh').addEventListener('click', refresh);

const providers = async () => {
  if (!connected || !config) throw new Error('connect a wallet first');
  const client = createAetherDustClient({ baseUrl: baseUrl(), apiKey: apiKey(), userId: userId(), waitMs: 30_000, timeoutMs: 240_000 });
  const sponsored = await createSponsoredMidnightProvider({
    client, wallet: connected, requestIdPrefix: 'counter',
    onRequest: (r: SponsorshipRequest) => log(`AetherDust: ${r.status} (${r.internal_status})${r.sponsored_dust ? ` · sponsor paid ${r.sponsored_dust} DUST` : ''} · request ${r.request_id}`, r.status === 'confirmed' ? 'ok' : ''),
  });
  // V7 diagnostic: after the wallet balances with payFees:false the sealed tx must carry NO DustSpend
  const balanceTx = sponsored.balanceTx.bind(sponsored);
  sponsored.balanceTx = async (tx) => {
    const sealed = await balanceTx(tx);
    let spends = 0;
    for (const intent of sealed.intents?.values() ?? []) spends += intent.dustActions?.spends?.length ?? 0;
    log(spends === 0 ? 'wallet honoured payFees:false — sealed tx carries no DustSpend' : `wallet ADDED ${spends} DustSpend(s) despite payFees:false — it paid the fee itself; AetherDust will reject this (R6)`, spends === 0 ? 'ok' : 'bad');
    return sealed;
  };
  const zk = new FetchZkConfigProvider<'increment'>(new URL('/counter', location.origin).toString());
  // the wallet-reported public proof server typically lacks CORS headers for browser pages; prefer an explicit one
  const proofUrl = proofServerField() || config.proverServerUri || 'http://localhost:6300';
  log(`proving on ${proofUrl}`);
  const keys = sponsored.keys;
  return {
    privateStateProvider: levelPrivateStateProvider<'counterPrivateState'>({ privateStateStoreName: 'aetherdust-counter', accountId: keys.coinPublicKey, privateStoragePasswordProvider: () => `${keys.coinPublicKey}!` }),
    publicDataProvider: publicData(),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(proofUrl, zk),
    walletProvider: sponsored,
    midnightProvider: sponsored,
  };
};

$('increment').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('increment');
  btn.disabled = true;
  $('status').textContent = 'proving → wallet (payFees:false) → AetherDust → chain…';
  try {
    if (!/^[0-9a-f]{64}$/i.test(contractAddress())) throw new Error('enter the counter contract address');
    const p = await providers();
    const counter = await findDeployedContract(p, { compiledContract: compiledCounter, privateStateId: 'counterPrivateState', initialPrivateState: { privateCounter: 0 }, contractAddress: contractAddress() });
    const t0 = Date.now();
    const res = await counter.callTx.increment();
    log(`confirmed in block ${res.public.blockHeight} (tx ${res.public.txId.slice(0, 18)}…) after ${((Date.now() - t0) / 1000).toFixed(1)} s`, 'ok');
    $('status').textContent = 'done';
    await refresh();
    await showBalances();
  } catch (e) {
    const ad = findAetherDustError(e);
    if (ad) log(`AetherDust refused: ${ad.code} — ${ad.message}${ad.rejectedByPolicy ? ' (policy; nothing was spent)' : ''}`, 'bad');
    else log(`failed: ${(e as Error).message}`, 'bad');
    $('status').textContent = 'failed';
  } finally { btn.disabled = false; }
});

log(`ready. wallets on window.midnight: ${walletsAvailable().map(([k, w]) => `${k} (${w.name})`).join(', ') || 'none yet'}`);
void ledger; // keeps the ledger WASM in the bundle for the diagnostic above
