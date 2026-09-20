import { insertWalletSnapshot } from '@aetherdust/db';
import { claimNext, listByStatus, release, transition, withTx, type SponsorshipRequest } from '@aetherdust/db';
import type { WorkerDeps } from './deps.js';
import { confirmRequest, processClaimed, submitAndConfirm } from './process.js';

/**
 * Single-writer sponsorship worker. One instance per sponsor wallet. Concurrency is bounded by both the configured
 * limit and the adapter's `maxInFlight` (= available DUST coins for the Midnight adapter, Phase 0 V4).
 */
export class Worker {
  #running = false;
  #inFlight = new Set<Promise<unknown>>();
  #timer?: NodeJS.Timeout;
  #snapshotTimer?: NodeJS.Timeout;
  #reconcileTimer?: NodeJS.Timeout;
  constructor(private readonly deps: WorkerDeps) {}

  /** Phase 0 V5: drain anything possibly-submitted BEFORE balancing new work (in-flight coin locks are process-local). */
  async recover(): Promise<{ requeued: number; resumed: number; expired: number }> {
    const { pool, log } = this.deps;
    const stats = { requeued: 0, resumed: 0, expired: 0 };
    // SPONSORING = crashed before anything was persisted/sent → safe to retry from scratch
    for (const r of await listByStatus(pool, ['SPONSORING'])) {
      await withTx(pool, (tx) => transition(tx, r.id, 'SPONSORING', 'RESERVED', { reasonCode: 'RECOVERED', reasonDetail: 'worker restarted mid-sponsoring', details: { previousWorker: r.workerId } }));
      stats.requeued++;
    }
    // SUBMITTED/TIMEOUT/UNKNOWN = bytes persisted; resubmit (idempotent) and wait again, or expire if the TTL is gone
    for (const r of await listByStatus(pool, ['SUBMITTED', 'TIMEOUT', 'UNKNOWN'])) {
      if (r.ttlAt && r.ttlAt.getTime() + this.deps.config.AETHERDUST_CONFIRM_GRACE_S * 1000 < this.deps.now().getTime()) {
        await withTx(pool, async (tx) => { await transition(tx, r.id, r.status, 'EXPIRED', { reasonCode: 'TIMEOUT', reasonDetail: 'TTL and grace period elapsed without confirmation' }); await release(tx, { applicationId: r.applicationId, userId: r.userId, periodStart: r.periodStart! }, r.reservedSpecks); });
        stats.expired++;
        continue;
      }
      stats.resumed++;
      this.#track(submitAndConfirm(this.deps, r, r.actualFeeSpecks ?? r.estimatedFeeSpecks ?? 0n).catch((e) => log.error({ err: e, requestId: r.id }, 'recovery failed')));
    }
    log.info(stats, 'recovery pass complete');
    return stats;
  }

  #track(p: Promise<unknown>) { this.#inFlight.add(p); void p.finally(() => this.#inFlight.delete(p)); }

  /**
   * Reconciler (plan §14): TIMEOUT/UNKNOWN requests hold their reservation until the chain answers. Ask the indexer
   * again by identifier; settle on CONFIRMED, or — once the user TTL + grace period is definitely past — EXPIRE and
   * release. Never resubmits: the persisted bytes were already handed to the node.
   */
  async reconcile(): Promise<{ confirmed: number; expired: number; pending: number }> {
    const { pool, log, adapter } = this.deps;
    const stats = { confirmed: 0, expired: 0, pending: 0 };
    for (const r of await listByStatus(pool, ['TIMEOUT', 'UNKNOWN'])) {
      if (r.submittedIdentifier) {
        const outcome = await adapter.waitForConfirmation(r.submittedIdentifier, 5_000).catch((e) => { log.warn({ err: e, requestId: r.id }, 'reconcile probe failed'); return { status: 'timeout' as const }; });
        if (outcome.status === 'confirmed') {
          await confirmRequest(this.deps, r, r.status, r.actualFeeSpecks ?? r.estimatedFeeSpecks ?? 0n, outcome.blockHeight);
          stats.confirmed++;
          continue;
        }
        if (outcome.status === 'failed') {
          await withTx(pool, async (tx) => { await transition(tx, r.id, r.status, 'SUBMISSION_FAILED', { reasonCode: 'SUBMISSION_FAILED', reasonDetail: outcome.reason }); await release(tx, { applicationId: r.applicationId, userId: r.userId, periodStart: r.periodStart! }, r.reservedSpecks); });
          stats.expired++;
          continue;
        }
      }
      const deadline = (r.ttlAt?.getTime() ?? r.createdAt.getTime() + 3_600_000) + this.deps.config.AETHERDUST_CONFIRM_GRACE_S * 1000;
      if (deadline < this.deps.now().getTime()) {
        await withTx(pool, async (tx) => { await transition(tx, r.id, r.status, 'EXPIRED', { reasonCode: 'TIMEOUT', reasonDetail: 'TTL and grace period elapsed without confirmation' }); await release(tx, { applicationId: r.applicationId, userId: r.userId, periodStart: r.periodStart! }, r.reservedSpecks); });
        stats.expired++;
      } else stats.pending++;
    }
    if (stats.confirmed || stats.expired) log.info(stats, 'reconcile pass');
    return stats;
  }

