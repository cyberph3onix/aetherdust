import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Deps } from './deps.js';
import { registerErrorHandler } from './plugins/errors.js';
import { adminRoutes } from './routes/admin.js';
import { sponsorshipRoutes } from './routes/sponsorship.js';

export const buildServer = async (deps: Deps): Promise<FastifyInstance> => {
  const app = Fastify({
    loggerInstance: deps.log as any,
    bodyLimit: 2 * 1024 * 1024, // 2 MiB: a sealed tx is a few KB; hex doubles it
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? undefined as any,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(cors, { origin: true });
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

  app.get('/healthz', { schema: { tags: ['ops'] } }, async () => {
    await deps.pool.query('SELECT 1');
    return { ok: true, adapter: deps.adapter.name, network: deps.adapter.network };
  });
  app.get('/openapi.json', { schema: { tags: ['ops'] } }, async () => app.swagger());
  await app.register(sponsorshipRoutes(deps));
  await app.register(adminRoutes(deps));
  return app;
};
