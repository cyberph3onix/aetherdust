/**
 * Private Allowlist Access — the browser half.
 *
 * The privacy is in the contract; this file's job is to keep the secret local, read the public record, and put the
 * two next to each other honestly. The gasless part is three lines in `providers()`:
 *   createSponsoredMidnightProvider({ client, wallet })  →  walletProvider (payFees:false) + midnightProvider
 * so a wallet holding 0 NIGHT / 0 DUST can still prove membership and get through the door.
 */
import '@midnight-ntwrk/dapp-connector-api'; // window.midnight typings
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { createAetherDustClient, createSponsoredMidnightProvider, findAetherDustError, type SponsorshipRequest } from '@aetherdust/client';
import { Allowlist, commitmentFor, createPrivateState, nullifierFor, witnesses } from '../contract/index.js';

// ---------- small helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const short = (s: string, head = 10, tail = 6) => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

const logEl = $('log');
const log = (msg: string, cls = '') => {
  const line = document.createElement('div');
  line.className = cls;
  const t = document.createElement('time');
  t.textContent = new Date().toTimeString().slice(0, 8);
  line.append(t, document.createTextNode(msg));
  logEl.prepend(line);
  (cls === 'bad' ? console.error : console.log)(`[allowlist] ${msg}`);
};
window.addEventListener('error', (e) => log(`page error: ${e.message}`, 'bad'));
window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${(e.reason as Error)?.message ?? e.reason}`, 'bad'));

const field = (id: string, key: string, def = '') => {
  const el = $<HTMLInputElement>(id);
  el.value = localStorage.getItem(`allowlist.${key}`) ?? def;
  el.addEventListener('input', () => localStorage.setItem(`allowlist.${key}`, el.value.trim()));
  return () => el.value.trim();
};
const network = field('network', 'network', 'preprod');
const contractAddress = field('contract', 'contract');
const baseUrl = field('baseUrl', 'baseUrl', 'http://localhost:8080');
const apiKey = field('apiKey', 'apiKey');
const userId = field('userId', 'userId', 'demo-user-1');
const proofServerField = field('proofServer', 'proofServer', 'http://localhost:6300');
const indexerField = field('indexer', 'indexer', '');

/** Well-known indexer for a network, so the public record loads before any wallet is connected. */
const defaultIndexer = (net: string): { url: string; ws: string } =>
  net === 'undeployed'
    ? { url: 'http://127.0.0.1:8088/api/v4/graphql', ws: 'ws://127.0.0.1:8088/api/v4/graphql/ws' }
    : { url: `https://indexer.${net}.midnight.network/api/v4/graphql`, ws: `wss://indexer.${net}.midnight.network/api/v4/graphql/ws` };

/**
 * The indexer to read from: the connected wallet's, else the one configured here, else the network's well-known
 * one. Reading the allowlist is a public act — a visitor should see the list and the tally before connecting
 * anything.
 */
const indexer = () => {
  if (walletConfig) return { url: walletConfig.indexerUri, ws: walletConfig.indexerWsUri };
  const configured = indexerField();
  if (configured) return { url: configured, ws: configured.replace(/^http/, 'ws').replace(/\/graphql\/?$/, '/graphql/ws') };
  return defaultIndexer(network());
};
// the provider's default WebSocket comes from isomorphic-ws, which has no named export in a browser bundle
const publicData = () => indexerPublicDataProvider(indexer().url, indexer().ws, globalThis.WebSocket as any);

// ---------- the secret (private state, this browser only) ----------
const SECRET_KEY = 'allowlist.secret';
const freshSecret = () => crypto.getRandomValues(new Uint8Array(32));
let secret: Uint8Array = (() => {
  const stored = localStorage.getItem(SECRET_KEY);
  if (stored && /^[0-9a-f]{64}$/i.test(stored)) return unhex(stored);
  const s = freshSecret();
  localStorage.setItem(SECRET_KEY, hex(s));
  return s;
})();
let revealed = false;

const setSecret = (next: Uint8Array) => {
  secret = next;
  localStorage.setItem(SECRET_KEY, hex(next));
  renderSecret();
  void refresh();
};

