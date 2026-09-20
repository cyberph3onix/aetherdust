import { z } from 'zod';
import type { ErrorCode } from './errors.js';
import { dustToSpecks } from './specks.js';
import type { TxSummary } from './tx-summary.js';

/** Operator-facing policy document. Amounts are decimal DUST strings at the edge; converted to SPECK for evaluation. */
const dustAmount = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try { return dustToSpecks(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); return z.NEVER; }
});
const contractAddress = z.string().regex(/^[0-9a-f]{64}$/i, 'contract address must be 64 hex chars').transform((s) => s.toLowerCase());

export const PolicySchema = z.object({
  enabled: z.boolean().default(true),
  /** address → allowed entry points (exact, case-sensitive). Empty list = contract allowed for no entry point. */
  contracts: z.record(contractAddress, z.array(z.string().min(1)).default([])).default({}),
  allow_multiple_calls: z.boolean().default(false),
  limits: z.object({
    period: z.enum(['hourly', 'daily']).default('daily'),
    global_budget_dust: dustAmount,
    per_user_budget_dust: dustAmount,
    max_fee_per_tx_dust: dustAmount,
  }),
  rate_limit: z.object({
    requests_per_minute_per_credential: z.number().int().positive().default(60),
    requests_per_minute_per_user: z.number().int().positive().default(10),
    requests_per_minute_per_ip: z.number().int().positive().default(120),
  }).prefault({}),
  preflight: z.object({
    min_ttl_remaining_seconds: z.number().int().nonnegative().default(300),
    max_tx_bytes: z.number().int().positive().default(512 * 1024),
  }).prefault({}),
});
export type PolicyInput = z.input<typeof PolicySchema>;
export type Policy = z.output<typeof PolicySchema>;
export const parsePolicy = (doc: unknown): Policy => PolicySchema.parse(doc);

export interface PolicyContext {
  summary: TxSummary;
  /** DApp-supplied claims (verified against the summary; mismatch rejects). */
  claimedContract?: string;
  claimedEntryPoint?: string;
  now: Date;
}
export type PolicyDecision =
  | { ok: true; rule: 'ALL' }
  | { ok: false; code: ErrorCode; rule: string; message: string; details?: Record<string, unknown> };

const reject = (code: ErrorCode, rule: string, message: string, details?: Record<string, unknown>): PolicyDecision =>
  ({ ok: false, code, rule, message, details });

/**
 * Pure, deterministic, fail-closed evaluation of the transaction-shape rules (R1–R8 in the plan).
 * Budget, per-user and rate limits are enforced by their own modules; fee limit (R9) is checked once a fee is known.
 */
export const evaluatePolicy = (policy: Policy, ctx: PolicyContext): PolicyDecision => {
  const s = ctx.summary;
  if (!policy.enabled) return reject('POLICY_DISABLED', 'R1', 'sponsorship is disabled for this application');
  if (s.deploys > 0 || s.maintenanceUpdates > 0)
    return reject('CONTRACT_NOT_ALLOWED', 'R4', 'contract deploys / maintenance updates are never sponsored', { deploys: s.deploys, maintenanceUpdates: s.maintenanceUpdates });
  if (s.calls.length === 0) return reject('INVALID_REQUEST', 'R2', 'transaction contains no contract calls');
  if (s.hasDustActions) return reject('INVALID_REQUEST', 'R6', 'transaction already carries DUST actions (fee already paid or tampered)');
  if (s.calls.length > 1 && !policy.allow_multiple_calls)
    return reject('INVALID_REQUEST', 'R2b', 'multi-call transactions are not allowed by policy', { calls: s.calls.length });
  for (const c of s.calls) {
    const eps = policy.contracts[c.address.toLowerCase()];
    if (!eps) return reject('CONTRACT_NOT_ALLOWED', 'R2', `contract ${c.address} is not allowlisted`, { address: c.address });
    if (!eps.includes(c.entryPoint))
      return reject('ENTRY_POINT_NOT_ALLOWED', 'R3', `entry point ${c.entryPoint} is not allowlisted for ${c.address}`, { address: c.address, entryPoint: c.entryPoint });
  }
  if (ctx.claimedContract && !s.calls.some((c) => c.address.toLowerCase() === ctx.claimedContract!.toLowerCase()))
    return reject('INVALID_REQUEST', 'R5', 'claimed contract does not match the transaction', { claimed: ctx.claimedContract, actual: s.calls.map((c) => c.address) });
  if (ctx.claimedEntryPoint && !s.calls.some((c) => c.entryPoint === ctx.claimedEntryPoint))
    return reject('INVALID_REQUEST', 'R5', 'claimed entry point does not match the transaction', { claimed: ctx.claimedEntryPoint, actual: s.calls.map((c) => c.entryPoint) });
  if (s.byteLength > policy.preflight.max_tx_bytes)
    return reject('PREFLIGHT_FAILED', 'R7', `transaction is ${s.byteLength} bytes; max ${policy.preflight.max_tx_bytes}`);
  if (s.minIntentTtl) {
    const remaining = (s.minIntentTtl.getTime() - ctx.now.getTime()) / 1000;
    if (remaining < policy.preflight.min_ttl_remaining_seconds)
      return reject('PREFLIGHT_FAILED', 'R8', `transaction TTL expires in ${Math.floor(remaining)}s; need ≥ ${policy.preflight.min_ttl_remaining_seconds}s`, { ttl: s.minIntentTtl.toISOString() });
  }
  return { ok: true, rule: 'ALL' };
};

/** R9 — per-transaction fee cap, evaluated once the fee estimate is known. */
export const checkFeeLimit = (policy: Policy, estimatedFeeSpecks: bigint): PolicyDecision =>
  estimatedFeeSpecks > policy.limits.max_fee_per_tx_dust
    ? reject('TRANSACTION_LIMIT_EXCEEDED', 'R9', 'estimated fee exceeds the per-transaction limit', { estimatedFeeSpecks: estimatedFeeSpecks.toString(), limitSpecks: policy.limits.max_fee_per_tx_dust.toString() })
    : { ok: true, rule: 'ALL' };
