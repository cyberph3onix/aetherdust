import { MetricsRegistry, periodBounds, specksToDustNumber, type ErrorCode } from '@aetherdust/core';
import {
  confirmationLatency, globalBudgets, latestWalletSnapshot, listActivePolicies, listApplications, sponsoredTotals, statusCountsAll,
} from '@aetherdust/db';
import type { FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';

/**
 * API metrics (PRD §25). In-process counters cover the request pipeline; everything that describes system state
 * (budgets, wallet, totals) is read from Postgres at scrape time, so the numbers are the same ones the dashboard
 * shows — and they survive an api restart. The worker exposes its own registry on its private port (sponsor and
 * confirmation timings live there).
 *
 * Label convention: `application` is the application id (stable across renames); `aetherdust_application_info`
 * carries the human-readable name for dashboards to join on. Amounts are in DUST (see `specksToDustNumber`).
 */
export interface ApiMetrics {
  registry: MetricsRegistry;
  httpRequests: ReturnType<MetricsRegistry['counter']>;
  httpDuration: ReturnType<MetricsRegistry['histogram']>;
  rateLimited: ReturnType<MetricsRegistry['counter']>;
  recordOutcome(applicationId: string, outcome: 'accepted' | 'replay' | 'rejected', code?: ErrorCode): void;
}

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

export const createApiMetrics = (deps: Pick<Deps, 'pool' | 'adapter' | 'log' | 'now'>): ApiMetrics => {
  const r = new MetricsRegistry();

  const httpRequests = r.counter('aetherdust_http_requests_total', 'HTTP requests handled by the api', ['method', 'route', 'status']);
  const httpDuration = r.histogram('aetherdust_http_request_duration_seconds', 'HTTP request duration', ['method', 'route'], HTTP_BUCKETS);
  const sponsorship = r.counter('aetherdust_sponsorship_requests_total', 'Sponsorship requests by admission outcome', ['application', 'outcome']);
  const rejections = r.counter('aetherdust_sponsorship_rejections_total', 'Rejected sponsorship requests by error code', ['application', 'code']);
  const rateLimited = r.counter('aetherdust_rate_limited_total', 'Requests refused by a rate limit bucket', ['scope']);

  const info = r.gauge('aetherdust_build_info', 'Build/runtime information (always 1)', ['component', 'version', 'adapter', 'network']);
  const appInfo = r.gauge('aetherdust_application_info', 'Registered applications (always 1)', ['application', 'name', 'status']);
  const byStatus = r.gauge('aetherdust_requests_by_status', 'Sponsorship requests recorded in each status', ['application', 'status']);
  const sponsoredDust = r.gauge('aetherdust_dust_sponsored_total', 'DUST settled on confirmed sponsorships, all time', ['application']);
  const sponsoredCount = r.gauge('aetherdust_sponsorships_confirmed_total', 'Confirmed sponsorships, all time', ['application']);
  const budgetLimit = r.gauge('aetherdust_budget_limit_dust', 'Global budget limit for the current period', ['application']);
  const budgetSettled = r.gauge('aetherdust_budget_settled_dust', 'Settled spend in the current period', ['application']);
  const budgetReserved = r.gauge('aetherdust_budget_reserved_dust', 'Reserved (in-flight) spend in the current period', ['application']);
  const budgetRemaining = r.gauge('aetherdust_budget_remaining_dust', 'Remaining global budget for the current period', ['application']);
  const walletDust = r.gauge('aetherdust_sponsor_wallet_dust', 'Sponsor wallet DUST balance (last snapshot)');
  const walletDustCap = r.gauge('aetherdust_sponsor_wallet_dust_cap', 'Sponsor wallet DUST generation cap (last snapshot)');
  const walletNight = r.gauge('aetherdust_sponsor_wallet_night', 'Sponsor wallet NIGHT balance (last snapshot)');
  const walletCoins = r.gauge('aetherdust_sponsor_wallet_dust_coins', 'Spendable DUST coins (bounds worker concurrency)');
  const walletCoinsInFlight = r.gauge('aetherdust_sponsor_wallet_dust_coins_in_flight', 'DUST coins locked by an in-flight sponsorship');
  const walletSynced = r.gauge('aetherdust_sponsor_wallet_synced', 'Sponsor wallet is synced (1/0)');
  const walletHealthy = r.gauge('aetherdust_sponsor_wallet_healthy', 'Sponsor wallet is healthy (1/0)');
  const walletAge = r.gauge('aetherdust_sponsor_wallet_snapshot_age_seconds', 'Age of the last sponsor wallet snapshot');
  const latencyAvg = r.gauge('aetherdust_confirmation_latency_avg_seconds', 'Mean submit→confirm latency over the last hour');
  const latencyP50 = r.gauge('aetherdust_confirmation_latency_p50_seconds', 'Median submit→confirm latency over the last hour');
  const latencyP95 = r.gauge('aetherdust_confirmation_latency_p95_seconds', 'p95 submit→confirm latency over the last hour');
  const latencyCount = r.gauge('aetherdust_confirmations_last_hour', 'Confirmations in the last hour');

  info.set(1, { component: 'api', version: '0.1.0', adapter: deps.adapter.name, network: deps.adapter.network });

  r.onCollect(async () => {
    const now = deps.now();
    const [apps, policies, statuses, totals, snapshot, latency] = await Promise.all([
      listApplications(deps.pool), listActivePolicies(deps.pool), statusCountsAll(deps.pool), sponsoredTotals(deps.pool),
      latestWalletSnapshot(deps.pool), confirmationLatency(deps.pool, new Date(now.getTime() - 3_600_000)),
    ]);

    for (const g of [appInfo, byStatus, sponsoredDust, sponsoredCount, budgetLimit, budgetSettled, budgetReserved, budgetRemaining]) g.reset();
    for (const a of apps) appInfo.set(1, { application: a.id, name: a.name, status: a.status });
    for (const s of statuses) byStatus.set(s.count, { application: s.applicationId, status: s.status });
    for (const t of totals) {
      sponsoredDust.set(specksToDustNumber(t.specks), { application: t.applicationId });
      sponsoredCount.set(t.count, { application: t.applicationId });
    }

    // budgets are per policy period and applications may use different period kinds, so group the lookups by period
    const starts = new Map<number, Date>();
    const appPeriod = new Map<string, number>();
    for (const p of policies) {
      const { start } = periodBounds(p.policy.limits.period, now);
      starts.set(start.getTime(), start);
      appPeriod.set(p.applicationId, start.getTime());
      // no reservation yet this period → the limit is entirely available; the loop below overwrites what has been used
      budgetLimit.set(specksToDustNumber(p.policy.limits.global_budget_dust), { application: p.applicationId });
      budgetSettled.set(0, { application: p.applicationId });
      budgetReserved.set(0, { application: p.applicationId });
      budgetRemaining.set(specksToDustNumber(p.policy.limits.global_budget_dust), { application: p.applicationId });
    }
    for (const start of starts.values()) {
      for (const b of await globalBudgets(deps.pool, start)) {
        if (appPeriod.get(b.applicationId) !== start.getTime()) continue; // a bucket from another app's period kind
        const remaining = b.limit - b.settled - b.reserved;
        budgetLimit.set(specksToDustNumber(b.limit), { application: b.applicationId });
        budgetSettled.set(specksToDustNumber(b.settled), { application: b.applicationId });
        budgetReserved.set(specksToDustNumber(b.reserved), { application: b.applicationId });
        budgetRemaining.set(specksToDustNumber(remaining > 0n ? remaining : 0n), { application: b.applicationId });
      }
    }

    if (snapshot) {
      walletDust.set(specksToDustNumber(snapshot.dustBalanceSpecks));
      if (snapshot.dustCapSpecks != null) walletDustCap.set(specksToDustNumber(snapshot.dustCapSpecks));
      if (snapshot.nightStars != null) walletNight.set(Number(snapshot.nightStars) / 1e6);
      walletCoins.set(snapshot.dustCoins);
      walletCoinsInFlight.set(snapshot.dustCoinsInFlight);
      walletSynced.set(snapshot.synced ? 1 : 0);
      walletHealthy.set(snapshot.healthy ? 1 : 0);
      walletAge.set(Math.max(0, (now.getTime() - snapshot.takenAt.getTime()) / 1000));
    }
    latencyCount.set(latency.count);
    if (latency.avgSeconds != null) latencyAvg.set(latency.avgSeconds);
    if (latency.p50Seconds != null) latencyP50.set(latency.p50Seconds);
    if (latency.p95Seconds != null) latencyP95.set(latency.p95Seconds);
  });

  return {
    registry: r, httpRequests, httpDuration, rateLimited,
    recordOutcome(applicationId, outcome, code) {
      sponsorship.inc({ application: applicationId, outcome });
      if (outcome === 'rejected' && code) rejections.inc({ application: applicationId, code });
    },
  };
};

/** Records duration/status for every route; `routeOptions.url` keeps the label cardinality bounded (no path params). */
export const registerHttpMetrics = (app: FastifyInstance, m: ApiMetrics): void => {
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    if (route === '/metrics') return; // scraping itself is noise
    const labels = { method: req.method, route };
    m.httpRequests.inc({ ...labels, status: reply.statusCode });
    m.httpDuration.observe(reply.elapsedTime / 1000, labels);
  });
};