const renderSecret = () => {
  $('secret').textContent = revealed ? short(hex(secret), 16, 8) : '•'.repeat(14);
  $('secret').title = revealed ? hex(secret) : 'hidden';
  $('commitment').textContent = short(hex(commitmentFor(secret)), 12, 8);
  $('commitment').title = hex(commitmentFor(secret));
};

$('reveal').addEventListener('click', () => {
  revealed = !revealed;
  $('reveal').textContent = revealed ? 'Hide' : 'Reveal';
  $('reveal').setAttribute('aria-pressed', String(revealed));
  renderSecret();
});
$('new-secret').addEventListener('click', () => {
  setSecret(freshSecret());
  log('new secret generated in this browser — ask the operator to add its commitment to the list');
});
$<HTMLInputElement>('import-secret').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value.trim();
  if (!/^[0-9a-f]{64}$/i.test(v)) return log('a secret is 64 hex characters', 'bad');
  setSecret(unhex(v));
  (e.target as HTMLInputElement).value = '';
  log('secret imported');
});

// ---------- wallet ----------
let connected: ConnectedAPI | undefined;
let walletConfig: Awaited<ReturnType<ConnectedAPI['getConfiguration']>> | undefined;
const wallets = (): [string, InitialAPI][] => Object.entries(window.midnight ?? {});

const connect = async () => {
  const found = wallets();
  if (found.length === 0) throw new Error('no Midnight wallet on window.midnight — is Lace installed and enabled for this site?');
  const [id, api] = found.find(([k]) => /lace/i.test(k)) ?? found[0]!;
  log(`connecting to ${api.name} (${id}, connector api ${api.apiVersion}) on ${network()}…`);
  const c = await api.connect(network());
  const status = await c.getConnectionStatus();
  if (status.status !== 'connected') throw new Error('the wallet did not connect');
  if (status.networkId !== network()) throw new Error(`the wallet is on ${status.networkId}, this page is set to ${network()} — change one of them`);

  connected = c;
  walletConfig = await c.getConfiguration();
  setNetworkId(status.networkId as Parameters<typeof setNetworkId>[0]);
  const { shieldedAddress } = await c.getShieldedAddresses();
  $('wallet-id').textContent = `${api.name} · ${short(shieldedAddress, 14, 6)}`;
  $('wallet-btn').textContent = 'Disconnect';
  $('net-badge').textContent = status.networkId;

  const [dust, unshielded] = await Promise.all([c.getDustBalance(), c.getUnshieldedBalances()]);
  const night = Object.values(unshielded).reduce((a, b) => a + b, 0n);
  log(`connected · ${night} STAR NIGHT · ${dust.balance} SPECK DUST${night === 0n && dust.balance === 0n ? ' — a wallet holding nothing, which is the point' : ''}`, 'ok');
  await refresh();
};

/**
 * Disconnect, as far as a DApp can: connector API 4.0.1 has `connect` and no `disconnect`, so a page can drop the
 * session and stop using the wallet, but it cannot revoke the permission the wallet granted this site. We call a
 * `disconnect` method if a wallet happens to provide one, and say plainly what happened either way.
 */
const disconnect = async () => {
  const wallet = connected as unknown as { disconnect?: () => Promise<void> } | undefined;
  let revoked = false;
  if (typeof wallet?.disconnect === 'function') {
    try { await wallet.disconnect(); revoked = true; } catch { /* keep going: the page disconnects regardless */ }
  }
  connected = undefined;
  walletConfig = undefined;
  $('wallet-id').textContent = 'no wallet';
  $('wallet-btn').textContent = 'Connect wallet';
  setStamp('unknown');
  log(revoked
    ? 'disconnected, and the wallet revoked this site'
    : 'disconnected — this page has dropped the wallet. Lace still lists the site under its connected sites; remove it there to revoke.');
  await refresh();
};

