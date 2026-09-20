import type { Config } from '@aetherdust/config';
import { MemoryRateLimitStore, RateLimiter } from '@aetherdust/core';
import type { SponsorAdapter } from '@aetherdust/midnight';
import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface Deps {
  config: Config;
  pool: Pool;
  adapter: SponsorAdapter;
  limiter: RateLimiter;
  log: Logger;
  now: () => Date;
}
export const makeLimiter = () => new RateLimiter(new MemoryRateLimitStore(), 60_000);
