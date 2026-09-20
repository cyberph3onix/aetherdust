import { dustToSpecks, type RequestStatus } from '@aetherdust/core';
import { insertEvent, insertUsage, patchRequest, release, settle, transition, withTx, type SponsorshipRequest } from '@aetherdust/db';
import { SponsorError } from '@aetherdust/midnight';
import type { WorkerDeps } from './deps.js';

const MAX_ATTEMPTS = 5;
const SPONSOR_TTL_MS = 30 * 60 * 1000;

const budgetKey = (r: SponsorshipRequest) => ({ applicationId: r.applicationId, userId: r.userId, periodStart: r.periodStart! });

/** Terminal failure: move to `to`, give the reservation back. One transaction so state and budget can't disagree. */
const failAndRelease = (deps: WorkerDeps, r: SponsorshipRequest, from: RequestStatus, to: RequestStatus, code: string, detail: string, details?: unknown) =>
  withTx(deps.pool, async (tx) => {
    const out = await transition(tx, r.id, from, to, { reasonCode: code, reasonDetail: detail.slice(0, 500), details });
    await release(tx, budgetKey(r), r.reservedSpecks);
    return out;
  });

/**
 * Confirmed: settle actual fee, write the usage record, move to CONFIRMED — atomically. If the chain charged more
 * than was reserved, settle anyway (the DUST is spent) and leave an OVERSPEND audit event (plan §9).
 */
export const confirmRequest = (deps: WorkerDeps, r: SponsorshipRequest, from: RequestStatus, actualFee: bigint, blockHeight: number | null) =>
  withTx(deps.pool, async (tx) => {
    const out = await transition(tx, r.id, from, 'CONFIRMED', { patch: { actualFeeSpecks: actualFee, confirmedAt: deps.now(), blockHeight: blockHeight ?? undefined } });
    await settle(tx, budgetKey(r), r.reservedSpecks, actualFee);
    if (actualFee > r.reservedSpecks) {
      deps.log.warn({ requestId: r.id, reservedSpecks: r.reservedSpecks.toString(), actualFeeSpecks: actualFee.toString() }, 'actual fee exceeded reservation');
      await insertEvent(tx, r.id, { status: 'CONFIRMED', reasonCode: 'OVERSPEND', details: { reservedSpecks: r.reservedSpecks.toString(), estimatedFeeSpecks: r.estimatedFeeSpecks?.toString() ?? null, actualFeeSpecks: actualFee.toString(), overspendSpecks: (actualFee - r.reservedSpecks).toString() } });
    }
    const c = r.txSummary.calls[0];
    await insertUsage(tx, { requestId: r.id, applicationId: r.applicationId, userId: r.userId, contract: c?.address ?? '', entryPoint: c?.entryPoint ?? '', specks: actualFee, periodStart: r.periodStart!, at: deps.now() });
    return out;
  });

/**
 * Drive one claimed request (status SPONSORING) to a terminal or parked state.
 * Order guarantees: merged bytes are persisted (SUBMITTED) BEFORE the network sees them, so a crash can never lose
 * track of a possibly-submitted transaction (Phase 0 V5b).
 */
