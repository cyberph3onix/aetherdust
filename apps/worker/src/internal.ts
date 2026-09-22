/**
 * Worker-private HTTP surface (plan §3 option A, §18): `POST /internal/estimate`, `GET /internal/health` — both
 * behind the shared secret — and `GET /metrics` for Prometheus. Bind it to the private network only.
 * Nothing here can spend.
 */
import { METRICS_CONTENT_TYPE } from '@aetherdust/core';
import { INTERNAL_SECRET_HEADER, SponsorError, walletStatusToWire } from '@aetherdust/midnight';
import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WorkerDeps } from './deps.js';

const EstimateBody = z.object({ bytes: z.string().min(1).max(2 * 1024 * 1024) });

const tokenMatches = (header: string | undefined, expected: string): boolean => {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? '');
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
};

/** True when this process needs to listen at all: for the estimate RPC, for metrics, or both. */
export const needsInternalServer = (deps: Pick<WorkerDeps, 'config'>): boolean =>
  deps.config.AETHERDUST_SPONSOR_ADAPTER === 'midnight' || deps.config.AETHERDUST_METRICS_ENABLED;

export const buildInternalServer = (deps: WorkerDeps): FastifyInstance => {
  const secret = deps.config.AETHERDUST_INTERNAL_SECRET;
  // the api only needs the RPC with the real adapter, but it is harmless (and useful in tests) whenever a secret exists
  if (deps.config.AETHERDUST_SPONSOR_ADAPTER === 'midnight' && !secret) throw new Error('AETHERDUST_INTERNAL_SECRET is required to expose the worker RPC');
  const rpc = !!secret;
  const app = Fastify({ loggerInstance: deps.log.child({ component: 'internal' }) as any, bodyLimit: 3 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SponsorError) return reply.status(err.code === 'SPONSOR_UNAVAILABLE' || err.code === 'SPONSOR_BALANCE_LOW' ? 503 : 422)
      .send({ error: { code: err.code, message: err.message, retryable: err.retryable, details: err.detail } });
    deps.log.error({ err }, 'internal rpc failed');
    return reply.status(500).send({ error: { code: 'SPONSOR_UNAVAILABLE', message: 'internal error', retryable: true } });
  });

  if (deps.config.AETHERDUST_METRICS_ENABLED && deps.metrics) {
    // outside the secret-protected scope: Prometheus authenticates with a bearer token (the metrics token or the
    // admin token), or with nothing when AETHERDUST_METRICS_PUBLIC=true. Same rule as the api, one thing to configure.
    app.get('/metrics', async (req, reply) => {
      const ok = deps.config.AETHERDUST_METRICS_PUBLIC
        || tokenMatches(req.headers.authorization, deps.config.AETHERDUST_ADMIN_TOKEN)
        || (!!deps.config.AETHERDUST_METRICS_TOKEN && tokenMatches(req.headers.authorization, deps.config.AETHERDUST_METRICS_TOKEN));
      if (!ok) return reply.status(401).send({ error: { code: 'AUTH_FAILED', message: 'invalid metrics token' } });
      const body = await deps.metrics!.registry.metrics((e) => deps.log.warn({ err: e }, 'metrics collector failed'));
      return reply.header('content-type', METRICS_CONTENT_TYPE).send(body);
    });
  }

  if (rpc) {
    const expected = Buffer.from(secret);
    void app.register(async (scope) => {
      scope.addHook('onRequest', async (req, reply) => {
        const given = Buffer.from(String(req.headers[INTERNAL_SECRET_HEADER] ?? ''));
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.status(401).send({ error: { code: 'AUTH_FAILED', message: 'bad internal secret' } });
      });
      scope.get('/internal/health', async () => walletStatusToWire(await deps.adapter.walletStatus()));
      scope.post('/internal/estimate', async (req) => {
        const body = EstimateBody.safeParse(req.body);
        if (!body.success) throw new SponsorError('estimate', 'INVALID_REQUEST', 'bytes (base64) required', false);
        const bytes = new Uint8Array(Buffer.from(body.data.bytes, 'base64'));
        const { feeSpecks } = await deps.adapter.estimateFee(bytes);
        return { feeSpecks: feeSpecks.toString() };
      });
    });
  }
  return app;
};
