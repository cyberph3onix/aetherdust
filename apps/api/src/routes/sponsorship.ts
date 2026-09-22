import { AetherDustError, ErrorCodes, periodBounds, specksToDust } from '@aetherdust/core';
import { findByRequestId, getBudget, listUserBudgets, usageSummary } from '@aetherdust/db';
import { TransactionEnvelopeSchema } from '@aetherdust/midnight';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { apiKeyAuth } from '../plugins/auth.js';
import { requestDto, usageDto } from '../services/dto.js';
import { createSponsorshipRequest, waitForOutcome } from '../services/sponsorship.js';

const CreateBody = z.object({
  request_id: z.string().min(1).max(128).describe('Idempotency key chosen by the DApp (e.g. dapp:user:action:nonce)'),
  user_id: z.string().min(1).max(128).describe('Opaque per-user identifier used for per-user limits'),
  contract: z.string().regex(/^[0-9a-f]{64}$/i).optional().describe('Optional claim; verified against the transaction'),
  entry_point: z.string().min(1).max(128).optional().describe('Optional claim; verified against the transaction'),
  transaction: TransactionEnvelopeSchema,
});
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }).loose();
const RequestDto = z.object({}).passthrough();

export const sponsorshipRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const hit = async (req: FastifyRequest, reply: FastifyReply, key: string, limit: number) => {
    const r = await deps.limiter.hit(key, limit, deps.now().getTime());
    reply.header('X-RateLimit-Limit', String(r.limit)).header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      const scope = key.split(':')[0]!;
      deps.metrics?.rateLimited.inc({ scope });
      reply.header('Retry-After', String(r.retryAfterSeconds));
      throw new AetherDustError('RATE_LIMITED', 'rate limit exceeded', { key: scope, retry_after_seconds: r.retryAfterSeconds });
    }
  };

  // auth needs only headers, so it and the credential/ip limits run in onRequest — before the body is parsed (plan §13).
  f.addHook('onRequest', apiKeyAuth(deps));
  // every log line of this request carries the application (PRD §25); request_id/transaction_id are added as they are known
  f.addHook('onRequest', async (req) => { req.log = req.log.child({ application_id: req.app!.applicationId }); });
  f.addHook('onRequest', async (req, reply) => {
    const rl = req.app!.policy.rate_limit;
    // policy limits govern sponsorship submissions; status polling / usage reads get a separate, generous bucket
    if (req.method === 'POST') {
      await hit(req, reply, `cred:${req.app!.apiKeyId}`, rl.requests_per_minute_per_credential);
      await hit(req, reply, `ip:${req.ip}`, rl.requests_per_minute_per_ip);
    } else {
      await hit(req, reply, `read:${req.app!.apiKeyId}`, Math.max(600, rl.requests_per_minute_per_credential * 10));
    }
  });
  // the per-user limit is keyed on the body, so it runs once the (size-capped) body has been validated
  f.addHook('preHandler', async (req, reply) => {
    const body = req.body as { user_id?: string } | undefined;
    if (req.method === 'POST' && body?.user_id) await hit(req, reply, `user:${req.app!.applicationId}:${body.user_id}`, req.app!.policy.rate_limit.requests_per_minute_per_user);
  });

  f.post('/v1/sponsorship/requests', {
    schema: {
      tags: ['sponsorship'], summary: 'Submit a user-signed transaction for DUST sponsorship',
      description: 'The transaction must be sealed by the user’s wallet with fees unpaid (`payFees:false`). Policy, budget and limits are evaluated before any sponsor resource is used. Returns 202 when approved (sponsoring happens asynchronously); use `?wait=<ms>` to long-poll for the outcome.',
      body: CreateBody,
      querystring: z.object({ wait: z.coerce.number().int().min(0).max(120_000).optional().describe('Long-poll up to this many ms for confirmation') }),
      response: { 200: RequestDto, 202: RequestDto, 400: ErrorBody, 401: ErrorBody, 402: ErrorBody, 403: ErrorBody, 409: ErrorBody, 422: ErrorBody, 429: ErrorBody, 503: ErrorBody },
    },
  }, async (req, reply) => {
    const out = await createSponsorshipRequest(deps, req.app!, {
      requestId: req.body.request_id, userId: req.body.user_id, contract: req.body.contract, entryPoint: req.body.entry_point, transaction: req.body.transaction,
    });
    const log = req.log.child({ request_id: out.request.requestId, id: out.request.id, user_id: out.request.userId });
    if (out.kind === 'rejected') {
      deps.metrics?.recordOutcome(req.app!.applicationId, 'rejected', out.code);
      log.info({ outcome: 'rejected', code: out.code, status: out.request.status }, 'sponsorship request rejected');
      return reply.status(ErrorCodes[out.code] as 400).send({ ...requestDto(out.request), error: { code: out.code, message: out.message, ...(out.details ? { details: out.details } : {}) } } as any);
    }
    deps.metrics?.recordOutcome(req.app!.applicationId, out.kind === 'replay' ? 'replay' : 'accepted');
    const waitMs = Math.min(req.query.wait ?? 0, deps.config.AETHERDUST_MAX_WAIT_MS);
    const request = waitMs > 0 ? await waitForOutcome(deps, out.request.id, waitMs) : out.request;
    log.info({ outcome: out.kind, status: request.status, transaction_id: request.submittedIdentifier, estimated_fee_specks: request.estimatedFeeSpecks?.toString() ?? null }, 'sponsorship request admitted');
    return reply.status(out.kind === 'replay' ? 200 : 202).send(requestDto(request) as any);
  });

  f.get('/v1/sponsorship/requests/:request_id', {
    schema: { tags: ['sponsorship'], summary: 'Get the status of a sponsorship request', params: z.object({ request_id: z.string() }), response: { 200: RequestDto, 404: ErrorBody } },
  }, async (req, reply) => {
    const r = await findByRequestId(deps.pool, req.app!.applicationId, req.params.request_id);
    if (!r) throw new AetherDustError('NOT_FOUND', 'unknown request_id');
    return reply.send(requestDto(r) as any);
  });

  f.get('/v1/usage', {
    schema: {
      tags: ['sponsorship'], summary: 'Usage and remaining budget for the authenticated application',
      querystring: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), bucket: z.enum(['hour', 'day']).default('hour') }),
      response: { 200: z.object({}).passthrough() },
    },
  }, async (req, reply) => {
    const now = deps.now();
    const { policy } = req.app!;
    const to = req.query.to ?? now;
    const from = req.query.from ?? new Date(to.getTime() - 7 * 86_400_000);
    const { start, end } = periodBounds(policy.limits.period, now);
    const [summary, global, users] = await Promise.all([
      usageSummary(deps.pool, req.app!.applicationId, from, to, req.query.bucket),
      getBudget(deps.pool, req.app!.applicationId, 'global', '*', start),
      listUserBudgets(deps.pool, req.app!.applicationId, start, 20),
    ]);
    const limit = policy.limits.global_budget_dust;
    const used = (global?.settled ?? 0n) + (global?.reserved ?? 0n);
    return reply.send({
      period: { kind: policy.limits.period, start: start.toISOString(), end: end.toISOString() },
      budget: { limit_dust: specksToDust(limit), settled_dust: specksToDust(global?.settled ?? 0n), reserved_dust: specksToDust(global?.reserved ?? 0n), remaining_dust: specksToDust(limit - used > 0n ? limit - used : 0n) },
      per_user_limit_dust: specksToDust(policy.limits.per_user_budget_dust),
      top_users_this_period: users.map((u) => ({ user_id: u.scopeKey, settled_dust: specksToDust(u.settled), reserved_dust: specksToDust(u.reserved) })),
      ...usageDto(summary, req.query.bucket),
    });
  });
};
