import { assertTransition, type RequestStatus, type TxSummary } from '@aetherdust/core';
import { big, bigOrNull, jsonb, type Db } from './client.js';

export interface SponsorshipRequest {
  id: string; applicationId: string; requestId: string; userId: string;
  claimedContract: string | null; claimedEntryPoint: string | null;
  txFormat: string; txHash: string; txBytes: Buffer; txSummary: TxSummary;
  policyVersion: number | null; estimatedFeeSpecks: bigint | null; reservedSpecks: bigint; actualFeeSpecks: bigint | null;
  periodStart: Date | null; status: RequestStatus; reasonCode: string | null; reasonDetail: string | null;
  mergedTxBytes: Buffer | null; submittedIdentifier: string | null; submittedTxHash: string | null;
  submittedAt: Date | null; confirmedAt: Date | null; blockHeight: number | null; ttlAt: Date | null;
  workerId: string | null; attempts: number; createdAt: Date; updatedAt: Date;
}
export interface RequestEvent { id: number; requestId: string; fromStatus: string | null; toStatus: string; reasonCode: string | null; details: unknown; createdAt: Date }

const summaryFromJson = (j: any): TxSummary => ({ ...j, dustFeeSpecks: big(j.dustFeeSpecks), minIntentTtl: j.minIntentTtl ? new Date(j.minIntentTtl) : null });
export const row = (r: any): SponsorshipRequest => ({
  id: r.id, applicationId: r.application_id, requestId: r.request_id, userId: r.user_id,
  claimedContract: r.claimed_contract, claimedEntryPoint: r.claimed_entry_point,
  txFormat: r.tx_format, txHash: r.tx_hash, txBytes: r.tx_bytes, txSummary: summaryFromJson(r.tx_summary),
  policyVersion: r.policy_version, estimatedFeeSpecks: bigOrNull(r.estimated_fee_specks), reservedSpecks: big(r.reserved_specks), actualFeeSpecks: bigOrNull(r.actual_fee_specks),
  periodStart: r.period_start, status: r.status, reasonCode: r.reason_code, reasonDetail: r.reason_detail,
  mergedTxBytes: r.merged_tx_bytes, submittedIdentifier: r.submitted_identifier, submittedTxHash: r.submitted_tx_hash,
  submittedAt: r.submitted_at, confirmedAt: r.confirmed_at, blockHeight: r.block_height, ttlAt: r.ttl_at,
  workerId: r.worker_id, attempts: r.attempts, createdAt: r.created_at, updatedAt: r.updated_at,
});
const event = (r: any): RequestEvent => ({ id: Number(r.id), requestId: r.request_id, fromStatus: r.from_status, toStatus: r.to_status, reasonCode: r.reason_code, details: r.details, createdAt: r.created_at });

export interface InsertReceived {
  applicationId: string; requestId: string; userId: string; claimedContract?: string; claimedEntryPoint?: string;
  txFormat: string; txHash: string; txBytes: Buffer; txSummary: TxSummary; policyVersion: number | null; ttlAt: Date | null;
}
/** Inserts a RECEIVED request + its first event. Unique violations propagate (caller maps them to idempotency semantics). */
export const insertReceived = async (tx: Db, a: InsertReceived): Promise<SponsorshipRequest> => {
  const r = await tx.query(
    `INSERT INTO sponsorship_requests (application_id, request_id, user_id, claimed_contract, claimed_entry_point, tx_format, tx_hash, tx_bytes, tx_summary, policy_version, ttl_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'RECEIVED') RETURNING *`,
    [a.applicationId, a.requestId, a.userId, a.claimedContract ?? null, a.claimedEntryPoint ?? null, a.txFormat, a.txHash, a.txBytes, jsonb(a.txSummary), a.policyVersion, a.ttlAt]);
  await tx.query('INSERT INTO request_events (request_id, from_status, to_status) VALUES ($1, NULL, $2)', [r.rows[0].id, 'RECEIVED']);
  return row(r.rows[0]);
};

export interface TransitionArgs {
  reasonCode?: string | null; reasonDetail?: string | null; details?: unknown;
  patch?: Partial<{
    estimatedFeeSpecks: bigint; reservedSpecks: bigint; actualFeeSpecks: bigint; periodStart: Date; mergedTxBytes: Buffer;
    submittedIdentifier: string; submittedTxHash: string; submittedAt: Date; confirmedAt: Date; blockHeight: number; workerId: string | null;
  }>;
}
export class StaleTransitionError extends Error {
  constructor(readonly id: string, readonly from: RequestStatus, readonly to: RequestStatus) { super(`request ${id} is no longer ${from} (wanted → ${to})`); }
}
const PATCH_COLS: Record<string, string> = {
  estimatedFeeSpecks: 'estimated_fee_specks', reservedSpecks: 'reserved_specks', actualFeeSpecks: 'actual_fee_specks', periodStart: 'period_start',
  mergedTxBytes: 'merged_tx_bytes', submittedIdentifier: 'submitted_identifier', submittedTxHash: 'submitted_tx_hash', submittedAt: 'submitted_at',
  confirmedAt: 'confirmed_at', blockHeight: 'block_height', workerId: 'worker_id',
};
/**
 * Moves a request from → to, enforcing the state machine in code AND `WHERE status = from` in SQL (optimistic),
 * and appends the audit event in the same statement batch. Callers run this inside a transaction with any
 * budget adjustment so the two can never disagree.
 */
