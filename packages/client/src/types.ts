/** Public wire types of the AetherDust API (mirrors `apps/api/src/services/dto.ts`). Amounts are decimal DUST strings. */

export type PublicStatus = 'pending' | 'approved' | 'submitted' | 'confirmed' | 'rejected' | 'failed' | 'unknown';
export type InternalStatus =
  | 'RECEIVED' | 'REJECTED' | 'RESERVED' | 'SPONSORING' | 'SUBMITTED' | 'CONFIRMED'
  | 'SPONSORING_FAILED' | 'SUBMISSION_FAILED' | 'EXPIRED' | 'TIMEOUT' | 'UNKNOWN';

/** Machine-readable error codes (PRD §23). */
export type ErrorCode =
  | 'AUTH_FAILED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'RATE_LIMITED' | 'DUPLICATE_REQUEST'
  | 'POLICY_DISABLED' | 'CONTRACT_NOT_ALLOWED' | 'ENTRY_POINT_NOT_ALLOWED'
  | 'GLOBAL_BUDGET_EXCEEDED' | 'USER_LIMIT_EXCEEDED' | 'TRANSACTION_LIMIT_EXCEEDED'
  | 'PREFLIGHT_FAILED' | 'SPONSOR_BALANCE_LOW' | 'SPONSOR_UNAVAILABLE'
  | 'SPONSORING_FAILED' | 'SUBMISSION_FAILED' | 'TIMEOUT' | 'INTERNAL'
  | (string & {});

export interface ApiError { code: ErrorCode; message: string; details?: Record<string, unknown> }

export interface SponsorshipRequest {
  request_id: string;
  id: string;
  status: PublicStatus;
  internal_status: InternalStatus;
  user_id: string;
  contract: string | null;
  entry_point: string | null;
  calls: { contract: string; entry_point: string }[];
  /** Identifier of the sponsored (merged) transaction — what to watch on the indexer. Set once submitted. */
  transaction_id: string | null;
  transaction_hash: string | null;
  user_transaction_hash: string;
  /** The user's own identifiers; they survive the merge, so a DApp may watch `[0]` before sponsorship completes. */
  user_transaction_identifiers: string[];
  estimated_fee_dust: string | null;
  reserved_dust: string;
  sponsored_dust: string | null;
  block_height: number | null;
  error: ApiError | null;
  policy_version: number | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
}

export interface TransactionEnvelope {
  format: 'midnight-ledger-v8';
  encoding: 'hex' | 'base64';
  bytes: string;
}

export const TERMINAL_STATUSES: ReadonlySet<PublicStatus> = new Set(['confirmed', 'rejected', 'failed']);
