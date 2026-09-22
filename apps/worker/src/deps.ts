import type { Config } from '@aetherdust/config';
import type { SponsorAdapter } from '@aetherdust/midnight';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { WorkerMetrics } from './metrics.js';

export interface WorkerDeps {
  config: Config; pool: Pool; adapter: SponsorAdapter; log: Logger; now: () => Date;
  /** Optional: tests and embedded workers run without a registry. */
  metrics?: WorkerMetrics;
}
