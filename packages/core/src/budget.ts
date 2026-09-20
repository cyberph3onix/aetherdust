import { mulCeil } from './specks.js';

export type BudgetPeriod = 'hourly' | 'daily';

/** Calendar-aligned UTC period containing `now`. */
export const periodBounds = (period: BudgetPeriod, now: Date): { start: Date; end: Date } => {
  const d = new Date(now);
  if (period === 'hourly') {
    d.setUTCMinutes(0, 0, 0);
    return { start: new Date(d), end: new Date(d.getTime() + 3_600_000) };
  }
  d.setUTCHours(0, 0, 0, 0);
  return { start: new Date(d), end: new Date(d.getTime() + 86_400_000) };
};

/** Amount to reserve for an estimate: estimate × (1 + margin), rounded up. Fees drift with block fullness. */
export const reservationFor = (estimateSpecks: bigint, margin: number): bigint => mulCeil(estimateSpecks, 1 + margin);

/** Whether a reservation fits: reserved + settled + amount ≤ limit. Mirrors the SQL guard in the repository. */
export const fits = (b: { reserved: bigint; settled: bigint; limit: bigint }, amount: bigint): boolean =>
  b.reserved + b.settled + amount <= b.limit;
