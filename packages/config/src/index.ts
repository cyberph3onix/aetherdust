import { z } from 'zod';

const bool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');
const int = (d: number) => z.coerce.number().int().nonnegative().default(d);

/** Every process reads exactly this; secrets that only the worker needs are optional here and asserted where used. */
export const ConfigSchema = z.object({
  AETHERDUST_DATABASE_URL: z.string().url().describe('postgres://user:pass@host:5432/aetherdust'),
  AETHERDUST_ADMIN_TOKEN: z.string().min(16, 'admin token must be at least 16 chars'),
  AETHERDUST_INTERNAL_SECRET: z.string().min(16).optional().describe('shared secret between api and worker (Phase 2)'),
  AETHERDUST_SPONSOR_ADAPTER: z.enum(['mock', 'midnight']).default('mock'),
  AETHERDUST_API_HOST: z.string().default('0.0.0.0'),
  AETHERDUST_API_PORT: int(8080),
  AETHERDUST_AUTO_MIGRATE: bool.default(true),
  AETHERDUST_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  AETHERDUST_FEE_MARGIN: z.coerce.number().min(0).max(5).default(0.1).describe('reserve = estimate × (1 + margin)'),
  AETHERDUST_MAX_WAIT_MS: int(30_000).describe('upper bound for ?wait= long-poll on POST'),
  AETHERDUST_CONFIRM_TIMEOUT_S: int(180),
  AETHERDUST_MIN_TTL_HEADROOM_MS: int(120_000).describe('a user tx whose TTL is closer than this is expired instead of sponsored'),
  AETHERDUST_WALLET_SNAPSHOT_S: int(15),
  AETHERDUST_WORKER_ID: z.string().default(() => `worker-${process.pid}`),
  AETHERDUST_WORKER_POLL_MS: int(500),
  AETHERDUST_WORKER_CONCURRENCY: int(4).describe('upper bound; the Midnight adapter further caps it at available DUST coins'),
  AETHERDUST_MIN_SPONSOR_DUST: z.string().default('1').describe('SPONSOR_BALANCE_LOW threshold, decimal DUST'),
  // mock adapter knobs
  AETHERDUST_MOCK_FEE_DUST: z.string().default('0.004'),
  AETHERDUST_MOCK_CONFIRM_MS: int(300),
  AETHERDUST_MOCK_DUST_COINS: int(5),
  AETHERDUST_MOCK_DUST_BALANCE_DUST: z.string().default('1000'),
  // Midnight (Phase 2)
  MIDNIGHT_NETWORK: z.enum(['undeployed', 'preview', 'preprod', 'mainnet']).default('undeployed'),
  MIDNIGHT_NODE_URL: z.string().url().optional().describe('defaults: undeployed → http://127.0.0.1:9944, public nets → https://rpc.<net>.midnight.network'),
  MIDNIGHT_INDEXER_URL: z.string().url().optional(),
  MIDNIGHT_INDEXER_WS_URL: z.string().optional(),
  MIDNIGHT_PROOF_SERVER_URL: z.string().url().optional().describe('MUST be a private proof server (it sees the sponsor’s witness data)'),
  AETHERDUST_SPONSOR_SEED: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  AETHERDUST_SPONSOR_SEED_FILE: z.string().optional(),
  AETHERDUST_SPONSOR_TTL_MIN: int(30).describe('TTL of the sponsor’s balancing intent (the merged tx expires at the minimum of user/sponsor TTLs)'),
  AETHERDUST_SUBMIT_WAIT: z.enum(['Submitted', 'InBlock', 'Finalized']).default('Finalized').describe('how long submit blocks: Finalized = facade path with pending-spend tracking (Phase 0 proven)'),
  AETHERDUST_DUST_FEE_OVERHEAD_SPECKS: z.string().regex(/^\d+$/).default('0').describe('costParameters.additionalFeeOverhead — keep ≈0 (the SDK example’s 0.3 DUST overpays ~80×)'),
  AETHERDUST_DUST_FEE_BLOCKS_MARGIN: int(5),
  AETHERDUST_WALLET_SYNC_TIMEOUT_S: int(900),
  AETHERDUST_RECONCILE_INTERVAL_S: int(30).describe('how often TIMEOUT/UNKNOWN requests are re-checked against the indexer'),
  AETHERDUST_CONFIRM_GRACE_S: int(3 * 3600).describe('after the user TTL + this, an unconfirmed submission is declared EXPIRED (DUST grace period is 3 h)'),
  // api ↔ worker private RPC (estimate + health). Only used when AETHERDUST_SPONSOR_ADAPTER=midnight.
  AETHERDUST_WORKER_INTERNAL_HOST: z.string().default('0.0.0.0'),
  AETHERDUST_WORKER_INTERNAL_PORT: int(8081),
  AETHERDUST_WORKER_URL: z.string().url().optional().describe('api → worker base URL, e.g. http://worker:8081'),
});
export type Config = z.output<typeof ConfigSchema>;
export type MidnightNetwork = Config['MIDNIGHT_NETWORK'];

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const r = ConfigSchema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`invalid configuration:\n${lines}`);
  }
  return r.data;
};

/** Resolved Midnight endpoints: explicit env wins, else the well-known URL for the network. */
export interface MidnightEndpoints { network: MidnightNetwork; node: string; indexer: string; indexerWs: string; proofServer: string }
export const midnightEndpoints = (c: Config): MidnightEndpoints => {
  const n = c.MIDNIGHT_NETWORK;
  const def = n === 'undeployed'
    ? { node: 'http://127.0.0.1:9944', indexer: 'http://127.0.0.1:8088/api/v4/graphql', indexerWs: 'ws://127.0.0.1:8088/api/v4/graphql/ws' }
    : { node: `https://rpc.${n}.midnight.network`, indexer: `https://indexer.${n}.midnight.network/api/v4/graphql`, indexerWs: `wss://indexer.${n}.midnight.network/api/v4/graphql/ws` };
  return {
    network: n,
    node: c.MIDNIGHT_NODE_URL ?? def.node,
    indexer: c.MIDNIGHT_INDEXER_URL ?? def.indexer,
    indexerWs: c.MIDNIGHT_INDEXER_WS_URL ?? def.indexerWs,
    proofServer: c.MIDNIGHT_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
  };
};

/** Worker-only: the sponsor seed from env or a mounted file. Never logged. */
export const loadSponsorSeed = (c: Config, readFile: (p: string) => string): string => {
  const raw = c.AETHERDUST_SPONSOR_SEED ?? (c.AETHERDUST_SPONSOR_SEED_FILE ? readFile(c.AETHERDUST_SPONSOR_SEED_FILE).trim() : undefined);
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) throw new Error('AETHERDUST_SPONSOR_SEED (or _SEED_FILE) must hold a 64-hex-char seed when AETHERDUST_SPONSOR_ADAPTER=midnight');
  return raw.toLowerCase();
};

/** Keys that must never appear in logs. */
export const SECRET_ENV_KEYS = ['AETHERDUST_ADMIN_TOKEN', 'AETHERDUST_INTERNAL_SECRET', 'AETHERDUST_SPONSOR_SEED', 'AETHERDUST_DATABASE_URL'] as const;
