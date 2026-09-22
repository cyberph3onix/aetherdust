import { publicStatus, specksToDust } from '@aetherdust/core';
import type { RequestEvent, SponsorshipRequest, UsageSummary, WalletSnapshot } from '@aetherdust/db';
import type { WalletStatus } from '@aetherdust/midnight';

/** Public representation of a sponsorship request (PRD §18). */
export const requestDto = (r: SponsorshipRequest) => ({
  request_id: r.requestId,
  id: r.id,
  status: publicStatus(r.status),
  internal_status: r.status,
  user_id: r.userId,
  contract: r.txSummary.calls[0]?.address ?? null,
  entry_point: r.txSummary.calls[0]?.entryPoint ?? null,
  calls: r.txSummary.calls.map((c) => ({ contract: c.address, entry_point: c.entryPoint })),
  transaction_id: r.submittedIdentifier,
  transaction_hash: r.submittedTxHash,
  user_transaction_hash: r.txHash,
  user_transaction_identifiers: r.txSummary.identifiers,
  estimated_fee_dust: r.estimatedFeeSpecks == null ? null : specksToDust(r.estimatedFeeSpecks),
  reserved_dust: specksToDust(r.reservedSpecks),
  sponsored_dust: r.actualFeeSpecks == null ? null : specksToDust(r.actualFeeSpecks),
  block_height: r.blockHeight,
  error: r.reasonCode ? { code: r.reasonCode, message: r.reasonDetail ?? r.reasonCode } : null,
  policy_version: r.policyVersion,
  attempts: r.attempts,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
  submitted_at: r.submittedAt?.toISOString() ?? null,
  confirmed_at: r.confirmedAt?.toISOString() ?? null,
});
export const eventDto = (e: RequestEvent) => ({ id: e.id, from: e.fromStatus, to: e.toStatus, reason_code: e.reasonCode, details: e.details, at: e.createdAt.toISOString() });

export const walletDto = (w: WalletStatus) => ({
  adapter: w.adapter, network: w.network, synced: w.synced, healthy: w.healthy,
  dust_balance_dust: specksToDust(w.dustBalanceSpecks), dust_cap_dust: w.dustCapSpecks == null ? null : specksToDust(w.dustCapSpecks),
  night: w.nightStars == null ? null : (Number(w.nightStars) / 1_000_000).toString(),
  dust_coins: w.dustCoins, dust_coins_in_flight: w.dustCoinsInFlight, max_in_flight: w.maxInFlight, detail: w.detail ?? null,
});
export const walletSnapshotDto = (s: WalletSnapshot) => ({
  adapter: s.adapter, network: s.network, synced: s.synced, healthy: s.healthy,
  dust_balance_dust: specksToDust(s.dustBalanceSpecks), dust_cap_dust: s.dustCapSpecks == null ? null : specksToDust(s.dustCapSpecks),
  night: s.nightStars == null ? null : (Number(s.nightStars) / 1_000_000).toString(),
  dust_coins: s.dustCoins, dust_coins_in_flight: s.dustCoinsInFlight, detail: s.detail ?? null, taken_at: s.takenAt.toISOString(),
});

/**
 * Usage in the wire shape both the DApp (`/v1/usage`) and the dashboard (`/v1/admin/.../usage`) read: snake_case,
 * amounts as decimal DUST strings. One function so the two endpoints can never disagree (AC11).
 */
export const usageDto = (s: UsageSummary, bucket: 'hour' | 'day') => ({
  window: { from: s.from.toISOString(), to: s.to.toISOString(), bucket },
  totals: { sponsored_dust: specksToDust(s.totalSpecks), confirmed: s.confirmed, rejected: s.rejected, failed: s.failed, pending: s.pending },
  by_contract: s.byContract.map((b) => ({ contract: b.key, sponsored_dust: specksToDust(b.specks), count: b.count })),
  by_entry_point: s.byEntryPoint.map((b) => ({ key: b.key, sponsored_dust: specksToDust(b.specks), count: b.count })),
  by_user: s.byUser.map((b) => ({ user_id: b.key, sponsored_dust: specksToDust(b.specks), count: b.count })),
  rejections: s.byRejectionReason.map((b) => ({ code: b.key, count: b.count })),
  series: s.series.map((x) => ({ bucket: x.bucket.toISOString(), sponsored_dust: specksToDust(x.specks), count: x.count })),
});
