import { AetherDustError, ErrorCodes } from '@aetherdust/core';
import { SponsorError } from '@aetherdust/midnight';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

/** Every error leaves as `{ error: { code, message, details? } }` (PRD §23). Internal errors never leak messages. */
export const registerErrorHandler = (app: FastifyInstance) => {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AetherDustError) return reply.status(err.status).send(err.toJSON());
    if (err instanceof SponsorError) {
      const status = ErrorCodes[err.code];
      return reply.status(status).send({ error: { code: err.code, message: err.message, ...(err.detail ? { details: err.detail } : {}) } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: 'request validation failed', details: { issues: err.validation.map((v: any) => ({ path: v.instancePath, message: v.message })) } } });
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: 'validation failed', details: { issues: err.issues } } });
    const f = err as FastifyError;
    if (f.statusCode === 413) return reply.status(413).send({ error: { code: 'INVALID_REQUEST', message: 'request body too large' } });
    if (f.statusCode && f.statusCode < 500) return reply.status(f.statusCode).send({ error: { code: 'INVALID_REQUEST', message: f.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } }));
};
