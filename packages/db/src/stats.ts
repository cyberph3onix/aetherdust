import { big, type Db } from './client.js';
import { row, type SponsorshipRequest } from './requests.js';

/**
 * Cross-application aggregates. These back both `/metrics` (Prometheus gauges, PRD §25) and the dashboard's
 * overview page (§19.1) — one set of queries so a number on the dashboard and the same number in Prometheus
 * can never be computed two different ways.
 */

export interface StatusCount { applicationId: string; status: string; count: number }
export const statusCountsAll = async (db: Db, since?: Date): Promise<StatusCount[]> =>
  (await db.query(
    `SELECT application_id, status, COUNT(*)::int AS n FROM sponsorship_requests
     WHERE ($1::timestamptz IS NULL OR created_at >= $1) GROUP BY 1, 2`, [since ?? null]))
    .rows.map((r: any) => ({ applicationId: r.application_id, status: r.status, count: r.n }));

export interface SponsoredTotal { applicationId: string; specks: bigint; count: number }
/** Confirmed sponsorship spend (usage records are written exactly once per CONFIRMED request). */
export const sponsoredTotals = async (db: Db, since?: Date): Promise<SponsoredTotal[]> =>
  (await db.query(
    `SELECT application_id, COALESCE(SUM(specks),0)::text AS specks, COUNT(*)::int AS n FROM usage_records
     WHERE ($1::timestamptz IS NULL OR created_at >= $1) GROUP BY 1`, [since ?? null]))
    .rows.map((r: any) => ({ applicationId: r.application_id, specks: big(r.specks), count: r.n }));

export interface PeriodBudget { applicationId: string; periodStart: Date; limit: bigint; reserved: bigint; settled: bigint; users: number }
/** The current global bucket per application, with how many users have spent in the same period. */
export const globalBudgets = async (db: Db, periodStart: Date): Promise<PeriodBudget[]> =>
  (await db.query(
    `SELECT b.application_id, b.period_start, b.limit_specks, b.reserved_specks, b.settled_specks,
            (SELECT COUNT(*)::int FROM budget_periods u WHERE u.application_id = b.application_id AND u.scope = 'user' AND u.period_start = b.period_start) AS users
     FROM budget_periods b WHERE b.scope = 'global' AND b.period_start = $1`, [periodStart]))
    .rows.map((r: any) => ({ applicationId: r.application_id, periodStart: r.period_start, limit: big(r.limit_specks), reserved: big(r.reserved_specks), settled: big(r.settled_specks), users: r.users }));

/** Submit → confirm latency, in seconds, over the window. Percentiles come from the worker histogram; this is the
 *  DB-side truth the dashboard shows (and it survives worker restarts). */
export interface ConfirmationLatency { count: number; avgSeconds: number | null; p50Seconds: number | null; p95Seconds: number | null; maxSeconds: number | null }
export const confirmationLatency = async (db: Db, since: Date): Promise<ConfirmationLatency> => {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n,
            AVG(EXTRACT(EPOCH FROM (confirmed_at - submitted_at)))::float8 AS avg,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - submitted_at)))::float8 AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (confirmed_at - submitted_at)))::float8 AS p95,
            MAX(EXTRACT(EPOCH FROM (confirmed_at - submitted_at)))::float8 AS max
     FROM sponsorship_requests
     WHERE status = 'CONFIRMED' AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_at >= $1`, [since]);
  const x = r.rows[0] as any;
  return { count: x.n, avgSeconds: x.avg ?? null, p50Seconds: x.p50 ?? null, p95Seconds: x.p95 ?? null, maxSeconds: x.max ?? null };
};

/** Rejection reasons across every application, most frequent first (§19.4). */
export const rejectionReasonsAll = async (db: Db, since: Date): Promise<{ code: string; count: number }[]> =>
  (await db.query(
    `SELECT COALESCE(reason_code,'?') AS code, COUNT(*)::int AS n FROM sponsorship_requests
     WHERE created_at >= $1 AND status IN ('REJECTED','SPONSORING_FAILED','SUBMISSION_FAILED','EXPIRED')
     GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [since]))
    .rows.map((r: any) => ({ code: r.code, count: r.n }));

/** DUST spent per bucket across every application — the overview sparkline. */
export const sponsoredSeriesAll = async (db: Db, from: Date, to: Date, bucket: 'hour' | 'day'): Promise<{ bucket: Date; specks: bigint; count: number }[]> =>
  (await db.query(
    `SELECT date_trunc($3, created_at) AS bucket, SUM(specks)::text AS specks, COUNT(*)::int AS n FROM usage_records
     WHERE created_at >= $1 AND created_at <= $2 GROUP BY 1 ORDER BY 1`, [from, to, bucket]))
    .rows.map((r: any) => ({ bucket: r.bucket, specks: big(r.specks), count: r.n }));

/** Most recent requests across every application (overview feed). */
export const recentRequests = async (db: Db, limit = 20): Promise<SponsorshipRequest[]> =>
  (await db.query('SELECT * FROM sponsorship_requests ORDER BY created_at DESC LIMIT $1', [Math.min(limit, 200)])).rows.map(row);
