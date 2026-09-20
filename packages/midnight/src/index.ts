import { midnightEndpoints, type Config } from '@aetherdust/config';
import { dustToSpecks } from '@aetherdust/core';
import type { SponsorAdapter } from './adapter.js';
import { MockSponsorAdapter } from './mock/adapter.js';
import { RemoteSponsorAdapter } from './remote/adapter.js';

export * from './adapter.js';
export * from './codec.js';
export * from './inspector.js';
export { MockSponsorAdapter } from './mock/adapter.js';
export { RemoteSponsorAdapter, INTERNAL_SECRET_HEADER, walletStatusToWire, walletStatusFromWire, type WalletStatusWire } from './remote/adapter.js';
export { NODE_ERROR_CODES, explain as explainMidnightError } from './midnight/errors.js';
export { assertSponsorOnlyPaidFees, assertBalancingIsDustOnly } from './midnight/checks.js';

const MAX_TX_BYTES = 512 * 1024;

/**
 * `api`: the mock adapter, or a remote proxy to the worker's private RPC — the API process never loads wallet code.
 * `worker`: the mock adapter, or the real WalletFacade adapter (loaded lazily so the API bundle never imports it).
 */
export interface AdapterFactoryOptions { log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void } }
export const createSponsorAdapter = async (config: Config, role: 'api' | 'worker', opts: AdapterFactoryOptions = {}): Promise<SponsorAdapter> => {
  if (config.AETHERDUST_SPONSOR_ADAPTER === 'mock') {
    return new MockSponsorAdapter({
      network: `mock:${config.MIDNIGHT_NETWORK}`, ledgerNetworkId: config.MIDNIGHT_NETWORK, feeSpecks: dustToSpecks(config.AETHERDUST_MOCK_FEE_DUST), confirmMs: config.AETHERDUST_MOCK_CONFIRM_MS,
      dustCoins: config.AETHERDUST_MOCK_DUST_COINS, dustBalanceSpecks: dustToSpecks(config.AETHERDUST_MOCK_DUST_BALANCE_DUST), maxTxBytes: MAX_TX_BYTES,
    });
  }
  const ep = midnightEndpoints(config);
  if (!config.AETHERDUST_INTERNAL_SECRET) throw new Error('AETHERDUST_INTERNAL_SECRET is required when AETHERDUST_SPONSOR_ADAPTER=midnight');
  if (role === 'api') {
    if (!config.AETHERDUST_WORKER_URL) throw new Error('AETHERDUST_WORKER_URL is required for the api when AETHERDUST_SPONSOR_ADAPTER=midnight');
    return new RemoteSponsorAdapter({ network: ep.network, workerUrl: config.AETHERDUST_WORKER_URL, secret: config.AETHERDUST_INTERNAL_SECRET, maxTxBytes: MAX_TX_BYTES });
  }
  const { readFileSync } = await import('node:fs');
  const { loadSponsorSeed } = await import('@aetherdust/config');
  const { MidnightSponsorAdapter } = await import('./midnight/adapter.js');
  return new MidnightSponsorAdapter({
    seedHex: loadSponsorSeed(config, (p) => readFileSync(p, 'utf8')),
    network: ep.network, node: ep.node, indexer: ep.indexer, indexerWs: ep.indexerWs, proofServer: ep.proofServer,
    feeOverheadSpecks: BigInt(config.AETHERDUST_DUST_FEE_OVERHEAD_SPECKS), feeBlocksMargin: config.AETHERDUST_DUST_FEE_BLOCKS_MARGIN,
    sponsorTtlMs: config.AETHERDUST_SPONSOR_TTL_MIN * 60_000, submitWait: config.AETHERDUST_SUBMIT_WAIT, syncTimeoutMs: config.AETHERDUST_WALLET_SYNC_TIMEOUT_S * 1000,
    minSponsorDustSpecks: dustToSpecks(config.AETHERDUST_MIN_SPONSOR_DUST), maxTxBytes: MAX_TX_BYTES, log: opts.log,
  });
};
