import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 4 smoke test: the built dashboard, against a real api with seeded traffic (see `stack.ts`).
 * It checks the operator's path — sign in, read the overview, open a request's audit trail, dry-run a policy —
 * and that AC11 holds end to end: the DUST the dashboard shows is the DUST the API reports.
 */
const ADMIN_TOKEN = 'smoke-admin-token-0123456789';
const API = 'http://127.0.0.1:8099';

const signIn = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
};

test('sign-in is required and a bad token is refused', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Admin token').fill('not-the-admin-token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('AUTH_FAILED')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);
});

test('overview shows the seeded traffic, and its totals match the API (AC11)', async ({ page, request }) => {
  await signIn(page);

  const overview = await (await request.get(`${API}/v1/admin/overview?hours=24&bucket=hour`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  expect(overview.totals.confirmed).toBeGreaterThanOrEqual(3);
  expect(overview.totals.rejected).toBe(1);
  expect(overview.series.length).toBeGreaterThan(3);

  // the same numbers on screen
  await expect(page.getByText('DUST sponsored (all time)')).toBeVisible();
  const sponsored = Number(overview.totals.sponsored_dust);
  await expect(page.locator('.stat .value').first()).toHaveText(new RegExp(String(sponsored).replace('.', '\\.')));
  await expect(page.getByRole('cell', { name: 'CounterDApp' })).toBeVisible();
  await expect(page.getByText('CONTRACT_NOT_ALLOWED')).toBeVisible();
  // the chart actually drew its series
  await expect(page.locator('.recharts-area path').first()).toBeVisible();
  await expect(page.getByText('Nothing sponsored in this window yet.')).toHaveCount(0);
});

test('requests page lists sponsorships and opens the audit trail', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Requests' }).click();
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /smoke-0/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /smoke-rejected/ })).toBeVisible();

  await page.getByRole('cell', { name: /smoke-0/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Audit trail')).toBeVisible();
  for (const state of ['RECEIVED', 'RESERVED', 'SPONSORING', 'SUBMITTED', 'CONFIRMED']) {
    await expect(drawer.getByText(state, { exact: false }).first()).toBeVisible();
  }
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // filtering by status narrows the table to exactly the rejected request
  await page.getByLabel('Status').selectOption('REJECTED');
  await expect(page.getByRole('row')).toHaveCount(2); // header + the one rejection
  await expect(page.getByRole('cell', { name: /smoke-rejected/ })).toBeVisible();
});

test('usage page breaks the spend down by contract, entry point and user', async ({ page, request }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();

  const apps = await (await request.get(`${API}/v1/admin/applications`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  const usage = await (await request.get(`${API}/v1/admin/applications/${apps[0].id}/usage?bucket=day`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  expect(usage.by_user.length).toBeGreaterThanOrEqual(3);
  expect(usage.by_contract[0]!.contract).toBe('ab'.repeat(32));

  await expect(page.getByText('By entry point')).toBeVisible();
  await expect(page.getByText('By user')).toBeVisible();
  // the table view backs the charts (the accessibility fallback)
  await expect(page.getByRole('cell', { name: `${'ab'.repeat(32)}:increment` })).toBeVisible();
  for (const user of ['alice', 'bob', 'carol']) await expect(page.getByTitle(new RegExp(user)).or(page.getByText(user)).first()).toBeVisible();
});

test('policy editor dry-runs a candidate against recent traffic without saving it', async ({ page, request }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Policy' }).click();
  const editor = page.getByLabel('Policy document (JSON)');
  await expect(editor).toBeVisible();

  const current = JSON.parse(await editor.inputValue());
  const tightened = { ...current, contracts: { [Object.keys(current.contracts)[0]!]: ['somethingElse'] } };
  await editor.fill(JSON.stringify(tightened, null, 2));
  await page.getByRole('button', { name: 'Dry run' }).click();

  await expect(page.getByText('Would reject')).toBeVisible();
  await expect(page.getByText('newly rejected')).toBeVisible();
  await expect(page.getByText('ENTRY_POINT_NOT_ALLOWED').first()).toBeVisible();
  await expect(page.getByText('Requests whose outcome changes')).toBeVisible();

  // nothing was saved: the API still serves version 1
  const apps = await (await request.get(`${API}/v1/admin/applications`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  const policy = await (await request.get(`${API}/v1/admin/applications/${apps[0].id}/policy`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  expect(policy.active.version).toBe(1);
});

test('wallet page reports the sponsor wallet', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Sponsor wallet' })).toBeVisible();
  await expect(page.getByText('DUST balance')).toBeVisible();
  await expect(page.getByText('Spendable DUST coins')).toBeVisible();
  await expect(page.getByText('healthy', { exact: true })).toBeVisible();
});

test('applications page creates a key and shows its token once', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Applications' }).click();
  await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
  await page.getByLabel('Label').fill('from-smoke-test');
  await page.getByRole('button', { name: 'Create API key' }).click();
  await expect(page.getByText('New API key — copy it now')).toBeVisible();
  await expect(page.getByText(/^ad_(live|test)_/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'from-smoke-test' })).toBeVisible();
});
