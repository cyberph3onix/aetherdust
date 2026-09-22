/**
 * REST client for the AetherDust API. Runs in browsers and Node (fetch only, no Node built-ins).
 *
 *   const ad = createAetherDustClient({ baseUrl, apiKey, userId: 'user-42' });
 *   const r = await ad.sponsor({ requestId: 'dapp:user-42:claim:1', transaction: sealedTx });  // → confirmed request
 */
import { AetherDustError } from './errors.js';
import { isHex, toHex } from './hex.js';
import { TERMINAL_STATUSES, type SponsorshipRequest, type TransactionEnvelope } from './types.js';

export interface AetherDustClientOptions {
  /** e.g. https://sponsor.example.com — no trailing path. */
  baseUrl: string;
  /** `ad_live_…` / `ad_test_…` key issued by the operator. Keep it server-side or accept that it is public to the DApp's users. */
  apiKey: string;
  /** Opaque per-user id for per-user allowances (PRD §22: send a pseudonymous id, not PII). Static or resolved per call. */
  userId: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  /** Long-poll budget per `sponsor()` call before falling back to `GET` polling (server caps it; default 15 s). */
  waitMs?: number;
  /** Total time `sponsor()`/`waitForOutcome()` will wait for a terminal state before throwing CLIENT_TIMEOUT (default 3 min). */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Anything that can be turned into the sealed transaction bytes the API expects. */
export type TransactionInput = Uint8Array | string | { serialize(): Uint8Array } | TransactionEnvelope;

export interface SponsorParams {
  /** Idempotency key — reuse it when retrying the same action (e.g. `${dapp}:${user}:${action}:${nonce}`). */
  requestId: string;
  /** The user's sealed transaction with fees unpaid (`balanceUnsealedTransaction(tx, { payFees: false })`). */
  transaction: TransactionInput;
  /** Overrides the client-level user id for this call. */
  userId?: string;
  /** Optional claims; the API verifies them against the bytes and rejects on mismatch. */
  contract?: string;
  entryPoint?: string;
  /**
   * 'confirmed' (default): resolve once the sponsored transaction is confirmed on-chain (or throw on failure).
   * 'approved': resolve as soon as the request is accepted and queued; watch `user_transaction_identifiers[0]` yourself.
   */
  until?: 'confirmed' | 'approved';
  signal?: AbortSignal;
}

export interface AetherDustClient {
  sponsor(params: SponsorParams): Promise<SponsorshipRequest>;
  getRequest(requestId: string, signal?: AbortSignal): Promise<SponsorshipRequest>;
  /** Poll `GET` until the request is terminal; throws AetherDustError if it ended in rejection/failure. */
  waitForOutcome(requestId: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SponsorshipRequest>;
  usage(params?: { from?: Date; to?: Date; bucket?: 'hour' | 'day' }): Promise<Record<string, unknown>>;
}

export const toEnvelope = (tx: TransactionInput): TransactionEnvelope => {
  if (tx instanceof Uint8Array) return { format: 'midnight-ledger-v8', encoding: 'hex', bytes: toHex(tx) };
  if (typeof tx === 'string') {
    if (!isHex(tx)) throw new AetherDustError('INVALID_REQUEST', 'transaction string must be hex-encoded serialized bytes');
    return { format: 'midnight-ledger-v8', encoding: 'hex', bytes: tx.startsWith('0x') ? tx.slice(2) : tx };
  }
  if ('serialize' in tx && typeof tx.serialize === 'function') return toEnvelope(tx.serialize());
  if ('format' in tx && 'bytes' in tx) return tx;
  throw new AetherDustError('INVALID_REQUEST', 'unsupported transaction input');
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new AetherDustError('CLIENT_TIMEOUT', 'aborted')); }, { once: true });
});

export const createAetherDustClient = (o: AetherDustClientOptions): AetherDustClient => {
  // browsers throw "Illegal invocation" if window.fetch is called detached from window
  const f = o.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  if (!f) throw new Error('no fetch available: pass `fetch` in the options');
  const base = o.baseUrl.replace(/\/+$/, '');
  const waitMs = o.waitMs ?? 15_000;
  const timeoutMs = o.timeoutMs ?? 180_000;
  const pollMs = o.pollIntervalMs ?? 1_000;
  const userId = async (override?: string) => override ?? (typeof o.userId === 'function' ? await o.userId() : o.userId);

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: T }> => {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method, signal,
        headers: { authorization: `Bearer ${o.apiKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw new AetherDustError('CLIENT_TIMEOUT', 'request aborted', { cause: e });
      throw new AetherDustError('NETWORK_ERROR', `AetherDust unreachable: ${(e as Error)?.message ?? e}`, { cause: e });
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.ok) return { status: res.status, body: json as T };
    const ra = res.headers.get('retry-after');
    throw AetherDustError.fromApi(res.status, json, ra ? Number(ra) : undefined);
  };

  const settle = (r: SponsorshipRequest): SponsorshipRequest => {
    if (r.status === 'rejected' || r.status === 'failed') throw AetherDustError.fromFailedRequest(r);
    return r;
  };

  const waitForOutcome: AetherDustClient['waitForOutcome'] = async (requestId, opts = {}) => {
    const deadline = Date.now() + (opts.timeoutMs ?? timeoutMs);
    for (;;) {
      const { body } = await call<SponsorshipRequest>('GET', `/v1/sponsorship/requests/${encodeURIComponent(requestId)}`, undefined, opts.signal);
      if (TERMINAL_STATUSES.has(body.status)) return settle(body);
      if (Date.now() >= deadline) throw new AetherDustError('CLIENT_TIMEOUT', `request ${requestId} still ${body.status} after ${opts.timeoutMs ?? timeoutMs} ms`, { request: body });
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), opts.signal);
    }
  };

  return {
    async sponsor(p) {
      const until = p.until ?? 'confirmed';
      const started = Date.now();
      const payload = {
        request_id: p.requestId, user_id: await userId(p.userId), transaction: toEnvelope(p.transaction),
        ...(p.contract ? { contract: p.contract } : {}), ...(p.entryPoint ? { entry_point: p.entryPoint } : {}),
      };
      const query = until === 'confirmed' && waitMs > 0 ? `?wait=${Math.min(waitMs, timeoutMs)}` : '';
      const { body } = await call<SponsorshipRequest>('POST', `/v1/sponsorship/requests${query}`, payload, p.signal);
      if (until === 'approved') return settle(body);
      if (TERMINAL_STATUSES.has(body.status)) return settle(body);
      return waitForOutcome(p.requestId, { timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)), signal: p.signal });
    },
    async getRequest(requestId, signal) {
      return (await call<SponsorshipRequest>('GET', `/v1/sponsorship/requests/${encodeURIComponent(requestId)}`, undefined, signal)).body;
    },
    waitForOutcome,
    async usage(params = {}) {
      const q = new URLSearchParams();
      if (params.from) q.set('from', params.from.toISOString());
      if (params.to) q.set('to', params.to.toISOString());
      if (params.bucket) q.set('bucket', params.bucket);
      const qs = q.toString();
      return (await call<Record<string, unknown>>('GET', `/v1/usage${qs ? `?${qs}` : ''}`)).body;
    },
  };
};
