import { loadConfig } from '@aetherdust/config';
import { createPool, migrate } from '@aetherdust/db';
import { createSponsorAdapter } from '@aetherdust/midnight';
import pino from 'pino';
import { makeLimiter } from './deps.js';
import { buildServer } from './server.js';

const config = loadConfig();
const log = pino({ level: config.AETHERDUST_LOG_LEVEL, redact: ['req.headers.authorization', 'headers.authorization', '*.secret', '*.seed', '*.token'] });
const pool = createPool(config.AETHERDUST_DATABASE_URL);
if (config.AETHERDUST_AUTO_MIGRATE) await migrate(pool, (m) => log.info(m));
const adapter = await createSponsorAdapter(config, 'api');
await adapter.start();
const app = await buildServer({ config, pool, adapter, limiter: makeLimiter(), log, now: () => new Date() });
await app.listen({ host: config.AETHERDUST_API_HOST, port: config.AETHERDUST_API_PORT });
log.info({ port: config.AETHERDUST_API_PORT, adapter: adapter.name, docs: '/docs' }, 'aetherdust api listening');
const shutdown = async () => { await app.close(); await adapter.stop(); await pool.end(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
