import { AetherDustError, parseApiKey, verifySecret, type Policy } from '@aetherdust/core';
import { findApiKey, getActivePolicy, touchApiKey } from '@aetherdust/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Deps } from '../deps.js';

export interface AppContext { applicationId: string; apiKeyId: string; keyId: string; policy: Policy; policyVersion: number }

declare module 'fastify' {
  interface FastifyRequest { app?: AppContext }
}

const bearer = (req: FastifyRequest): string | null => {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
};

/** DApp authentication: `Authorization: Bearer ad_<env>_<keyId>_<secret>`. Attaches the app + active policy. */
export const apiKeyAuth = (deps: Deps) => async (req: FastifyRequest, _reply: FastifyReply) => {
  const token = bearer(req);
  const parsed = token ? parseApiKey(token) : null;
  if (!parsed) throw new AetherDustError('AUTH_FAILED', 'missing or malformed API key');
  const key = await findApiKey(deps.pool, parsed.keyId);
  if (!key || key.status !== 'active' || !(await verifySecret(parsed.secret, key.secretHash))) throw new AetherDustError('AUTH_FAILED', 'invalid API key');
  if (key.applicationStatus !== 'active') throw new AetherDustError('FORBIDDEN', 'application is suspended');
  const policy = await getActivePolicy(deps.pool, key.applicationId);
  if (!policy) throw new AetherDustError('POLICY_DISABLED', 'no sponsorship policy configured for this application');
  req.app = { applicationId: key.applicationId, apiKeyId: key.id, keyId: key.keyId, policy: policy.policy, policyVersion: policy.version };
  void touchApiKey(deps.pool, key.id).catch(() => {});
};

/** Operator authentication for /v1/admin/* — a single admin token (MVP). */
export const adminAuth = (deps: Deps) => async (req: FastifyRequest) => {
  const token = bearer(req);
  const expected = Buffer.from(deps.config.AETHERDUST_ADMIN_TOKEN);
  const given = Buffer.from(token ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AetherDustError('AUTH_FAILED', 'invalid admin token');
};