export const transition = async (tx: Db, id: string, from: RequestStatus, to: RequestStatus, a: TransitionArgs = {}): Promise<SponsorshipRequest> => {
  assertTransition(from, to);
  const sets: string[] = ['status = $3', 'updated_at = now()', 'reason_code = $4', 'reason_detail = $5'];
  const vals: unknown[] = [id, from, to, a.reasonCode ?? null, a.reasonDetail ?? null];
  for (const [k, v] of Object.entries(a.patch ?? {})) {
    if (v === undefined) continue;
    vals.push(typeof v === 'bigint' ? v.toString() : v);
    sets.push(`${PATCH_COLS[k]} = $${vals.length}`);
  }
  const r = await tx.query(`UPDATE sponsorship_requests SET ${sets.join(', ')} WHERE id = $1 AND status = $2 RETURNING *`, vals);
  if ((r.rowCount ?? 0) === 0) throw new StaleTransitionError(id, from, to);
  await tx.query('INSERT INTO request_events (request_id, from_status, to_status, reason_code, details) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [id, from, to, a.reasonCode ?? null, a.details === undefined ? null : jsonb(a.details)]);
  return row(r.rows[0]);
};

/** Audit-only event with no status change (e.g. OVERSPEND on settle). `toStatus` records the status at the time. */
export const insertEvent = async (tx: Db, requestId: string, a: { status: RequestStatus; reasonCode: string; details?: unknown }): Promise<void> => {
  await tx.query('INSERT INTO request_events (request_id, from_status, to_status, reason_code, details) VALUES ($1,$2,$2,$3,$4::jsonb)',
    [requestId, a.status, a.reasonCode, a.details === undefined ? null : jsonb(a.details)]);
};

/** Non-status field update (e.g. the identifier learned after submit). */
export const patchRequest = async (db: Db, id: string, patch: NonNullable<TransitionArgs['patch']>): Promise<void> => {
  const sets: string[] = ['updated_at = now()']; const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; vals.push(typeof v === 'bigint' ? v.toString() : v); sets.push(`${PATCH_COLS[k]} = $${vals.length}`); }
  await db.query(`UPDATE sponsorship_requests SET ${sets.join(', ')} WHERE id = $1`, vals);
};

export const findByRequestId = async (db: Db, applicationId: string, requestId: string): Promise<SponsorshipRequest | null> => {
  const r = await db.query('SELECT * FROM sponsorship_requests WHERE application_id = $1 AND request_id = $2', [applicationId, requestId]);
  return r.rows[0] ? row(r.rows[0]) : null;
};
export const findById = async (db: Db, id: string): Promise<SponsorshipRequest | null> => {
  const r = await db.query('SELECT * FROM sponsorship_requests WHERE id = $1', [id]);
  return r.rows[0] ? row(r.rows[0]) : null;
};
/** The live (non-rejected) request holding these transaction bytes, if any — the replay-protection lookup. */
export const findByTxHash = async (db: Db, txHash: string): Promise<SponsorshipRequest | null> => {
  const r = await db.query("SELECT * FROM sponsorship_requests WHERE tx_hash = $1 AND status <> 'REJECTED' ORDER BY created_at DESC LIMIT 1", [txHash]);
  return r.rows[0] ? row(r.rows[0]) : null;
};

/** Worker: atomically claim the oldest RESERVED request (SKIP LOCKED so many workers can poll safely). */
export const claimNext = async (tx: Db, workerId: string): Promise<SponsorshipRequest | null> => {
  const r = await tx.query(
    `UPDATE sponsorship_requests SET status = 'SPONSORING', worker_id = $1, attempts = attempts + 1, updated_at = now()
     WHERE id = (SELECT id FROM sponsorship_requests WHERE status = 'RESERVED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [workerId]);
  if (!r.rows[0]) return null;
  await tx.query("INSERT INTO request_events (request_id, from_status, to_status, details) VALUES ($1,'RESERVED','SPONSORING',$2::jsonb)", [r.rows[0].id, jsonb({ workerId })]);
  return row(r.rows[0]);
};
export const listByStatus = async (db: Db, statuses: RequestStatus[], limit = 100): Promise<SponsorshipRequest[]> =>
  (await db.query('SELECT * FROM sponsorship_requests WHERE status = ANY($1) ORDER BY created_at LIMIT $2', [statuses, limit])).rows.map(row);

export interface ListFilter { status?: RequestStatus; userId?: string; limit?: number; before?: Date }
export const listRequests = async (db: Db, applicationId: string, f: ListFilter = {}): Promise<SponsorshipRequest[]> => {
  const conds = ['application_id = $1']; const vals: unknown[] = [applicationId];
  if (f.status) { vals.push(f.status); conds.push(`status = $${vals.length}`); }
  if (f.userId) { vals.push(f.userId); conds.push(`user_id = $${vals.length}`); }
  if (f.before) { vals.push(f.before); conds.push(`created_at < $${vals.length}`); }
  vals.push(Math.min(f.limit ?? 50, 500));
  return (await db.query(`SELECT * FROM sponsorship_requests WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${vals.length}`, vals)).rows.map(row);
};
export const listEvents = async (db: Db, requestId: string): Promise<RequestEvent[]> =>
  (await db.query('SELECT * FROM request_events WHERE request_id = $1 ORDER BY id', [requestId])).rows.map(event);
export const countByStatus = async (db: Db, applicationId: string, since?: Date): Promise<Record<string, number>> => {
  const r = await db.query('SELECT status, COUNT(*)::int AS n FROM sponsorship_requests WHERE application_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) GROUP BY status', [applicationId, since ?? null]);
  return Object.fromEntries(r.rows.map((x: any) => [x.status, x.n]));
};
