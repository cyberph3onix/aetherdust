/**
 * Operator CLI:  aetherdust <command>
 *   bootstrap --name <app> [--policy policy.json] [--env live|test]   create app + API key + policy in one go
 *   create-app --name <app>
 *   create-key --app <id> [--env live|test] [--label x]
 *   set-policy --app <id> --policy policy.json
 *   list-apps
 *   migrate
 * Reads AETHERDUST_DATABASE_URL. Prints the API key token exactly once.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '@aetherdust/config';
import { createApiKey, createApplication, createPool, listApplications, migrate, putPolicy } from '@aetherdust/db';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, d?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const DEFAULT_POLICY = {
  enabled: true,
  contracts: {},
  limits: { period: 'daily', global_budget_dust: '100', per_user_budget_dust: '1', max_fee_per_tx_dust: '0.1' },
  rate_limit: { requests_per_minute_per_credential: 60, requests_per_minute_per_user: 10, requests_per_minute_per_ip: 120 },
};

const COMMANDS = ['bootstrap', 'create-app', 'create-key', 'set-policy', 'list-apps', 'migrate'];
const main = async () => {
  if (!cmd || !COMMANDS.includes(cmd)) { console.error(`usage: aetherdust ${COMMANDS.join('|')}`); process.exitCode = 1; return; }
  const config = loadConfig({ ...process.env, AETHERDUST_ADMIN_TOKEN: process.env.AETHERDUST_ADMIN_TOKEN ?? 'cli-does-not-need-the-admin-token' });
  const pool = createPool(config.AETHERDUST_DATABASE_URL, 2);
  try {
    await migrate(pool);
    switch (cmd) {
      case 'migrate': console.log('migrations up to date'); break;
      case 'list-apps': console.table((await listApplications(pool)).map((a) => ({ id: a.id, name: a.name, status: a.status, created: a.createdAt.toISOString() }))); break;
      case 'create-app': { const a = await createApplication(pool, opt('name', 'app')!); console.log(JSON.stringify(a, null, 2)); break; }
      case 'create-key': { const k = await createApiKey(pool, opt('app')!, (opt('env', 'live') as 'live' | 'test'), opt('label')); console.log(JSON.stringify({ key_id: k.key.keyId, token: k.token, note: 'store this token now; it is not shown again' }, null, 2)); break; }
      case 'set-policy': { const p = await putPolicy(pool, opt('app')!, JSON.parse(readFileSync(opt('policy')!, 'utf8'))); console.log(`policy version ${p.version} active`); break; }
      case 'bootstrap': {
        const name = opt('name', 'ExampleDApp')!;
        const doc = opt('policy') ? JSON.parse(readFileSync(opt('policy')!, 'utf8')) : DEFAULT_POLICY;
        const app = await createApplication(pool, name);
        const policy = await putPolicy(pool, app.id, doc);
        const key = await createApiKey(pool, app.id, (opt('env', 'live') as 'live' | 'test'), 'bootstrap');
        console.log(JSON.stringify({ application_id: app.id, name, policy_version: policy.version, api_key: key.token, note: 'store the api_key now; it is not shown again' }, null, 2));
        break;
      }
      default: console.error('usage: aetherdust bootstrap|create-app|create-key|set-policy|list-apps|migrate'); process.exitCode = 1;
    }
  } finally { await pool.end(); }
};
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
