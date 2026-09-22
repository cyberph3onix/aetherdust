/**
 * Light load test (plan §22 Phase 5). Fires N sponsorship requests at a running AetherDust with C in flight, then
 * waits for every one of them to reach a terminal state and checks the books: settled DUST must equal the sum of
 * what each confirmed request was charged, and no reservation may be left behind.
 *
 *   node scripts/loadtest.mjs --url http://127.0.0.1:8099 --admin <admin token> [--requests 200] [--concurrency 25]
 *
 * It creates its own application, API key and policy, so it never disturbs an existing one. Point it at a mock
 * sponsor for throughput numbers; against a real chain it is bounded by the sponsor's DUST coins, not by the API.
 */
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg('url', 'http://127.0.0.1:8099').replace(/\/$/, '');
const ADMIN = arg('admin', process.env.AETHERDUST_ADMIN_TOKEN);
const N = Number(arg('requests', '200'));
const C = Number(arg('concurrency', '25'));
const CONTRACT = 'ab'.repeat(32);
if (!ADMIN) { console.error('--admin <token> (or AETHERDUST_ADMIN_TOKEN) is required'); process.exit(1); }

const call = async (method, path, token, body) => {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const admin = (method, path, body) => call(method, path, ADMIN, body);
const pct = (xs, p) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0;

const app = (await admin('POST', '/v1/admin/applications', { name: `loadtest-${Date.now()}` })).body;
const key = (await admin('POST', `/v1/admin/applications/${app.id}/api-keys`, { env: 'test', label: 'loadtest' })).body.token;
await admin('PUT', `/v1/admin/applications/${app.id}/policy`, {
  contracts: { [CONTRACT]: ['increment'] },
  limits: { period: 'daily', global_budget_dust: '1000', per_user_budget_dust: '1000', max_fee_per_tx_dust: '1' },
  // the limiter is not what we are measuring here; it has its own tests
  rate_limit: { requests_per_minute_per_credential: 100000, requests_per_minute_per_user: 100000, requests_per_minute_per_ip: 100000 },
  preflight: { min_ttl_remaining_seconds: 60 },
});

console.log(`load: ${N} requests, ${C} in flight → ${URL_BASE} (application ${app.id})`);
const admitLatency = [];
const statuses = new Map();
let next = 0;
const started = Date.now();
const worker = async () => {
  for (let i = next++; i < N; i = next++) {
    const requestId = `load-${started}-${i}`;
    const t0 = performance.now();
    const r = await call('POST', '/v1/sponsorship/requests', key, {
      request_id: requestId, user_id: `user-${i % 20}`,
      transaction: { format: 'mock', id: requestId, calls: [{ address: CONTRACT, entryPoint: 'increment' }] },
    });
    admitLatency.push(performance.now() - t0);
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  }
};
await Promise.all(Array.from({ length: C }, worker));
const admitMs = Date.now() - started;

// drain: every request must reach a terminal state before the books can be checked
const terminal = new Set(['CONFIRMED', 'REJECTED', 'SPONSORING_FAILED', 'SUBMISSION_FAILED', 'EXPIRED']);
let rows = [];
const deadline = Date.now() + 120_000;
for (;;) {
  rows = (await admin('GET', `/v1/admin/applications/${app.id}/requests?limit=500`)).body;
  if (rows.length >= N && rows.every((r) => terminal.has(r.internal_status))) break;
  if (Date.now() > deadline) { console.error('timed out waiting for requests to settle'); break; }
  await new Promise((r) => setTimeout(r, 250));
}
const totalMs = Date.now() - started;

const confirmed = rows.filter((r) => r.internal_status === 'CONFIRMED');
const sponsored = confirmed.reduce((a, r) => a + BigInt(Math.round(Number(r.sponsored_dust) * 1e15)), 0n);
const usage = (await call('GET', '/v1/usage', key)).body;
const overview = (await admin('GET', '/v1/admin/overview?hours=1&bucket=hour&recent=0')).body;
const mine = overview.applications.find((a) => a.id === app.id);
const e2e = confirmed.map((r) => new Date(r.confirmed_at) - new Date(r.created_at)).filter(Number.isFinite);

console.log(`
admission   ${(N / (admitMs / 1000)).toFixed(1)} req/s over ${(admitMs / 1000).toFixed(1)}s   p50 ${pct(admitLatency, 50).toFixed(0)}ms · p95 ${pct(admitLatency, 95).toFixed(0)}ms · max ${Math.max(...admitLatency).toFixed(0)}ms
statuses    ${[...statuses].map(([s, n]) => `${s}:${n}`).join(' ')}
settled     ${confirmed.length}/${rows.length} confirmed in ${(totalMs / 1000).toFixed(1)}s → ${(confirmed.length / (totalMs / 1000)).toFixed(1)} sponsorships/s
end-to-end  p50 ${pct(e2e, 50)}ms · p95 ${pct(e2e, 95)}ms · max ${Math.max(...e2e, 0)}ms
books       settled=${usage.budget.settled_dust} reserved=${usage.budget.reserved_dust} (dashboard: ${mine?.budget.settled_dust})
`);

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };
if (usage.budget.reserved_dust !== '0') fail(`reservations left behind: ${usage.budget.reserved_dust}`);
if (BigInt(Math.round(Number(usage.budget.settled_dust) * 1e15)) !== sponsored) fail('settled budget does not equal the sum of what confirmed requests were charged');
if (mine && mine.budget.settled_dust !== usage.budget.settled_dust) fail('the dashboard overview disagrees with /v1/usage');
if (usage.totals.confirmed !== confirmed.length) fail('usage confirmed count disagrees with the request list');
if (process.exitCode !== 1) console.log('books balance ✓');
