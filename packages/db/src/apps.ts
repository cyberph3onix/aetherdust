import { generateApiKey, hashSecret } from '@aetherdust/core';
import type { Db } from './client.js';

export interface Application { id: string; name: string; status: 'active' | 'suspended'; createdAt: Date }
export interface ApiKey { id: string; applicationId: string; keyId: string; env: string; label: string | null; status: 'active' | 'revoked'; createdAt: Date; revokedAt: Date | null; lastUsedAt: Date | null }

const app = (r: any): Application => ({ id: r.id, name: r.name, status: r.status, createdAt: r.created_at });
const key = (r: any): ApiKey => ({ id: r.id, applicationId: r.application_id, keyId: r.key_id, env: r.env, label: r.label, status: r.status, createdAt: r.created_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at });

export const createApplication = async (db: Db, name: string): Promise<Application> =>
  app((await db.query('INSERT INTO applications (name) VALUES ($1) RETURNING *', [name])).rows[0]);
export const getApplication = async (db: Db, id: string): Promise<Application | null> => {
  const r = await db.query('SELECT * FROM applications WHERE id = $1', [id]);
  return r.rows[0] ? app(r.rows[0]) : null;
};
export const listApplications = async (db: Db): Promise<Application[]> =>
  (await db.query('SELECT * FROM applications ORDER BY created_at')).rows.map(app);
export const setApplicationStatus = async (db: Db, id: string, status: Application['status']): Promise<void> => {
  await db.query('UPDATE applications SET status = $2 WHERE id = $1', [id, status]);
};

/** Returns the full token exactly once; only the scrypt hash is stored. */
export const createApiKey = async (db: Db, applicationId: string, env: 'live' | 'test', label?: string): Promise<{ key: ApiKey; token: string }> => {
  const g = generateApiKey(env);
  const r = await db.query('INSERT INTO api_keys (application_id, key_id, secret_hash, env, label) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [applicationId, g.keyId, await hashSecret(g.secret), env, label ?? null]);
  return { key: key(r.rows[0]), token: g.token };
};
export const findApiKey = async (db: Db, keyId: string): Promise<(ApiKey & { secretHash: string; applicationStatus: Application['status'] }) | null> => {
  const r = await db.query('SELECT k.*, a.status AS application_status FROM api_keys k JOIN applications a ON a.id = k.application_id WHERE k.key_id = $1', [keyId]);
  const row = r.rows[0];
  return row ? { ...key(row), secretHash: row.secret_hash, applicationStatus: row.application_status } : null;
};
export const listApiKeys = async (db: Db, applicationId: string): Promise<ApiKey[]> =>
  (await db.query('SELECT * FROM api_keys WHERE application_id = $1 ORDER BY created_at', [applicationId])).rows.map(key);
export const touchApiKey = async (db: Db, id: string): Promise<void> => {
  await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval \'1 minute\')', [id]);
};
export const revokeApiKey = async (db: Db, id: string): Promise<boolean> =>
  ((await db.query("UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE id = $1 AND status = 'active'", [id])).rowCount ?? 0) > 0;