$('wallet-btn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('wallet-btn');
  const label = btn.textContent;
  btn.disabled = true;
  if (!connected) btn.textContent = 'Check your wallet…'; // the wallet's approval prompt can open behind this window
  try {
    connected ? await disconnect() : await connect();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    log(`connect failed: ${msg}`, 'bad');
    // say what to do about it, next to the button that failed — the wallet's own words are usually the clearest
    $('wallet-id').textContent = /lock/i.test(msg) ? 'wallet locked — unlock it, then press Connect again'
      : /network/i.test(msg) ? msg
        : `connect failed: ${msg}`;
    btn.textContent = label ?? 'Connect wallet';
  } finally { btn.disabled = false; }
});

// a page with no wallet extension should say so before anything is clicked, not only in the log at the bottom
if (wallets().length === 0) {
  $('wallet-id').textContent = 'no wallet extension detected';
  $('wallet-btn').title = 'No Midnight wallet is exposing itself to this page. Install Lace, unlock it, enable it for this site, then reload.';
}

// ---------- reading the public record ----------
// the ZK assets are served beside the page, so they must respect the deployment's base path (a GitHub Pages
// project site serves from /<repo>/, not from the domain root)
const assetsUrl = new URL(`${import.meta.env.BASE_URL}allowlist`, location.origin).toString();
const compiled = CompiledContract.make('allowlist', Allowlist.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(assetsUrl),
);

type Verdict = 'yes' | 'no' | 'unknown';
const setVerdict = (id: string, v: Verdict, text: string) => {
  const el = $(id);
  el.dataset.v = v;
  el.textContent = text;
};

const setStamp = (state: 'unknown' | 'granted' | 'refused') => {
  const stamp = $('stamp');
  stamp.dataset.state = state;
  $('stamp-mark').style.display = state === 'granted' ? '' : 'none';
  $('stamp-empty').style.display = state === 'granted' ? 'none' : '';
  $('stamp-legend').textContent = state === 'granted'
    ? 'ADMITTED · ANONYMOUS · ADMITTED · ANONYMOUS · '
    : 'MEMBER · UNPROVEN · MEMBER · UNPROVEN · ';
};

const render = (s: { listed: Verdict; entered: Verdict }) => {
  setVerdict('listed', s.listed, s.listed === 'yes' ? 'yes' : s.listed === 'no' ? 'not on it' : 'unknown');
  setVerdict('entered', s.entered, s.entered === 'yes' ? 'yes, already' : s.entered === 'no' ? 'not yet' : 'unknown');
  $<HTMLButtonElement>('claim').disabled = !(connected && s.listed === 'yes' && s.entered === 'no');
  $('steps').querySelector<HTMLElement>('[data-step="wallet"]')!.dataset.done = String(!!connected);
  $('steps').querySelector<HTMLElement>('[data-step="member"]')!.dataset.done = String(s.listed === 'yes');
  $('steps').querySelector<HTMLElement>('[data-step="entered"]')!.dataset.done = String(s.entered === 'yes');
  if (s.entered === 'yes') setStamp('granted');
  else if (s.listed === 'no') setStamp('refused');
  else setStamp('unknown');
};

const refresh = async () => {
  renderSecret();
  if (!connected) $('net-badge').textContent = network() || 'no network'; // the badge follows the field until a wallet says otherwise
  $('contract-out').textContent = contractAddress() ? short(contractAddress(), 10, 8) : 'not set';
  $('contract-out').title = contractAddress();
  if (!/^[0-9a-f]{64}$/i.test(contractAddress())) return render({ listed: 'unknown', entered: 'unknown' });

  try {
    const state = await publicData().queryContractState(contractAddress());
    if (!state) { log('no contract at that address on this network', 'bad'); return render({ listed: 'unknown', entered: 'unknown' }); }

    const ledger = Allowlist.ledger(state.data);
    const mine = nullifierFor(secret);
    const stamps = [...ledger.nullifiers];

    for (const [id, value] of [['members', ledger.members.firstFree()], ['admissions', ledger.admissions]] as const) {
      $(id).textContent = String(value);
      $(id).dataset.empty = 'false';
    }
    $('root').textContent = short(ledger.members.root().field.toString(16), 10, 6);

    const list = $('stamps');
    list.textContent = '';
    if (stamps.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'none yet';
      list.append(li);
    }
    for (const n of stamps) {
      const li = document.createElement('li');
      const isMine = same(n, mine);
      li.dataset.mine = String(isMine);
      li.textContent = `${short(hex(n), 16, 8)}${isMine ? '   ← yours, and only you can tell' : ''}`;
      li.title = hex(n);
      list.append(li);
    }

    render({
      listed: ledger.members.findPathForLeaf(commitmentFor(secret)) ? 'yes' : 'no',
      entered: stamps.some((n) => same(n, mine)) ? 'yes' : 'no',
    });
  } catch (e) {
    log(`could not read the allowlist: ${(e as Error).message}`, 'bad');
  }
};
for (const id of ['contract', 'network', 'indexer']) $<HTMLInputElement>(id).addEventListener('change', () => void refresh());

