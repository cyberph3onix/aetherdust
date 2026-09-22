import { configWarnings, loadConfig } from '@aetherdust/config';
import { createPool, migrate } from '@aetherdust/db';
import { createSponsorAdapter } from '@aetherdust/midnight';
import pino from 'pino';
import { buildInternalServer, needsInternalServer } from './internal.js';
import { createWorkerMetrics } from './metrics.js';
import type { WorkerDeps } from './deps.js';
import { startEventLoopWatchdog } from './watchdog.js';
import { Worker } from './worker.js';

const config = loadConfig();
const log = pino({ level: config.AETHERDUST_LOG_LEVEL, redact: ['*.seed', '*.secret', '*.token'] });
const pool = createPool(config.AETHERDUST_DATABASE_URL, 8);
if (config.AETHERDUST_AUTO_MIGRATE) await migrate(pool, (m) => log.info(m));
for (const w of configWarnings(config)) log.warn(w);
const watchdog = config.AETHERDUST_EVENT_LOOP_WATCHDOG_S > 0 ? startEventLoopWatchdog(config.AETHERDUST_EVENT_LOOP_WATCHDOG_S * 1000, log) : undefined;
const adapter = await createSponsorAdapter(config, 'worker', { log });
const deps: WorkerDeps = { config, pool, adapter, log, now: () => new Date() };
const worker = new Worker(deps);
if (config.AETHERDUST_METRICS_ENABLED) deps.metrics = createWorkerMetrics(deps, () => worker.inFlight);
// the api needs fee estimates + wallet health from this process when the real adapter is in use. Listen BEFORE the
// wallet sync (minutes to hours on a public network) so the api gets "wallet not started/syncing" instead of a dead socket.
const internal = needsInternalServer(deps) ? buildInternalServer(deps) : null;
if (internal) await internal.listen({ host: config.AETHERDUST_WORKER_INTERNAL_HOST, port: config.AETHERDUST_WORKER_INTERNAL_PORT });
await adapter.start();
await worker.start();
log.info({ worker: config.AETHERDUST_WORKER_ID, adapter: adapter.name, network: adapter.network, internalPort: internal ? config.AETHERDUST_WORKER_INTERNAL_PORT : null, metrics: config.AETHERDUST_METRICS_ENABLED }, 'aetherdust worker started');
const shutdown = async () => { log.info('shutting down'); watchdog?.stop(); await worker.stop(); await internal?.close(); await adapter.stop(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
