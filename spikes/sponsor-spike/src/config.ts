/**
 * Network configuration for the spike. Defaults target the local `undeployed` stack
 * (deploy/standalone.yml); set MIDNIGHT_NETWORK=preview|preprod to use public infra
 * (you still need your own proof server on :6300).
 */
import path from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';

export type NetworkName = 'undeployed' | 'preview' | 'preprod';

export interface Config {
  network: NetworkName;
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  zkConfigPath: string;
  privateStateDir: string;
}

// Genesis wallet of the `undeployed` dev node (midnightntwrk/example-counter). Pre-funded with tNIGHT.
export const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
// A deterministic, *unfunded* user seed: the whole point is a user with 0 NIGHT / 0 DUST.
export const DEFAULT_USER_SEED = '00000000000000000000000000000000000000000000000000000000000000a7';

const env = (k: string, d: string) => process.env[k] ?? d;

export const loadConfig = (): Config => {
  const network = env('MIDNIGHT_NETWORK', 'undeployed') as NetworkName;
  const pub = (n: string) => ({
    indexer: `https://indexer.${n}.midnight.network/api/v4/graphql`,
    indexerWS: `wss://indexer.${n}.midnight.network/api/v4/graphql/ws`,
    node: `https://rpc.${n}.midnight.network`,
  });
  const base =
    network === 'undeployed'
      ? {
          indexer: 'http://127.0.0.1:8088/api/v4/graphql',
          indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
          node: 'http://127.0.0.1:9944',
        }
      : pub(network);
  setNetworkId(network);
  const here = path.resolve(new URL(import.meta.url).pathname, '..');
  return {
    network,
    indexer: env('MIDNIGHT_INDEXER_URL', base.indexer),
    indexerWS: env('MIDNIGHT_INDEXER_WS_URL', base.indexerWS),
    node: env('MIDNIGHT_NODE_URL', base.node),
    proofServer: env('MIDNIGHT_PROOF_SERVER_URL', 'http://127.0.0.1:6300'),
    zkConfigPath: path.resolve(here, '..', 'contract', 'src', 'managed', 'counter'),
    privateStateDir: path.resolve(here, '..', '.private-state'),
  };
};

export const sponsorSeed = () => env('SPONSOR_SEED', GENESIS_SEED);
export const userSeed = () => env('USER_SEED', DEFAULT_USER_SEED);