// ---------- claiming ----------
const providers = async () => {
  if (!connected || !walletConfig) throw new Error('connect a wallet first');
  const client = createAetherDustClient({ baseUrl: baseUrl(), apiKey: apiKey(), userId: userId(), waitMs: 30_000, timeoutMs: 240_000 });
  const sponsored = await createSponsoredMidnightProvider({
    client, wallet: connected, requestIdPrefix: 'allowlist',
    onRequest: (r: SponsorshipRequest) => log(
      `sponsorship ${r.status}${r.sponsored_dust ? ` · the sponsor paid ${r.sponsored_dust} DUST, not you` : ''}`,
      r.status === 'confirmed' ? 'ok' : '',
    ),
  });
  const zk = new FetchZkConfigProvider<'claimAccess'>(assetsUrl);
  const proofUrl = proofServerField() || walletConfig.proverServerUri || 'http://localhost:6300';
  log(`proving membership on ${proofUrl}`);
  return {
    privateStateProvider: levelPrivateStateProvider<'allowlistPrivateState'>({
      privateStateStoreName: 'allowlist-dapp',
      accountId: sponsored.keys.coinPublicKey,
      privateStoragePasswordProvider: () => `${sponsored.keys.coinPublicKey}!`,
    }),
    publicDataProvider: publicData(),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(proofUrl, zk),
    walletProvider: sponsored,
    midnightProvider: sponsored,
  };
};

$('claim').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('claim');
  const status = $('claim-status');
  btn.disabled = true;
  status.textContent = 'Building the proof in this browser…';
  try {
    const p = await providers();
    // the private state is the secret this browser holds right now, not whatever a previous session stored;
    // the store is scoped per contract, so its address has to be set before anything is written
    p.privateStateProvider.setContractAddress(contractAddress());
    await p.privateStateProvider.set('allowlistPrivateState', createPrivateState(secret));
    status.textContent = 'Proving membership, then asking the sponsor to pay the fee…';
    const contract = await findDeployedContract(p, {
      compiledContract: compiled, privateStateId: 'allowlistPrivateState',
      initialPrivateState: createPrivateState(secret), contractAddress: contractAddress(),
    });
    const t0 = Date.now();
    const res = await contract.callTx.claimAccess();
    log(`admitted in block ${res.public.blockHeight} (tx ${short(res.public.txId, 12, 6)}) after ${((Date.now() - t0) / 1000).toFixed(1)} s`, 'ok');
    status.textContent = 'You are through the door. The chain knows a member entered, not which one.';
    await refresh();
  } catch (e) {
    const ad = findAetherDustError(e);
    if (ad) {
      log(`the sponsor refused: ${ad.code} — ${ad.message}${ad.rejectedByPolicy ? ' (policy; nothing was spent)' : ''}`, 'bad');
      status.textContent = `The sponsor refused this request: ${ad.code}.`;
    } else {
      const msg = (e as Error).message ?? String(e);
      log(`could not enter: ${msg}`, 'bad');
      status.textContent = /already claimed/.test(msg) ? 'This secret has already been used to enter.'
        : /not on the allowlist|path is not for this member/.test(msg) ? 'This secret is not on the allowlist.'
          : 'Could not enter — see the activity log.';
    }
    await refresh();
  } finally {
    btn.disabled = false;
  }
});

// ---------- start ----------
setStamp('unknown');
renderSecret();
void refresh();
log(`ready · wallets on this page: ${wallets().map(([k, w]) => `${w.name} (${k})`).join(', ') || 'none detected'}`);
