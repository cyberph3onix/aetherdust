import type { ApiError, ErrorCode, SponsorshipRequest } from './types.js';

/**
 * Every failure the SDK surfaces. `code` is the API's machine-readable code (or a client-side one below), `request`
 * is the persisted sponsorship request when the API created one before rejecting/failing (policy and budget
 * rejections are persisted and auditable; auth/rate-limit/duplicate ones are not).
 */
export class AetherDustError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'CLIENT_TIMEOUT' | 'WALLET_ERROR';
  readonly status: number | null;
  readonly details?: Record<string, unknown>;
  readonly request?: SponsorshipRequest;
  /** Seconds to wait before retrying (from `Retry-After` on RATE_LIMITED). */
  readonly retryAfterSeconds?: number;
  constructor(code: AetherDustError['code'], message: string, o: { status?: number | null; details?: Record<string, unknown>; request?: SponsorshipRequest; retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
    this.name = 'AetherDustError';
    this.code = code;
    this.status = o.status ?? null;
    this.details = o.details;
    this.request = o.request;
    this.retryAfterSeconds = o.retryAfterSeconds;
  }
  /** True when a later retry of the same request may succeed (transient conditions, not policy). */
  get retryable(): boolean {
    return ['RATE_LIMITED', 'SPONSOR_UNAVAILABLE', 'SPONSOR_BALANCE_LOW', 'TIMEOUT', 'NETWORK_ERROR', 'CLIENT_TIMEOUT', 'INTERNAL'].includes(this.code);
  }
  /** True when the request was rejected by policy/budget — the DApp should not retry with the same policy in place. */
  get rejectedByPolicy(): boolean {
    return ['POLICY_DISABLED', 'CONTRACT_NOT_ALLOWED', 'ENTRY_POINT_NOT_ALLOWED', 'GLOBAL_BUDGET_EXCEEDED', 'USER_LIMIT_EXCEEDED', 'TRANSACTION_LIMIT_EXCEEDED', 'PREFLIGHT_FAILED'].includes(this.code);
  }
  static fromApi(status: number, body: unknown, retryAfterSeconds?: number): AetherDustError {
    const b = (body ?? {}) as { error?: ApiError } & Partial<SponsorshipRequest>;
    const err = b.error ?? { code: 'INTERNAL', message: `HTTP ${status}` };
    const request = typeof b.id === 'string' && typeof b.request_id === 'string' ? (b as SponsorshipRequest) : undefined;
    return new AetherDustError(err.code, err.message, { status, details: err.details, request, retryAfterSeconds });
  }
  /** A request that ended in a failure state after being approved (sponsoring/submission failed, expired). */
  static fromFailedRequest(r: SponsorshipRequest): AetherDustError {
    const code = r.error?.code ?? (r.status === 'rejected' ? 'INVALID_REQUEST' : r.internal_status);
    return new AetherDustError(code, r.error?.message ?? `sponsorship ended in ${r.internal_status}`, { status: null, details: r.error?.details, request: r });
  }
}

export const isAetherDustError = (e: unknown): e is AetherDustError => e instanceof AetherDustError;

/**
 * midnight-js wraps errors thrown by `submitTx` ("Unexpected error submitting scoped transaction …", with `cause`).
 * Walk the cause chain to get the typed AetherDust error back, or `undefined` if none is there.
 */
export const findAetherDustError = (e: unknown, depth = 8): AetherDustError | undefined => {
  let cur: unknown = e;
  for (let i = 0; i <= depth && cur != null; i++) {
    if (cur instanceof AetherDustError) return cur;
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined;
  }
  return undefined;
};