  /** One scheduling round: claim as many RESERVED requests as the concurrency budget allows. */
  async tick(): Promise<number> {
    const status = await this.deps.adapter.walletStatus();
    // `maxInFlight` = sponsorships the wallet can start *now* (free DUST coins); the worker's own bound is separate
    const capacity = Math.min(this.deps.config.AETHERDUST_WORKER_CONCURRENCY - this.#inFlight.size, status.maxInFlight);
    let claimed = 0;
    for (let i = 0; i < capacity; i++) {
      const r = await withTx(this.deps.pool, (tx) => claimNext(tx, this.deps.config.AETHERDUST_WORKER_ID));
      if (!r) break;
      claimed++;
      this.#track(processClaimed(this.deps, r).catch((e) => this.deps.log.error({ err: e, requestId: r.id }, 'processing failed unexpectedly')));
    }
    return claimed;
  }

  async snapshot(): Promise<void> {
    const w = await this.deps.adapter.walletStatus();
    await insertWalletSnapshot(this.deps.pool, { adapter: w.adapter, network: w.network, dustBalanceSpecks: w.dustBalanceSpecks, dustCapSpecks: w.dustCapSpecks, nightStars: w.nightStars, dustCoins: w.dustCoins, dustCoinsInFlight: w.dustCoinsInFlight, synced: w.synced, healthy: w.healthy, detail: w.detail });
  }

  async start(): Promise<void> {
    this.#running = true;
    await this.recover();
    await this.snapshot().catch((e) => this.deps.log.warn({ err: e }, 'snapshot failed'));
    const loop = async () => {
      if (!this.#running) return;
      try { await this.tick(); } catch (e) { this.deps.log.error({ err: e }, 'tick failed'); }
      this.#timer = setTimeout(loop, this.deps.config.AETHERDUST_WORKER_POLL_MS);
    };
    void loop();
    this.#snapshotTimer = setInterval(() => void this.snapshot().catch(() => {}), this.deps.config.AETHERDUST_WALLET_SNAPSHOT_S * 1000);
    this.#reconcileTimer = setInterval(() => void this.reconcile().catch((e) => this.deps.log.error({ err: e }, 'reconcile failed')), this.deps.config.AETHERDUST_RECONCILE_INTERVAL_S * 1000);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#snapshotTimer) clearInterval(this.#snapshotTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    await Promise.allSettled([...this.#inFlight]);
  }

  /** Test helper: run rounds until nothing is in flight and nothing is claimable. */
  async drain(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const claimed = await this.tick();
      if (claimed === 0 && this.#inFlight.size === 0) {
        const pending = await listByStatus(this.deps.pool, ['RESERVED', 'SPONSORING'], 1);
        if (pending.length === 0) return;
      }
      await Promise.race([...this.#inFlight, new Promise((r) => setTimeout(r, 25))]);
    }
  }
  get inFlight(): number { return this.#inFlight.size; }
}
export type { SponsorshipRequest };
