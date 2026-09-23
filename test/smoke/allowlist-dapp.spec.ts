/**
 * The Private Allowlist Access page, driven in a real browser against a real chain.
 *
 * It covers everything up to the wallet: the secret kept in the browser, the commitment derived locally with the
 * same hash the circuit uses, the public record read straight from the indexer, and the membership verdict for a
 * member versus a stranger. The two things it cannot cover are the Lace extension itself and in-browser proving —
 * `test/e2e/allowlist.e2e.test.ts` covers that path headlessly through a connector-shaped wallet.
 *
 * Needs a deployed allowlist and one of its member secrets:
 *   ALLOWLIST_CONTRACT=<64 hex> ALLOWLIST_SECRET=<64 hex> [ALLOWLIST_INDEXER=<url>] pnpm test:smoke
 * Without them the whole file skips, so the dashboard smoke still runs on a machine with no chain.
 */
import { expect, test, type Page } from '@playwright/test';

const CONTRACT = process.env.ALLOWLIST_CONTRACT ?? '';
const SECRET = process.env.ALLOWLIST_SECRET ?? '';
const INDEXER = process.env.ALLOWLIST_INDEXER ?? 'http://127.0.0.1:8088/api/v4/graphql';
const STRANGER = 'ff'.repeat(32);
const UI = 'http://127.0.0.1:5175';

test.skip(!/^[0-9a-f]{64}$/i.test(CONTRACT) || !/^[0-9a-f]{64}$/i.test(SECRET),
  'set ALLOWLIST_CONTRACT and ALLOWLIST_SECRET to run these (see the file header)');

/** Configure the page the way a visitor would: network, indexer, contract — then a secret. */
const openWith = async (page: Page, secret: string) => {
  await page.goto(UI);
  await page.getByRole('group').or(page.locator('details.settings')).first().click(); // open Connection settings
  await page.getByLabel('Network').fill('undeployed');
  await page.getByLabel(/^Indexer/).fill(INDEXER);
  await page.getByLabel(/^Allowlist contract/).fill(CONTRACT);
  await page.getByLabel(/^Import a secret/).fill(secret);
  await page.getByLabel(/^Import a secret/).press('Enter');
  await page.getByLabel(/^Import a secret/).blur();
  await expect(page.locator('#members')).not.toHaveText(/not read yet/, { timeout: 20_000 });
};

test('reads the public record with no wallet connected', async ({ page }) => {
  await openWith(page, SECRET);

  // the register is populated straight from the indexer — a visitor sees the list before connecting anything
  await expect(page.locator('#members')).toHaveText(/^[0-9]+$/);
  await expect(page.locator('#admissions')).toHaveText(/^[0-9]+$/);
  expect(Number(await page.locator('#members').textContent())).toBeGreaterThan(0);
  await expect(page.locator('#root')).not.toHaveText('not read yet');
  await expect(page.locator('#contract-out')).toHaveAttribute('title', CONTRACT);

  // and the wallet step is honestly still open
  await expect(page.locator('[data-step="wallet"]')).toHaveAttribute('data-done', 'false');
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
});

test('derives the commitment locally and recognises a member', async ({ page }) => {
  await openWith(page, SECRET);

  // the commitment is computed in the browser from the secret, with the same hash the circuit uses
  const commitment = await page.locator('#commitment').getAttribute('title');
  expect(commitment).toMatch(/^[0-9a-f]{64}$/);

  await expect(page.locator('#listed')).toHaveText('yes');
  await expect(page.locator('#listed')).toHaveAttribute('data-v', 'yes');
  await expect(page.locator('[data-step="member"]')).toHaveAttribute('data-done', 'true');

  // the secret itself is masked until asked for
  await expect(page.locator('#secret')).toHaveText(/^•+$/);
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.locator('#secret')).toHaveAttribute('title', SECRET.toLowerCase());
});

test('refuses to call a stranger a member', async ({ page }) => {
  await openWith(page, STRANGER);

  await expect(page.locator('#listed')).toHaveText('not on it');
  await expect(page.locator('#listed')).toHaveAttribute('data-v', 'no');
  await expect(page.locator('[data-step="member"]')).toHaveAttribute('data-done', 'false');
  // and there is nothing to press: proving membership you do not have is not offered
  await expect(page.getByRole('button', { name: 'Prove membership and enter' })).toBeDisabled();
});

test('shows an admission that has already happened as a stamp, without naming anyone', async ({ page }) => {
  await openWith(page, SECRET);

  const admissions = Number(await page.locator('#admissions').textContent());
  const stamps = page.locator('#stamps li');
  await expect(stamps).toHaveCount(Math.max(1, admissions));

  if (admissions > 0) {
    // every stamp is a 32-byte nullifier, and none of them is a leaf of the members tree
    for (const title of await stamps.evaluateAll((els) => els.map((e) => e.getAttribute('title')))) {
      expect(title).toMatch(/^[0-9a-f]{64}$/);
    }
    const commitment = await page.locator('#commitment').getAttribute('title');
    const titles = await stamps.evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    expect(titles).not.toContain(commitment); // a stamp never reveals the commitment behind it
  }
});
