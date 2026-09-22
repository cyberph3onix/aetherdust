import { METRICS_CONTENT_TYPE } from '@aetherdust/core';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { timingSafeEqual } from 'node:crypto';
import type { Deps } from './deps.js';
import { createApiMetrics, registerHttpMetrics } from './metrics.js';
import { registerErrorHandler } from './plugins/errors.js';
import { adminRoutes } from './routes/admin.js';
import { sponsorshipRoutes } from './routes/sponsorship.js';

const bearerMatches = (header: string | undefined, expected: string): boolean => {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '');
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
};

export const buildServer = async (deps: Deps): Promise<FastifyInstance> => {
  const metrics = deps.metrics ?? createApiMetrics(deps);
  const d: Deps = { ...deps, metrics };
  const app = Fastify({
    loggerInstance: deps.log as any,
    bodyLimit: 2 * 1024 * 1024, // 2 MiB: a sealed tx is a few KB; hex doubles it
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? undefined as any,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  const origins = deps.config.AETHERDUST_DASHBOARD_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, { origin: origins?.length ? origins : true });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'AetherDust API', version: '0.1.0', description: 'DUST sponsorship control plane for Midnight DApps. Authenticate with `Authorization: Bearer <api key>`; admin routes use the operator token.' },
      components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
      security: [{ apiKey: [] }],
      tags: [{ name: 'sponsorship' }, { name: 'admin' }, { name: 'ops' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  if (deps.config.AETHERDUST_METRICS_ENABLED) registerHttpMetrics(app, metrics);

  app.get('/healthz', { schema: { tags: ['ops'] } }, async () => {
    await deps.pool.query('SELECT 1');
    return { ok: true, adapter: deps.adapter.name, network: deps.adapter.network };
  });
  app.get('/openapi.json', { schema: { tags: ['ops'] } }, async () => app.swagger());

  // Prometheus exposition (PRD §25). This process is the public one, so /metrics needs a bearer token by default —
  // the exposition names applications, their budgets and the sponsor balance. AETHERDUST_METRICS_TOKEN is the scoped
  // alternative to the admin token; AETHERDUST_METRICS_PUBLIC=true opens it for a private network.
  if (deps.config.AETHERDUST_METRICS_ENABLED) {
    app.get('/metrics', { schema: { tags: ['ops'], summary: 'Prometheus metrics', hide: true } }, async (req, reply) => {
      const ok = deps.config.AETHERDUST_METRICS_PUBLIC
        || bearerMatches(req.headers.authorization, deps.config.AETHERDUST_ADMIN_TOKEN)
        || (!!deps.config.AETHERDUST_METRICS_TOKEN && bearerMatches(req.headers.authorization, deps.config.AETHERDUST_METRICS_TOKEN));
      if (!ok) return reply.status(401).send({ error: { code: 'AUTH_FAILED', message: 'invalid metrics token' } });
      const body = await metrics.registry.metrics((e) => deps.log.warn({ err: e }, 'metrics collector failed'));
      return reply.header('content-type', METRICS_CONTENT_TYPE).send(body);
    });
  }

  await app.register(sponsorshipRoutes(d));
  await app.register(adminRoutes(d));
  return app;
};
