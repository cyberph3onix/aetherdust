import { Pool } from 'pg';
import { migrate } from './migrate.js';
const url = process.env.AETHERDUST_DATABASE_URL;
if (!url) { console.error('AETHERDUST_DATABASE_URL is required'); process.exit(1); }
const pool = new Pool({ connectionString: url });
migrate(pool, console.log).then((a) => { console.log(a.length ? `applied ${a.length} migration(s)` : 'up to date'); return pool.end(); })
  .catch((e) => { console.error(e); process.exit(1); });
