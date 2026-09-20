import {
  AetherDustError, checkFeeLimit, evaluatePolicy, periodBounds, reservationFor, TERMINAL, type ErrorCode, type TxSummary,
} from '@aetherdust/core';
import {
  findById, findByRequestId, findByTxHash, insertReceived, isUniqueViolation, reserve, transition, withTx, type SponsorshipRequest,
} from '@aetherdust/db';
import { envelopeToBytes, SponsorError, type TransactionEnvelope } from '@aetherdust/midnight';
import type { Deps } from '../deps.js';
import type { AppContext } from '../plugins/auth.js';

export interface CreateInput {
  requestId: string; userId: string; contract?: string; entryPoint?: string; transaction: TransactionEnvelope;
}
export type CreateOutcome =
  | { kind: 'created'; request: SponsorshipRequest }
  | { kind: 'replay'; request: SponsorshipRequest }
  | { kind: 'rejected'; request: SponsorshipRequest; code: ErrorCode; message: string; details?: Record<string, unknown> };

/**
 * The request pipeline (IMPLEMENTATION_PLAN §7). Order matters: every rejection happens before any sponsor
 * resource is committed; the budget reservation is the only thing that "spends" and it is atomic.
 */
export const createSponsorshipRequest = async (deps: Deps, app: AppContext, input: CreateInput): Promise<CreateOutcome> => {
  const now = deps.now();
  const { policy } = app;

  // 1. decode + inspect (offline, real ledger code for real bytes). Garbage never reaches the DB.
  if (input.transaction.format === 'mock' && deps.adapter.name !== 'mock')
    throw new AetherDustError('INVALID_REQUEST', 'mock transactions are only accepted when the mock sponsor adapter is configured');
  let bytes: Uint8Array;
  try { bytes = envelopeToBytes(input.transaction); } catch (e) { throw new AetherDustError('INVALID_REQUEST', (e as Error).message); }
  let summary: TxSummary;
  try { summary = deps.adapter.inspect(bytes); } catch (e) {
    if (e instanceof SponsorError) throw new AetherDustError(e.code === 'PREFLIGHT_FAILED' ? 'PREFLIGHT_FAILED' : 'INVALID_REQUEST', e.message, e.detail);
    throw e;
  }

  // 2. idempotency: same request_id → same answer; same bytes under another request_id → conflict
  const existing = await findByRequestId(deps.pool, app.applicationId, input.requestId);
  if (existing) {
    if (existing.txHash !== summary.txHash) throw new AetherDustError('DUPLICATE_REQUEST', 'request_id already used with a different transaction', { request_id: input.requestId });
    return { kind: 'replay', request: existing };
  }
  const byHash = await findByTxHash(deps.pool, summary.txHash);
  if (byHash) {
    // a concurrent retry can race past the request_id lookup and land here once the first attempt committed: still a replay
    if (byHash.applicationId === app.applicationId && byHash.requestId === input.requestId) return { kind: 'replay', request: byHash };
    throw new AetherDustError('DUPLICATE_REQUEST', 'this transaction was already submitted for sponsorship', { request_id: byHash.requestId, id: byHash.id });
  }

  // 3. persist RECEIVED (races on request_id/tx_hash resolve to the idempotent answer)
  let request: SponsorshipRequest;
  try {
    request = await withTx(deps.pool, (tx) => insertReceived(tx, {
      applicationId: app.applicationId, requestId: input.requestId, userId: input.userId,
      claimedContract: input.contract?.toLowerCase(), claimedEntryPoint: input.entryPoint,
      txFormat: summary.format, txHash: summary.txHash, txBytes: Buffer.from(bytes), txSummary: summary,
      policyVersion: app.policyVersion, ttlAt: summary.minIntentTtl, at: now,
    }));
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await findByRequestId(deps.pool, app.applicationId, input.requestId);
      if (again && again.txHash === summary.txHash) return { kind: 'replay', request: again };
      throw new AetherDustError('DUPLICATE_REQUEST', 'this transaction or request_id was already submitted');
    }
    throw e;
  }
  const rejected = async (code: ErrorCode, message: string, details?: Record<string, unknown>): Promise<CreateOutcome> => {
    const r = await withTx(deps.pool, (tx) => transition(tx, request.id, 'RECEIVED', 'REJECTED', { reasonCode: code, reasonDetail: message, details }));
    return { kind: 'rejected', request: r, code, message, details };
  };

  // 4. policy (shape rules R1–R8)
  const decision = evaluatePolicy(policy, { summary, claimedContract: input.contract, claimedEntryPoint: input.entryPoint, now });
  if (!decision.ok) return rejected(decision.code, decision.message, { rule: decision.rule, ...decision.details });

  // 5. fee estimate (mock in-process now; worker RPC once the Midnight adapter lands)
  let feeSpecks: bigint;
  try { feeSpecks = (await deps.adapter.estimateFee(bytes)).feeSpecks; } catch (e) {
    if (e instanceof SponsorError) return rejected(e.code, e.message, e.detail);
    throw e;
  }
  const feeDecision = checkFeeLimit(policy, feeSpecks);
  if (!feeDecision.ok) return rejected(feeDecision.code, feeDecision.message, { rule: feeDecision.rule, ...feeDecision.details });

  // 6. atomic budget reservation + RESERVED transition in ONE transaction
  const amount = reservationFor(feeSpecks, deps.config.AETHERDUST_FEE_MARGIN);
  const { start, end } = periodBounds(policy.limits.period, now);
  const result = await withTx(deps.pool, async (tx) => {
    const r = await reserve(tx, { applicationId: app.applicationId, userId: input.userId, periodStart: start, periodEnd: end, globalLimit: policy.limits.global_budget_dust, userLimit: policy.limits.per_user_budget_dust, amount });
    if (!r.ok) throw Object.assign(new Error('budget'), { budget: r });
    return transition(tx, request.id, 'RECEIVED', 'RESERVED', { patch: { estimatedFeeSpecks: feeSpecks, reservedSpecks: amount, periodStart: start } });
  }).catch((e) => (e?.budget ? (e.budget as { scope: 'global' | 'user'; row: { reserved: bigint; settled: bigint; limit: bigint } | null }) : Promise.reject(e)));
  if ('scope' in result) {
    const code: ErrorCode = result.scope === 'global' ? 'GLOBAL_BUDGET_EXCEEDED' : 'USER_LIMIT_EXCEEDED';
    const row = result.row;
    return rejected(code, result.scope === 'global' ? 'sponsorship budget exceeded for the current period' : 'user sponsorship allowance exceeded for the current period',
      { scope: result.scope, period_start: start.toISOString(), requested_specks: amount.toString(), ...(row ? { reserved_specks: row.reserved.toString(), settled_specks: row.settled.toString(), limit_specks: row.limit.toString() } : {}) });
  }
  return { kind: 'created', request: result };
};

/** Long-poll helper for `?wait=`: returns as soon as the request is confirmed or fails, or when the deadline passes. */
export const waitForOutcome = async (deps: Deps, id: string, waitMs: number, intervalMs = 250): Promise<SponsorshipRequest> => {
  const deadline = Date.now() + waitMs;
  let r = (await findById(deps.pool, id))!;
  while (!TERMINAL.has(r.status) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    r = (await findById(deps.pool, id))!;
  }
  return r;
};