export const processClaimed = async (deps: WorkerDeps, r: SponsorshipRequest): Promise<SponsorshipRequest> => {
  const log = deps.log.child({ requestId: r.id, request_id: r.requestId, app: r.applicationId, attempt: r.attempts });
  const now = deps.now();
  if (r.ttlAt && r.ttlAt.getTime() - now.getTime() < deps.config.AETHERDUST_MIN_TTL_HEADROOM_MS) {
    log.warn('user transaction TTL too close; expiring');
    return failAndRelease(deps, r, 'SPONSORING', 'EXPIRED', 'TIMEOUT', `user transaction TTL ${r.ttlAt.toISOString()} too close to sponsor safely`);
  }
  // 1. sponsor (balance DUST, sign, prove, merge) — nothing has left the process yet
  let sponsored;
  try {
    sponsored = await deps.adapter.sponsor(new Uint8Array(r.txBytes), { ttlMs: SPONSOR_TTL_MS });
  } catch (e) {
    if (e instanceof SponsorError && e.retryable && r.attempts < MAX_ATTEMPTS) {
      log.warn({ err: e.message, code: e.code }, 'sponsoring failed (retryable); re-queueing');
      return withTx(deps.pool, (tx) => transition(tx, r.id, 'SPONSORING', 'RESERVED', { reasonCode: e.code, reasonDetail: e.message, details: { retryable: true, attempt: r.attempts } }));
    }
    const code = e instanceof SponsorError ? e.code : 'SPONSORING_FAILED';
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'sponsoring failed');
    return failAndRelease(deps, r, 'SPONSORING', 'SPONSORING_FAILED', code, e instanceof Error ? e.message : String(e), e instanceof SponsorError ? e.detail : undefined);
  }
  // 2. persist the merged transaction FIRST, then submit
  let submitted = await withTx(deps.pool, (tx) => transition(tx, r.id, 'SPONSORING', 'SUBMITTED', {
    patch: { mergedTxBytes: Buffer.from(sponsored.mergedBytes), submittedTxHash: sponsored.mergedTxHash, submittedAt: deps.now(), actualFeeSpecks: sponsored.actualFeeSpecks },
    details: { identifiers: sponsored.identifiers, actualFeeSpecks: sponsored.actualFeeSpecks.toString() },
  }));
  return submitAndConfirm(deps, submitted, sponsored.actualFeeSpecks);
};

/** From SUBMITTED (fresh or recovered): submit the persisted bytes (idempotent) and wait for the outcome. */
export const submitAndConfirm = async (deps: WorkerDeps, r: SponsorshipRequest, actualFee: bigint): Promise<SponsorshipRequest> => {
  const log = deps.log.child({ requestId: r.id, request_id: r.requestId });
  let identifier = r.submittedIdentifier;
  if (!identifier) {
    try {
      identifier = (await deps.adapter.submit(new Uint8Array(r.mergedTxBytes!))).identifier;
      await patchRequest(deps.pool, r.id, { submittedIdentifier: identifier });
    } catch (e) {
      if (e instanceof SponsorError && !e.retryable) {
        log.error({ err: e.message, code: e.code, detail: e.detail }, 'node rejected the sponsored transaction');
        return failAndRelease(deps, r, r.status, 'SUBMISSION_FAILED', e.code, e.message, e.detail);
      }
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'submit failed (retryable); parking as TIMEOUT for the reconciler');
      return withTx(deps.pool, (tx) => transition(tx, r.id, r.status, 'TIMEOUT', { reasonCode: 'TIMEOUT', reasonDetail: e instanceof Error ? e.message : String(e) }));
    }
  }
  const outcome = await deps.adapter.waitForConfirmation(identifier, deps.config.AETHERDUST_CONFIRM_TIMEOUT_S * 1000);
  if (outcome.status === 'confirmed') {
    log.info({ blockHeight: outcome.blockHeight, feeSpecks: actualFee.toString() }, 'confirmed');
    return confirmRequest(deps, r, r.status, actualFee, outcome.blockHeight);
  }
  if (outcome.status === 'failed') {
    log.error({ reason: outcome.reason }, 'transaction failed on-chain');
    return failAndRelease(deps, r, r.status, 'SUBMISSION_FAILED', 'SUBMISSION_FAILED', outcome.reason, { code: outcome.code });
  }
  log.warn('confirmation timeout; reservation kept until reconciled');
  return r.status === 'TIMEOUT' ? r : withTx(deps.pool, (tx) => transition(tx, r.id, r.status, 'TIMEOUT', { reasonCode: 'TIMEOUT', reasonDetail: `no confirmation within ${deps.config.AETHERDUST_CONFIRM_TIMEOUT_S}s` }));
};

export const minSponsorDust = (deps: WorkerDeps) => dustToSpecks(deps.config.AETHERDUST_MIN_SPONSOR_DUST);
