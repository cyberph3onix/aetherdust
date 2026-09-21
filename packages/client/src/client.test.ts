import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AetherDustError, createAetherDustClient, createSponsoredMidnightProvider, findAetherDustError, fromHex, toEnvelope, toHex } from './index.js';
import type { SponsorshipRequest } from './types.js';

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'midnight', 'fixtures');
const fixture = (n: number) => new Uint8Array(readFileSync(path.join(FX, `user-sealed-unpaid-${n}.bin`)));

const req = (over: Partial<SponsorshipRequest> = {}): SponsorshipRequest => ({
  request_id: 'r1', id: 'id-1', status: 'approved', internal_status: 'RESERVED', user_id: 'u', contract: 'ab'.repeat(32), entry_point: 'claim',
  calls: [{ contract: 'ab'.repeat(32), entry_point: 'claim' }], transaction_id: null, transaction_hash: null, user_transaction_hash: 'h',
  user_transaction_identifiers: ['00' + 'aa'.repeat(32)], estimated_fee_dust: '0.004', reserved_dust: '0.0044', sponsored_dust: null, block_height: null,
  error: null, policy_version: 1, attempts: 0, created_at: 't', updated_at: 't', submitted_at: null, confirmed_at: null, ...over,
});

/** Scripted fake API: each entry answers one call in order. */
const fakeFetch = (script: { status: number; body?: unknown; headers?: Record<string, string> }[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error(`unexpected call ${init.method} ${url}`);
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
};
const client = (f: typeof fetch, over: Record<string, unknown> = {}) => createAetherDustClient({ baseUrl: 'https://ad.example/', apiKey: 'ad_test_k', userId: 'u', fetch: f, waitMs: 5000, pollIntervalMs: 1, ...over });

describe('hex + envelopes', () => {
  it('round-trips bytes and accepts every TransactionInput form', () => {
    const b = fixture(1);
    expect(fromHex(toHex(b))).toEqual(b);
    expect(toEnvelope(b).bytes).toBe(toHex(b));
    expect(toEnvelope(toHex(b)).bytes).toBe(toHex(b));
    expect(toEnvelope({ serialize: () => b }).bytes).toBe(toHex(b));
    expect(toEnvelope({ format: 'midnight-ledger-v8', encoding: 'base64', bytes: 'AAA=' }).encoding).toBe('base64');
    expect(() => toEnvelope('not hex!')).toThrow(AetherDustError);
  });
});

describe('findAetherDustError', () => {
  it('unwraps midnight-js style wrappers via the cause chain', () => {
    const inner = new AetherDustError('CONTRACT_NOT_ALLOWED', 'no');
    const wrapped = new Error('Unexpected error submitting scoped transaction', { cause: new Error('mid', { cause: inner }) });
    expect(findAetherDustError(wrapped)).toBe(inner);
    expect(findAetherDustError(new Error('plain'))).toBeUndefined();
    expect(findAetherDustError(inner)).toBe(inner);
  });
});

describe('sponsor()', () => {
  it('posts the envelope with auth + user id, long-polls, and returns the confirmed request', async () => {
    const { f, calls } = fakeFetch([{ status: 202, body: req({ status: 'confirmed', internal_status: 'CONFIRMED', transaction_id: '00' + 'bb'.repeat(32), sponsored_dust: '0.004' }) }]);
    const r = await client(f).sponsor({ requestId: 'r1', transaction: fixture(1), contract: 'ab'.repeat(32) });
    expect(r.status).toBe('confirmed');
    expect(calls[0].url).toBe('https://ad.example/v1/sponsorship/requests?wait=5000');
    expect((calls[0].init.headers as any).authorization).toBe('Bearer ad_test_k');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ request_id: 'r1', user_id: 'u', contract: 'ab'.repeat(32), transaction: { format: 'midnight-ledger-v8', encoding: 'hex', bytes: toHex(fixture(1)) } });
  });
  it('falls back to polling GET when the long-poll returns while still pending', async () => {
    const { f, calls } = fakeFetch([
      { status: 202, body: req({ status: 'approved' }) },
      { status: 200, body: req({ status: 'submitted', internal_status: 'SUBMITTED' }) },
      { status: 200, body: req({ status: 'confirmed', internal_status: 'CONFIRMED', transaction_id: 'x' }) },
    ]);
    const r = await client(f).sponsor({ requestId: 'r1', transaction: fixture(1) });
    expect(r.status).toBe('confirmed');
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'GET']);
    expect(calls[1].url).toBe('https://ad.example/v1/sponsorship/requests/r1');
  });
  it("until:'approved' returns right after the 202 with no wait query", async () => {
    const { f, calls } = fakeFetch([{ status: 202, body: req({ status: 'approved' }) }]);
    const r = await client(f).sponsor({ requestId: 'r1', transaction: fixture(1), until: 'approved' });
    expect(r.status).toBe('approved');
    expect(calls[0].url).toBe('https://ad.example/v1/sponsorship/requests');
  });
  it('a policy rejection is a typed, non-retryable error carrying the persisted request', async () => {
    const { f } = fakeFetch([{ status: 403, body: { ...req({ status: 'rejected', internal_status: 'REJECTED' }), error: { code: 'ENTRY_POINT_NOT_ALLOWED', message: 'nope', details: { rule: 'R3' } } } }]);
    const e = await client(f).sponsor({ requestId: 'r1', transaction: fixture(1) }).catch((x) => x);
    expect(e).toBeInstanceOf(AetherDustError);
    expect(e).toMatchObject({ code: 'ENTRY_POINT_NOT_ALLOWED', status: 403, details: { rule: 'R3' }, rejectedByPolicy: true, retryable: false });
    expect(e.request.id).toBe('id-1');
  });
  it('rate limiting carries Retry-After and is retryable; duplicates are conflicts', async () => {
    const { f } = fakeFetch([
      { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } }, headers: { 'retry-after': '7' } },
      { status: 409, body: { error: { code: 'DUPLICATE_REQUEST', message: 'dup' } } },
    ]);
    const c = client(f);
    const rl = await c.sponsor({ requestId: 'r1', transaction: fixture(1) }).catch((x) => x);
    expect(rl).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 7, retryable: true, request: undefined });
    const dup = await c.sponsor({ requestId: 'r2', transaction: fixture(1) }).catch((x) => x);
    expect(dup).toMatchObject({ code: 'DUPLICATE_REQUEST', status: 409 });
  });
  it('a request that fails after approval throws with the failure code; a client-side timeout is CLIENT_TIMEOUT', async () => {
    const { f } = fakeFetch([
      { status: 202, body: req({ status: 'approved' }) },
      { status: 200, body: req({ status: 'failed', internal_status: 'SPONSORING_FAILED', error: { code: 'SPONSORING_FAILED', message: 'proof server down' } }) },
    ]);
    await expect(client(f).sponsor({ requestId: 'r1', transaction: fixture(1) })).rejects.toMatchObject({ code: 'SPONSORING_FAILED', request: { internal_status: 'SPONSORING_FAILED' } });
    const slow = fakeFetch([{ status: 202, body: req({ status: 'approved' }) }, ...Array.from({ length: 200 }, () => ({ status: 200, body: req({ status: 'approved' }) }))]);
    await expect(client(slow.f, { timeoutMs: 20 }).sponsor({ requestId: 'r1', transaction: fixture(1) })).rejects.toMatchObject({ code: 'CLIENT_TIMEOUT', retryable: true });
  });
  it('network failures are NETWORK_ERROR; userId may be resolved lazily', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(client(down).sponsor({ requestId: 'r1', transaction: fixture(1) })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const { f, calls } = fakeFetch([{ status: 202, body: req({ status: 'confirmed' }) }]);
    await client(f, { userId: async () => 'lazy-user' }).sponsor({ requestId: 'r1', transaction: fixture(1) });
    expect(JSON.parse(String(calls[0].init.body)).user_id).toBe('lazy-user');
  });
});

