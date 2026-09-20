import type { Config } from '@aetherdust/config';
import type { SponsorAdapter } from '@aetherdust/midnight';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
export interface WorkerDeps { config: Config; pool: Pool; adapter: SponsorAdapter; log: Logger; now: () => Date }
