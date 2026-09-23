import { defineConfig } from '@playwright/test';

/**
 * Dashboard smoke test (Phase 4). Two servers: the in-process AetherDust stack with seeded traffic
 * (`test/smoke/stack.ts`) and the built dashboard served by `vite preview`; the dashboard is pointed at the api
 * through VITE_AETHERDUST_API_URL, so the test exercises the real bundle, not the dev server.
 */
const API = 'http://127.0.0.1:8099';
const UI = 'http://127.0.0.1:5174';
const DAPP = 'http://127.0.0.1:5175';

export default defineConfig({
  testDir: 'test/smoke',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: { baseURL: UI, trace: 'retain-on-failure' },
  // never reuse: a server left over from an earlier run serves a bundle built against a different API base,
  // and the stack's seeded traffic must be exactly what these assertions expect
  webServer: [
    { command: 'pnpm smoke:stack', url: `${API}/healthz`, reuseExistingServer: false, timeout: 180_000, stdout: 'pipe', stderr: 'pipe' },
    {
      // --host 127.0.0.1: vite preview otherwise binds "localhost", which resolves to ::1 first on CI runners,
      // and the check below (and the browser) would be knocking on 127.0.0.1
      command: `VITE_AETHERDUST_API_URL=${API} pnpm --filter @aetherdust/dashboard build && pnpm --filter @aetherdust/dashboard preview --host 127.0.0.1 --port 5174 --strictPort`,
      url: UI, reuseExistingServer: false, timeout: 180_000,
    },
    {
      // the Private Allowlist Access page; its spec skips unless a deployed contract is supplied
      command: 'pnpm --filter @aetherdust/allowlist-dapp build && pnpm --filter @aetherdust/allowlist-dapp preview --host 127.0.0.1 --port 5175 --strictPort',
      url: DAPP, reuseExistingServer: false, timeout: 180_000,
    },
  ],
});
