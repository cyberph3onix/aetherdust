/**
 * Screenshots of the operator dashboard for a release record (plan §22 Phase 5).
 * Signs in with the admin token, walks the pages, and opens the newest request's audit trail.
 *
 *   node scripts/dashboard-shots.mjs [output-dir] [--url http://127.0.0.1:8090] [--api http://127.0.0.1:8080] [--dark]
 *
 * The token comes from AETHERDUST_ADMIN_TOKEN or deploy/.env. Read-only: it signs in and looks.
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const out = process.argv[2]?.startsWith('--') ? 'dashboard-shots' : (process.argv[2] ?? 'dashboard-shots');
const url = arg('url', 'http://127.0.0.1:8090');
const api = arg('api', 'http://127.0.0.1:8080');
const dark = process.argv.includes('--dark');
const token = process.env.AETHERDUST_ADMIN_TOKEN
  ?? readFileSync('deploy/.env', 'utf8').split('\n').find((l) => l.startsWith('AETHERDUST_ADMIN_TOKEN='))?.slice('AETHERDUST_ADMIN_TOKEN='.length);
if (!token) { console.error('no admin token: set AETHERDUST_ADMIN_TOKEN or run from the repo root'); process.exit(1); }

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: dark ? 'dark' : 'light' });
const shot = async (name) => { await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); console.log(`${out}/${name}.png`); };

await page.goto(url);
await page.getByLabel('API base URL').fill(api);
await page.getByLabel('Admin token').fill(token.trim());
await shot('0-sign-in');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('heading', { name: 'Overview' }).waitFor();
await shot('1-overview');

for (const [hash, name] of [['/requests', '2-requests'], ['/usage', '3-usage'], ['/policy', '4-policy'], ['/wallet', '5-wallet']]) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await shot(name);
  if (hash === '/requests') {
    const row = page.locator('tbody tr').first();
    if (await row.count()) {                       // the audit trail of the most recent request
      await row.click();
      await page.getByRole('dialog').waitFor();
      await shot('2b-request-audit-trail');
      await page.getByRole('button', { name: 'Close' }).click();
    }
  }
}
await browser.close();
