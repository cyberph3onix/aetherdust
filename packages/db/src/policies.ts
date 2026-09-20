import { parsePolicy, type Policy, type PolicyInput } from '@aetherdust/core';
import { isUniqueViolation, jsonb, type Db } from './client.js';

export interface PolicyRecord { applicationId: string; version: number; document: PolicyInput; policy: Policy; createdAt: Date }
const rec = (r: any): PolicyRecord => ({ applicationId: r.application_id, version: r.version, document: r.document, policy: parsePolicy(r.document), createdAt: r.created_at });

/** Append a new policy version (validated). Retries once on a version race. */
export const putPolicy = async (db: Db, applicationId: string, document: PolicyInput): Promise<PolicyRecord> => {
  parsePolicy(document); // validate before touching the DB
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await db.query(
        `INSERT INTO policies (application_id, version, document)
         VALUES ($1, COALESCE((SELECT MAX(version) FROM policies WHERE application_id = $1), 0) + 1, $2::jsonb) RETURNING *`,
        [applicationId, jsonb(document)]);
      return rec(r.rows[0]);
    } catch (e) {
      if (!isUniqueViolation(e) || attempt === 1) throw e;
    }
  }
  throw new Error('unreachable');
};
export const getActivePolicy = async (db: Db, applicationId: string): Promise<PolicyRecord | null> => {
  const r = await db.query('SELECT * FROM policies WHERE application_id = $1 ORDER BY version DESC LIMIT 1', [applicationId]);
  return r.rows[0] ? rec(r.rows[0]) : null;
};
export const listPolicyVersions = async (db: Db, applicationId: string): Promise<PolicyRecord[]> =>
  (await db.query('SELECT * FROM policies WHERE application_id = $1 ORDER BY version DESC', [applicationId])).rows.map(rec);
