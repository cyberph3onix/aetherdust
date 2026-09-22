import { AetherDustError, checkFeeLimit, evaluatePolicy, parsePolicy, periodBounds, specksToDust } from '@aetherdust/core';
import {
  confirmationLatency, createApiKey, createApplication, findById, getActivePolicy, getApplication, getBudget, globalBudgets, latestWalletSnapshot,
  listApiKeys, listApplications, listActivePolicies, listEvents, listPolicyVersions, listRequests, putPolicy, recentRequests, rejectionReasonsAll, revokeApiKey,
  setApplicationStatus, sponsoredSeriesAll, sponsoredTotals, statusCountsAll, usageSummary, countByStatus,
} from '@aetherdust/db';
import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { adminAuth } from '../plugins/auth.js';
import { eventDto, requestDto, usageDto, walletDto, walletSnapshotDto } from '../services/dto.js';

const Any = z.unknown();
const Id = z.object({ id: z.string().uuid() });

export const adminRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const f = app.withTypeProvider<ZodTypeProvider>();
  f.addHook('preHandler', adminAuth(deps));
  const mustApp = async (id: string) => { const a = await getApplication(deps.pool, id); if (!a) throw new AetherDustError('NOT_FOUND', 'unknown application'); return a; };


  // ---- overview: everything the dashboard's landing page needs, in one call (PRD §19.1) ----
  f.get('/v1/admin/overview', {
    schema: {
      tags: ['admin'], summary: 'Fleet overview: wallet, per-application budgets, recent activity',
      querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24), bucket: z.enum(['hour', 'day']).default('hour'), recent: z.coerce.number().int().min(0).max(100).default(20) }),
      response: { 200: Any },
    },
  }, async (req) => {
    const now = deps.now();
    const from = new Date(now.getTime() - req.query.hours * 3_600_000);
    const [apps, policies, statuses, totals, snapshot, latency, rejections, series, recent] = await Promise.all([
      listApplications(deps.pool), listActivePolicies(deps.pool), statusCountsAll(deps.pool), sponsoredTotals(deps.pool),
      latestWalletSnapshot(deps.pool), confirmationLatency(deps.pool, from), rejectionReasonsAll(deps.pool, from),
      sponsoredSeriesAll(deps.pool, from, now, req.query.bucket), req.query.recent ? recentRequests(deps.pool, req.query.recent) : Promise.resolve([]),
    ]);
    const live = await deps.adapter.walletStatus().then(walletDto).catch((e) => { deps.log.warn({ err: e }, 'live wallet status unavailable'); return null; });

    const policyOf = new Map(policies.map((p) => [p.applicationId, p]));
    const budgets = new Map<string, Awaited<ReturnType<typeof globalBudgets>>[number]>();
    const periods = new Map<string, { start: Date; end: Date }>();
    for (const p of policies) periods.set(p.applicationId, periodBounds(p.policy.limits.period, now));
    for (const start of new Set([...periods.values()].map((x) => x.start.getTime()))) {
      for (const b of await globalBudgets(deps.pool, new Date(start))) {
        if (periods.get(b.applicationId)?.start.getTime() === start) budgets.set(b.applicationId, b);
      }
    }
    const counts = new Map<string, Record<string, number>>();
    for (const s of statuses) counts.set(s.applicationId, { ...(counts.get(s.applicationId) ?? {}), [s.status]: s.count });
    const spend = new Map(totals.map((t) => [t.applicationId, t]));
    const sum = (pick: (c: Record<string, number>) => number) => apps.reduce((a, x) => a + pick(counts.get(x.id) ?? {}), 0);
    const g = (c: Record<string, number>, ...keys: string[]) => keys.reduce((a, k) => a + (c[k] ?? 0), 0);

    return {
      generated_at: now.toISOString(),
      adapter: deps.adapter.name,
      network: deps.adapter.network,
      window: { from: from.toISOString(), to: now.toISOString(), bucket: req.query.bucket },
      wallet: { live, snapshot: snapshot ? walletSnapshotDto(snapshot) : null },
      totals: {
        applications: apps.length,
        sponsored_dust: specksToDust(totals.reduce((a, t) => a + t.specks, 0n)),
        confirmed: sum((c) => g(c, 'CONFIRMED')),
        rejected: sum((c) => g(c, 'REJECTED')),
        failed: sum((c) => g(c, 'SPONSORING_FAILED', 'SUBMISSION_FAILED', 'EXPIRED')),
        pending: sum((c) => g(c, 'RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'TIMEOUT', 'UNKNOWN')),
      },
      confirmation_latency: { count: latency.count, avg_seconds: latency.avgSeconds, p50_seconds: latency.p50Seconds, p95_seconds: latency.p95Seconds, max_seconds: latency.maxSeconds },
      applications: apps.map((a) => {
        const p = policyOf.get(a.id); const b = budgets.get(a.id); const period = periods.get(a.id);
        const limit = p?.policy.limits.global_budget_dust ?? 0n;
        const used = (b?.settled ?? 0n) + (b?.reserved ?? 0n);
        return {
          id: a.id, name: a.name, status: a.status, created_at: a.createdAt.toISOString(),
          policy: p ? { version: p.version, enabled: p.policy.enabled, contracts: Object.keys(p.policy.contracts).length } : null,
          period: period && p ? { kind: p.policy.limits.period, start: period.start.toISOString(), end: period.end.toISOString() } : null,
          budget: p ? {
            limit_dust: specksToDust(limit), settled_dust: specksToDust(b?.settled ?? 0n), reserved_dust: specksToDust(b?.reserved ?? 0n),
            remaining_dust: specksToDust(limit - used > 0n ? limit - used : 0n), users: b?.users ?? 0,
          } : null,
          counts: counts.get(a.id) ?? {},
          sponsored_dust: specksToDust(spend.get(a.id)?.specks ?? 0n),
          confirmed_total: spend.get(a.id)?.count ?? 0,
        };
      }),
      rejections: rejections.map((r) => ({ code: r.code, count: r.count })),
      series: series.map((s) => ({ bucket: s.bucket.toISOString(), sponsored_dust: specksToDust(s.specks), count: s.count })),
      recent_requests: recent.map(requestDto),
    };
  });

  f.post('/v1/admin/applications', { schema: { tags: ['admin'], summary: 'Create an application (a DApp)', body: z.object({ name: z.string().min(1).max(120) }), response: { 201: Any } } },
    async (req, reply) => reply.status(201).send(await createApplication(deps.pool, req.body.name)));
  f.get('/v1/admin/applications', { schema: { tags: ['admin'], response: { 200: z.array(Any) } } }, async () => listApplications(deps.pool));
  f.get('/v1/admin/applications/:id', { schema: { tags: ['admin'], params: Id, response: { 200: Any } } }, async (req) => {
    const a = await mustApp(req.params.id);
    const policy = await getActivePolicy(deps.pool, a.id);
    const { start } = periodBounds(policy?.policy.limits.period ?? 'daily', deps.now());
    const global = await getBudget(deps.pool, a.id, 'global', '*', start);
    return { ...a, policy: policy ? { version: policy.version, document: policy.document } : null, keys: await listApiKeys(deps.pool, a.id), counts: await countByStatus(deps.pool, a.id),
      current_period: policy ? { start: start.toISOString(), limit_dust: specksToDust(policy.policy.limits.global_budget_dust), settled_dust: specksToDust(global?.settled ?? 0n), reserved_dust: specksToDust(global?.reserved ?? 0n) } : null };
  });
  f.patch('/v1/admin/applications/:id', { schema: { tags: ['admin'], params: Id, body: z.object({ status: z.enum(['active', 'suspended']) }), response: { 200: Any } } }, async (req) => {
    await mustApp(req.params.id); await setApplicationStatus(deps.pool, req.params.id, req.body.status); return (await getApplication(deps.pool, req.params.id))!;
  });

  f.post('/v1/admin/applications/:id/api-keys', {
    schema: { tags: ['admin'], summary: 'Create an API key — the token is returned exactly once', params: Id, body: z.object({ env: z.enum(['live', 'test']).default('live'), label: z.string().max(80).optional() }), response: { 201: Any } },
  }, async (req, reply) => { await mustApp(req.params.id); return reply.status(201).send(await createApiKey(deps.pool, req.params.id, req.body.env, req.body.label)); });
  f.delete('/v1/admin/api-keys/:id', { schema: { tags: ['admin'], params: Id, response: { 200: Any } } }, async (req) => {
    if (!(await revokeApiKey(deps.pool, req.params.id))) throw new AetherDustError('NOT_FOUND', 'unknown or already revoked key');
    return { revoked: true };
  });

  f.get('/v1/admin/applications/:id/policy', { schema: { tags: ['admin'], params: Id, response: { 200: Any } } }, async (req) => {
    await mustApp(req.params.id);
    const p = await getActivePolicy(deps.pool, req.params.id);
    return { active: p ? { version: p.version, document: p.document, created_at: p.createdAt } : null, versions: (await listPolicyVersions(deps.pool, req.params.id)).map((v) => ({ version: v.version, created_at: v.createdAt })) };
  });
  f.put('/v1/admin/applications/:id/policy', {
    schema: { tags: ['admin'], summary: 'Replace the policy (creates a new version; takes effect on the next request)', params: Id, body: z.record(z.string(), z.unknown()).describe('Policy document (see PolicySchema); validated server-side'), response: { 200: Any } },
  }, async (req) => { await mustApp(req.params.id); const p = await putPolicy(deps.pool, req.params.id, req.body as any); return { version: p.version, document: p.document }; });


  f.post('/v1/admin/applications/:id/policy/dry-run', {
    schema: {
      tags: ['admin'], summary: 'Evaluate a candidate policy against the last N stored requests (nothing is saved)',
      params: Id, querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      body: z.record(z.string(), z.unknown()).describe('Candidate policy document'), response: { 200: Any, 400: Any },
    },
  }, async (req) => {
    await mustApp(req.params.id);
    let candidate;
    try { candidate = parsePolicy(req.body); } catch (e) {
      if (e instanceof ZodError) throw new AetherDustError('INVALID_REQUEST', 'candidate policy is invalid', { issues: e.issues });
      throw e;
    }
    const now = deps.now();
    const rows = await listRequests(deps.pool, req.params.id, { limit: req.query.limit });
    // the stored summary and fee estimate are replayed as they were: a dry run answers "what would this policy have
    // done to the traffic we have seen", not "what would it do to fresh transactions" (TTLs are checked against
    // the original submission time for that reason).
    const results = rows.map((r) => {
      const at = r.createdAt;
      const decision = evaluatePolicy(candidate, { summary: r.txSummary, claimedContract: r.claimedContract ?? undefined, claimedEntryPoint: r.claimedEntryPoint ?? undefined, now: at });
      const fee = r.actualFeeSpecks ?? r.estimatedFeeSpecks;
      const feeDecision = decision.ok && fee != null ? checkFeeLimit(candidate, fee) : { ok: true as const, rule: 'ALL' as const };
      const verdict = !decision.ok ? decision : feeDecision;
      const wouldAllow = verdict.ok;
      const wasAllowed = r.status !== 'REJECTED';
      return {
        id: r.id, request_id: r.requestId, user_id: r.userId, created_at: at.toISOString(),
        contract: r.txSummary.calls[0]?.address ?? null, entry_point: r.txSummary.calls[0]?.entryPoint ?? null,
        fee_dust: fee == null ? null : specksToDust(fee),
        was: { status: r.status, allowed: wasAllowed, code: r.reasonCode },
        would: { allowed: wouldAllow, code: wouldAllow ? null : (verdict as { code: string }).code, rule: wouldAllow ? null : verdict.rule, message: wouldAllow ? null : (verdict as { message: string }).message },
        changed: wouldAllow !== wasAllowed,
      };
    });
    const changed = results.filter((r) => r.changed);
    return {
      evaluated_at: now.toISOString(), sampled: results.length,
      summary: {
        would_allow: results.filter((r) => r.would.allowed).length,
        would_reject: results.filter((r) => !r.would.allowed).length,
        newly_rejected: changed.filter((r) => !r.would.allowed).length,
        newly_allowed: changed.filter((r) => r.would.allowed).length,
      },
      by_reason: Object.entries(results.filter((r) => !r.would.allowed).reduce<Record<string, number>>((a, r) => ({ ...a, [r.would.code!]: (a[r.would.code!] ?? 0) + 1 }), {})).map(([code, count]) => ({ code, count })),
      requests: results,
    };
  });

  f.get('/v1/admin/applications/:id/requests', {
    schema: { tags: ['admin'], params: Id, querystring: z.object({ status: z.string().optional(), user_id: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(50), before: z.coerce.date().optional() }), response: { 200: z.array(Any) } },
  }, async (req) => (await listRequests(deps.pool, req.params.id, { status: req.query.status as any, userId: req.query.user_id, limit: req.query.limit, before: req.query.before })).map(requestDto));
  f.get('/v1/admin/requests/:id', { schema: { tags: ['admin'], summary: 'Request detail with its full audit trail', params: Id, response: { 200: Any } } }, async (req) => {
    const r = await findById(deps.pool, req.params.id);
    if (!r) throw new AetherDustError('NOT_FOUND', 'unknown request');
    return { ...requestDto(r), events: (await listEvents(deps.pool, r.id)).map(eventDto) };
  });
  f.get('/v1/admin/applications/:id/usage', {
    schema: { tags: ['admin'], params: Id, querystring: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), bucket: z.enum(['hour', 'day']).default('hour') }), response: { 200: Any } },
  }, async (req) => {
    await mustApp(req.params.id);
    const to = req.query.to ?? deps.now(); const from = req.query.from ?? new Date(to.getTime() - 7 * 86_400_000);
    return usageDto(await usageSummary(deps.pool, req.params.id, from, to, req.query.bucket), req.query.bucket);
  });

  f.get('/v1/admin/wallet', { schema: { tags: ['admin'], summary: 'Sponsor wallet status (live from the adapter when in-process, else the worker’s last snapshot)', response: { 200: Any } } }, async () => {
    const snap = await latestWalletSnapshot(deps.pool);
    // mock: in-process; midnight: the worker's private RPC — either may be unavailable, the snapshot never is
    const live = await deps.adapter.walletStatus().then(walletDto).catch((e) => { deps.log.warn({ err: e }, 'live wallet status unavailable'); return null; });
    return { live, snapshot: snap ? walletSnapshotDto(snap) : null };
  });
};
