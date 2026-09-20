/**
 * Worker-private RPC for the api (plan §3 option A, §18): `POST /internal/estimate` and `GET /internal/health`.
 * Bind it to the private network only; every request must carry the shared secret. Nothing here can spend.
 */
import { INTERNAL_SECRET_HEADER, SponsorError, walletStatusToWire } from '@aetherdust/midnight';
import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { WorkerDeps } from './deps.js';

const EstimateBody = z.object({ bytes: z.string().min(1).max(2 * 1024 * 1024) });

export const buildInternalServer = (deps: WorkerDeps): FastifyInstance => {
  const secret = deps.config.AETHERDUST_INTERNAL_SECRET;
  if (!secret) throw new Error('AETHERDUST_INTERNAL_SECRET is required to expose the worker RPC');
  const expected = Buffer.from(secret);
  const app = Fastify({ loggerInstance: deps.log.child({ component: 'internal' }) as any, bodyLimit: 3 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const given = Buffer.from(String(req.headers[INTERNAL_SECRET_HEADER] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply.status(401).send({ error: { code: 'AUTH_FAILED', message: 'bad internal secret' } });
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SponsorError) return reply.status(err.code === 'SPONSOR_UNAVAILABLE' || err.code === 'SPONSOR_BALANCE_LOW' ? 503 : 422)
      .send({ error: { code: err.code, message: err.message, retryable: err.retryable, details: err.detail } });
    deps.log.error({ err }, 'internal rpc failed');
    return reply.status(500).send({ error: { code: 'SPONSOR_UNAVAILABLE', message: 'internal error', retryable: true } });
  });

  app.get('/internal/health', async () => walletStatusToWire(await deps.adapter.walletStatus()));
  app.post('/internal/estimate', async (req) => {
    const body = EstimateBody.safeParse(req.body);
    if (!body.success) throw new SponsorError('estimate', 'INVALID_REQUEST', 'bytes (base64) required', false);
    const bytes = new Uint8Array(Buffer.from(body.data.bytes, 'base64'));
    const { feeSpecks } = await deps.adapter.estimateFee(bytes);
    return { feeSpecks: feeSpecks.toString() };
  });
  return app;
};
