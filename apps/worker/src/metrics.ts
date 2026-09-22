import { MetricsRegistry, specksToDustNumber } from '@aetherdust/core';
import type { WorkerDeps } from './deps.js';

/**
 * Worker metrics (PRD §25). Everything here is measured where it happens — sponsoring, submitting, confirming —
 * because the durations and the confirmation latency cannot be reconstructed from the database with the same
 * fidelity. Aggregate state (budgets, totals) belongs to the api's registry, which reads Postgres.
 */
const SPONSOR_BUCKETS = [0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120] as const;
const CONFIRM_BUCKETS = [1, 2.5, 5, 10, 15, 20, 30, 45, 60, 120, 180, 300] as const;

export interface WorkerMetrics {
  registry: MetricsRegistry;
  sponsorDuration: ReturnType<MetricsRegistry['histogram']>;
  submitDuration: ReturnType<MetricsRegistry['histogram']>;
  confirmationLatency: ReturnType<MetricsRegistry['histogram']>;
  outcomes: ReturnType<MetricsRegistry['counter']>;
  reconciles: ReturnType<MetricsRegistry['counter']>;
  recovered: ReturnType<MetricsRegistry['counter']>;
  claimed: ReturnType<MetricsRegistry['counter']>;
  dustSettled: ReturnType<MetricsRegistry['counter']>;
  inFlight: ReturnType<MetricsRegistry['gauge']>;
  /** One place that records "a request reached a terminal state", so the counters cannot drift apart. */
  recordOutcome(outcome: 'confirmed' | 'failed' | 'expired' | 'timeout' | 'retried', settledSpecks?: bigint): void;
}

export const createWorkerMetrics = (deps: Pick<WorkerDeps, 'adapter' | 'config' | 'log'>, inFlightOf?: () => number): WorkerMetrics => {
  const r = new MetricsRegistry();
  const info = r.gauge('aetherdust_build_info', 'Build/runtime information (always 1)', ['component', 'version', 'adapter', 'network']);
  const sponsorDuration = r.histogram('aetherdust_worker_sponsor_duration_seconds', 'balance → sign → prove → merge, per request', [], SPONSOR_BUCKETS);
  const submitDuration = r.histogram('aetherdust_worker_submit_duration_seconds', 'Node submission call duration', [], SPONSOR_BUCKETS);
  const confirmationLatency = r.histogram('aetherdust_confirmation_latency_seconds', 'Submit → on-chain confirmation latency', [], CONFIRM_BUCKETS);
  const outcomes = r.counter('aetherdust_worker_outcomes_total', 'Requests leaving the worker by outcome', ['outcome']);
  const reconciles = r.counter('aetherdust_worker_reconcile_total', 'Reconciler decisions', ['outcome']);
  const recovered = r.counter('aetherdust_worker_recovered_total', 'Requests picked up by crash recovery', ['kind']);
  const claimed = r.counter('aetherdust_worker_claimed_total', 'Requests claimed from the queue');
  const dustSettled = r.counter('aetherdust_worker_dust_settled_total', 'DUST actually paid by the sponsor on confirmed transactions');
  const inFlight = r.gauge('aetherdust_worker_in_flight', 'Sponsorships currently being processed');
  const maxInFlight = r.gauge('aetherdust_worker_max_in_flight', 'Sponsorships the wallet could start now (free DUST coins)');
  const walletDust = r.gauge('aetherdust_worker_wallet_dust', 'Sponsor wallet DUST balance (live)');
  const walletSynced = r.gauge('aetherdust_worker_wallet_synced', 'Sponsor wallet is synced (1/0)');
  const walletHealthy = r.gauge('aetherdust_worker_wallet_healthy', 'Sponsor wallet is healthy (1/0)');
  const uptime = r.gauge('aetherdust_worker_uptime_seconds', 'Process uptime');

  info.set(1, { component: 'worker', version: '0.1.0', adapter: deps.adapter.name, network: deps.adapter.network });
  for (const o of ['confirmed', 'failed', 'expired', 'timeout', 'retried']) outcomes.init({ outcome: o });
  claimed.init();
  dustSettled.init();

  r.onCollect(async () => {
    uptime.set(process.uptime());
    if (inFlightOf) inFlight.set(inFlightOf());
    // walletStatus is a cheap read of the adapter's cached view (the worker calls it every tick)
    const w = await deps.adapter.walletStatus();
    maxInFlight.set(w.maxInFlight);
    walletDust.set(specksToDustNumber(w.dustBalanceSpecks));
    walletSynced.set(w.synced ? 1 : 0);
    walletHealthy.set(w.healthy ? 1 : 0);
  });

  return {
    registry: r, sponsorDuration, submitDuration, confirmationLatency, outcomes, reconciles, recovered, claimed, dustSettled, inFlight,
    recordOutcome(outcome, settledSpecks) {
      outcomes.inc({ outcome });
      if (outcome === 'confirmed' && settledSpecks != null) dustSettled.inc({}, specksToDustNumber(settledSpecks));
    },
  };
};
