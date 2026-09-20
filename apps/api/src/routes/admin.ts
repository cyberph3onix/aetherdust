import { AetherDustError, periodBounds, specksToDust } from '@aetherdust/core';
import {
  createApiKey, createApplication, findById, getActivePolicy, getApplication, getBudget, latestWalletSnapshot, listApiKeys, listApplications,
  listEvents, listPolicyVersions, listRequests, putPolicy, revokeApiKey, setApplicationStatus, usageSummary, countByStatus,
} from '@aetherdust/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { adminAuth } from '../plugins/auth.js';
import { eventDto, requestDto, walletDto, walletSnapshotDto } from '../services/dto.js';

const Any = z.unknown();
const Id = z.object({ id: z.string().uuid() });

export const adminRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const f = app.withTypeProvider<ZodTypeProvider>();
  f.addHook('preHandler', adminAuth(deps));
  const mustApp = async (id: string) => { const a = await getApplication(deps.pool, id); if (!a) throw new AetherDustError('NOT_FOUND', 'unknown application'); return a; };

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
    const s = await usageSummary(deps.pool, req.params.id, from, to, req.query.bucket);
    return JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? specksToDust(v) : v)));
  });

  f.get('/v1/admin/wallet', { schema: { tags: ['admin'], summary: 'Sponsor wallet status (live from the adapter when in-process, else the worker’s last snapshot)', response: { 200: Any } } }, async () => {
    const snap = await latestWalletSnapshot(deps.pool);
    // mock: in-process; midnight: the worker's private RPC — either may be unavailable, the snapshot never is
    const live = await deps.adapter.walletStatus().then(walletDto).catch((e) => { deps.log.warn({ err: e }, 'live wallet status unavailable'); return null; });
    return { live, snapshot: snap ? walletSnapshotDto(snap) : null };
  });
};
