import { big, type Db } from './client.js';

export const insertUsage = async (tx: Db, a: { requestId: string; applicationId: string; userId: string; contract: string; entryPoint: string; specks: bigint; periodStart: Date }) => {
  await tx.query(
    `INSERT INTO usage_records (request_id, application_id, user_id, contract, entry_point, specks, period_start) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (request_id) DO NOTHING`,
    [a.requestId, a.applicationId, a.userId, a.contract, a.entryPoint, a.specks.toString(), a.periodStart]);
};

export interface UsageBreakdown { key: string; specks: bigint; count: number }
export interface UsageSummary {
  from: Date; to: Date;
  totalSpecks: bigint; confirmed: number; rejected: number; failed: number; pending: number;
  byContract: UsageBreakdown[]; byEntryPoint: UsageBreakdown[]; byUser: UsageBreakdown[]; byRejectionReason: { key: string; count: number }[];
  series: { bucket: Date; specks: bigint; count: number }[];
}
const bd = (rows: any[]): UsageBreakdown[] => rows.map((r) => ({ key: r.key, specks: big(r.specks), count: Number(r.n) }));

export const usageSummary = async (db: Db, applicationId: string, from: Date, to: Date, bucket: 'hour' | 'day' = 'hour', topN = 20): Promise<UsageSummary> => {
  const p = [applicationId, from, to];
  const tot = await db.query('SELECT COALESCE(SUM(specks),0)::text AS specks, COUNT(*)::int AS n FROM usage_records WHERE application_id = $1 AND created_at >= $2 AND created_at < $3', p);
  const st = await db.query(`SELECT status, COUNT(*)::int AS n FROM sponsorship_requests WHERE application_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY status`, p);
  const counts = Object.fromEntries(st.rows.map((r: any) => [r.status, r.n as number]));
  const byContract = await db.query(`SELECT contract AS key, SUM(specks)::text AS specks, COUNT(*)::int AS n FROM usage_records WHERE application_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY contract ORDER BY 2 DESC LIMIT $4`, [...p, topN]);
  const byEp = await db.query(`SELECT contract || ':' || entry_point AS key, SUM(specks)::text AS specks, COUNT(*)::int AS n FROM usage_records WHERE application_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 2 DESC LIMIT $4`, [...p, topN]);
  const byUser = await db.query(`SELECT user_id AS key, SUM(specks)::text AS specks, COUNT(*)::int AS n FROM usage_records WHERE application_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY user_id ORDER BY 2 DESC LIMIT $4`, [...p, topN]);
  const byReason = await db.query(`SELECT COALESCE(reason_code,'?') AS key, COUNT(*)::int AS n FROM sponsorship_requests WHERE application_id = $1 AND created_at >= $2 AND created_at < $3 AND status IN ('REJECTED','SPONSORING_FAILED','SUBMISSION_FAILED','EXPIRED') GROUP BY 1 ORDER BY 2 DESC`, p);
  const series = await db.query(`SELECT date_trunc($4, created_at) AS bucket, SUM(specks)::text AS specks, COUNT(*)::int AS n FROM usage_records WHERE application_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`, [...p, bucket]);
  const sum = (...s: string[]) => s.reduce((a, k) => a + (counts[k] ?? 0), 0);
  return {
    from, to, totalSpecks: big(tot.rows[0].specks), confirmed: counts.CONFIRMED ?? 0,
    rejected: sum('REJECTED'), failed: sum('SPONSORING_FAILED', 'SUBMISSION_FAILED', 'EXPIRED'), pending: sum('RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'TIMEOUT', 'UNKNOWN'),
    byContract: bd(byContract.rows), byEntryPoint: bd(byEp.rows), byUser: bd(byUser.rows),
    byRejectionReason: byReason.rows.map((r: any) => ({ key: r.key, count: Number(r.n) })),
    series: series.rows.map((r: any) => ({ bucket: r.bucket, specks: big(r.specks), count: Number(r.n) })),
  };
};

export interface WalletSnapshot { adapter: string; network: string; dustBalanceSpecks: bigint; dustCapSpecks: bigint | null; nightStars: bigint | null; dustCoins: number; dustCoinsInFlight: number; synced: boolean; healthy: boolean; detail?: unknown; takenAt: Date }
export const insertWalletSnapshot = async (db: Db, s: Omit<WalletSnapshot, 'takenAt'>) => {
  await db.query(`INSERT INTO sponsor_wallet_snapshots (adapter, network, dust_balance_specks, dust_cap_specks, night_stars, dust_coins, dust_coins_in_flight, synced, healthy, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [s.adapter, s.network, s.dustBalanceSpecks.toString(), s.dustCapSpecks?.toString() ?? null, s.nightStars?.toString() ?? null, s.dustCoins, s.dustCoinsInFlight, s.synced, s.healthy, s.detail === undefined ? null : JSON.stringify(s.detail)]);
};
export const latestWalletSnapshot = async (db: Db): Promise<WalletSnapshot | null> => {
  const r = await db.query('SELECT * FROM sponsor_wallet_snapshots ORDER BY id DESC LIMIT 1');
  const x = r.rows[0];
  return x ? { adapter: x.adapter, network: x.network, dustBalanceSpecks: big(x.dust_balance_specks), dustCapSpecks: x.dust_cap_specks == null ? null : big(x.dust_cap_specks), nightStars: x.night_stars == null ? null : big(x.night_stars), dustCoins: x.dust_coins, dustCoinsInFlight: x.dust_coins_in_flight, synced: x.synced, healthy: x.healthy, detail: x.detail, takenAt: x.taken_at } : null;
};
