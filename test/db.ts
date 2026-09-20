import { createPool, migrate } from '@aetherdust/db';
import type { Pool } from 'pg';
import { inject } from 'vitest';

let pool: Pool | undefined;
/** Shared pool for a test file; migrations applied once per process. */
export const testPool = async (): Promise<Pool> => {
  if (!pool) {
    pool = createPool(inject('databaseUrl'), 20);
    await migrate(pool);
  }
  return pool;
};
export const truncateAll = async (p: Pool) => {
  await p.query('TRUNCATE request_events, usage_records, sponsorship_requests, budget_periods, policies, api_keys, applications, sponsor_wallet_snapshots RESTART IDENTITY CASCADE');
};
export const closeTestPool = async () => { await pool?.end(); pool = undefined; };