describe('createSponsoredMidnightProvider (connector-backed)', () => {
  const sealed = fixture(2);
  const wallet = {
    calls: [] as unknown[],
    async getShieldedAddresses() { return { shieldedCoinPublicKey: 'cpk', shieldedEncryptionPublicKey: 'epk' }; },
    async balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }) { wallet.calls.push({ tx, options }); return { tx: toHex(sealed) }; },
  };
  it('balances through the wallet with payFees:false and hands back a deserialized sealed transaction', async () => {
    const { f } = fakeFetch([]);
    const p = await createSponsoredMidnightProvider({ client: client(f), wallet });
    expect(p.getCoinPublicKey()).toBe('cpk');
    expect(p.getEncryptionPublicKey()).toBe('epk');
    const unbound = { serialize: () => new Uint8Array([1, 2, 3]) } as any;
    const tx = await p.balanceTx(unbound);
    expect(wallet.calls[0]).toEqual({ tx: '010203', options: { payFees: false } });
    expect(toHex(tx.serialize())).toBe(toHex(sealed)); // byte-stable round trip through the real ledger
    expect(tx.transactionHash()).toMatch(/^[0-9a-f]{64}$/);
  });
  it('submitTx sponsors with an idempotency key derived from the tx hash and returns the identifier to watch', async () => {
    const { f, calls } = fakeFetch([{ status: 202, body: req({ status: 'confirmed', internal_status: 'CONFIRMED', transaction_id: '00' + 'cc'.repeat(32) }) }]);
    const seen: string[] = [];
    const p = await createSponsoredMidnightProvider({ client: client(f), wallet, requestIdPrefix: 'counter', onRequest: (r) => seen.push(r.status) });
    const tx = await p.balanceTx({ serialize: () => new Uint8Array([1]) } as any);
    expect(await p.submitTx(tx)).toBe('00' + 'cc'.repeat(32));
    expect(JSON.parse(String(calls[0].init.body)).request_id).toBe(`counter:${tx.transactionHash()}`);
    expect(seen).toEqual(['confirmed']);
    // 'approved' mode returns the user's own identifier (unchanged by the merge) so midnight-js can watch immediately
    const { f: f2 } = fakeFetch([{ status: 202, body: req({ status: 'approved' }) }]);
    const p2 = await createSponsoredMidnightProvider({ client: client(f2), wallet, until: 'approved' });
    expect(await p2.submitTx(tx)).toBe('00' + 'aa'.repeat(32));
  });
  it('wallet failures and non-transactions become WALLET_ERROR', async () => {
    const { f } = fakeFetch([]);
    const bad = { ...wallet, async balanceUnsealedTransaction() { return { tx: 'deadbeef' }; } };
    const p = await createSponsoredMidnightProvider({ client: client(f), wallet: bad });
    await expect(p.balanceTx({ serialize: () => new Uint8Array([1]) } as any)).rejects.toMatchObject({ code: 'WALLET_ERROR' });
    const refusing = { ...wallet, async balanceUnsealedTransaction(): Promise<{ tx: string }> { throw new Error('user declined'); } };
    const p2 = await createSponsoredMidnightProvider({ client: client(f), wallet: refusing });
    await expect(p2.balanceTx({ serialize: () => new Uint8Array([1]) } as any)).rejects.toMatchObject({ code: 'WALLET_ERROR', message: expect.stringContaining('user declined') });
  });
});
