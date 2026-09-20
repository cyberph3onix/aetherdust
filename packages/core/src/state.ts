/** Sponsorship request lifecycle (PRD §16 + Phase 0 corrections). */
export const RequestStatus = {
  RECEIVED: 'RECEIVED',
  REJECTED: 'REJECTED',
  RESERVED: 'RESERVED',
  SPONSORING: 'SPONSORING',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  SPONSORING_FAILED: 'SPONSORING_FAILED',
  SUBMISSION_FAILED: 'SUBMISSION_FAILED',
  EXPIRED: 'EXPIRED',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
} as const;
export type RequestStatus = (typeof RequestStatus)[keyof typeof RequestStatus];

const T: Record<RequestStatus, readonly RequestStatus[]> = {
  RECEIVED: ['REJECTED', 'RESERVED'],
  RESERVED: ['SPONSORING', 'EXPIRED', 'SPONSORING_FAILED'],
  SPONSORING: ['SUBMITTED', 'SPONSORING_FAILED', 'EXPIRED', 'RESERVED' /* worker crashed before anything was sent */],
  SUBMITTED: ['CONFIRMED', 'SUBMISSION_FAILED', 'TIMEOUT', 'EXPIRED'],
  TIMEOUT: ['CONFIRMED', 'SUBMISSION_FAILED', 'UNKNOWN', 'EXPIRED'],
  UNKNOWN: ['CONFIRMED', 'SUBMISSION_FAILED', 'EXPIRED'],
  REJECTED: [],
  CONFIRMED: [],
  SPONSORING_FAILED: [],
  SUBMISSION_FAILED: [],
  EXPIRED: [],
};
export const canTransition = (from: RequestStatus, to: RequestStatus): boolean => T[from].includes(to);
export const assertTransition = (from: RequestStatus, to: RequestStatus): void => {
  if (!canTransition(from, to)) throw new Error(`illegal transition ${from} → ${to}`);
};
export const TERMINAL: ReadonlySet<RequestStatus> = new Set(['REJECTED', 'CONFIRMED', 'SPONSORING_FAILED', 'SUBMISSION_FAILED', 'EXPIRED']);
/** States in which a budget reservation is held. */
export const HOLDS_RESERVATION: ReadonlySet<RequestStatus> = new Set(['RESERVED', 'SPONSORING', 'SUBMITTED', 'TIMEOUT', 'UNKNOWN']);
/** Public status names exposed by the API (PRD wording). */
export const publicStatus = (s: RequestStatus): 'pending' | 'approved' | 'submitted' | 'confirmed' | 'rejected' | 'failed' | 'unknown' => {
  switch (s) {
    case 'RECEIVED': return 'pending';
    case 'RESERVED': case 'SPONSORING': return 'approved';
    case 'SUBMITTED': case 'TIMEOUT': return 'submitted';
    case 'CONFIRMED': return 'confirmed';
    case 'REJECTED': return 'rejected';
    case 'SPONSORING_FAILED': case 'SUBMISSION_FAILED': case 'EXPIRED': return 'failed';
    case 'UNKNOWN': return 'unknown';
  }
};
