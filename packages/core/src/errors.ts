/** Machine-readable error codes (PRD §23) + a few operational ones. */
export const ErrorCodes = {
  AUTH_FAILED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  DUPLICATE_REQUEST: 409,
  POLICY_DISABLED: 403,
  CONTRACT_NOT_ALLOWED: 403,
  ENTRY_POINT_NOT_ALLOWED: 403,
  GLOBAL_BUDGET_EXCEEDED: 402,
  USER_LIMIT_EXCEEDED: 402,
  TRANSACTION_LIMIT_EXCEEDED: 402,
  PREFLIGHT_FAILED: 422,
  SPONSOR_BALANCE_LOW: 503,
  SPONSOR_UNAVAILABLE: 503,
  SPONSORING_FAILED: 502,
  SUBMISSION_FAILED: 502,
  TIMEOUT: 504,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ErrorCodes;

export class AetherDustError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AetherDustError';
    this.status = ErrorCodes[code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const isAetherDustError = (e: unknown): e is AetherDustError => e instanceof AetherDustError;
