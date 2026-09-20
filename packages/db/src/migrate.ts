import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies migrations/*.sql in name order, once each, under an advisory lock so concurrent starters don't race. */
export const migrate = async (pool: Pool, log: (msg: string) => void = () => {}): Promise<string[]> => {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7263001)');
    await client.query('CREATE TABLE IF NOT EXISTS _aetherdust_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM _aetherdust_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
        await client.query('INSERT INTO _aetherdust_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`applied migration ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7263001)').catch(() => {});
    client.release();
  }
  return applied;
};
