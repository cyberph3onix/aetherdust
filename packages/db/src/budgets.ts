import { big, type Db } from './client.js';

export interface BudgetRow { scope: 'global' | 'user'; scopeKey: string; periodStart: Date; periodEnd: Date; limit: bigint; reserved: bigint; settled: bigint }
const row = (r: any): BudgetRow => ({ scope: r.scope, scopeKey: r.scope_key, periodStart: r.period_start, periodEnd: r.period_end, limit: big(r.limit_specks), reserved: big(r.reserved_specks), settled: big(r.settled_specks) });

export interface ReserveArgs {
  applicationId: string; userId: string; periodStart: Date; periodEnd: Date;
  globalLimit: bigint; userLimit: bigint; amount: bigint;
}
export type ReserveResult = { ok: true } | { ok: false; scope: 'global' | 'user'; row: BudgetRow | null };

/**
 * Atomically reserve `amount` against both the global and the per-user bucket for the period.
 * MUST run inside a transaction; on `{ok:false}` the caller rolls back (the partial global update is undone).
 * The guard `reserved + settled + amount <= limit` is evaluated by Postgres under row locks, so concurrent
 * reservations can never overshoot the limit. The current policy limit is written to the row so it reflects
 * the latest configuration.
 */
export const reserve = async (tx: Db, a: ReserveArgs): Promise<ReserveResult> => {
  for (const [scope, key, limit] of [['global', '*', a.globalLimit], ['user', a.userId, a.userLimit]] as const) {
    await tx.query(
      `INSERT INTO budget_periods (application_id, scope, scope_key, period_start, period_end, limit_specks)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (application_id, scope, scope_key, period_start) DO NOTHING`,
      [a.applicationId, scope, key, a.periodStart, a.periodEnd, limit.toString()]);
    const r = await tx.query(
      `UPDATE budget_periods SET reserved_specks = reserved_specks + $6, limit_specks = $5
       WHERE application_id = $1 AND scope = $2 AND scope_key = $3 AND period_start = $4
         AND reserved_specks + settled_specks + $6 <= $5
       RETURNING *`,
      [a.applicationId, scope, key, a.periodStart, limit.toString(), a.amount.toString()]);
    if ((r.rowCount ?? 0) === 0) {
      const cur = await tx.query('SELECT * FROM budget_periods WHERE application_id = $1 AND scope = $2 AND scope_key = $3 AND period_start = $4', [a.applicationId, scope, key, a.periodStart]);
      return { ok: false, scope, row: cur.rows[0] ? row(cur.rows[0]) : null };
    }
  }
  return { ok: true };
};

const adjust = async (tx: Db, a: { applicationId: string; userId: string; periodStart: Date }, reserved: bigint, settled: bigint) => {
  for (const [scope, key] of [['global', '*'], ['user', a.userId]] as const) {
    await tx.query(
      `UPDATE budget_periods SET reserved_specks = GREATEST(reserved_specks - $5, 0), settled_specks = settled_specks + $6
       WHERE application_id = $1 AND scope = $2 AND scope_key = $3 AND period_start = $4`,
      [a.applicationId, scope, key, a.periodStart, reserved.toString(), settled.toString()]);
  }
};
/** On CONFIRMED: drop the reservation, add what was actually spent (may exceed the reservation; on-chain truth wins). */
export const settle = (tx: Db, a: { applicationId: string; userId: string; periodStart: Date }, reserved: bigint, actual: bigint) => adjust(tx, a, reserved, actual);
/** On any failure after reservation: give the reservation back. */
export const release = (tx: Db, a: { applicationId: string; userId: string; periodStart: Date }, reserved: bigint) => adjust(tx, a, reserved, 0n);

export const getBudget = async (db: Db, applicationId: string, scope: 'global' | 'user', scopeKey: string, periodStart: Date): Promise<BudgetRow | null> => {
  const r = await db.query('SELECT * FROM budget_periods WHERE application_id = $1 AND scope = $2 AND scope_key = $3 AND period_start = $4', [applicationId, scope, scopeKey, periodStart]);
  return r.rows[0] ? row(r.rows[0]) : null;
};
export const listUserBudgets = async (db: Db, applicationId: string, periodStart: Date, limit = 100): Promise<BudgetRow[]> =>
  (await db.query("SELECT * FROM budget_periods WHERE application_id = $1 AND scope = 'user' AND period_start = $2 ORDER BY settled_specks + reserved_specks DESC LIMIT $3", [applicationId, periodStart, limit])).rows.map(row);
