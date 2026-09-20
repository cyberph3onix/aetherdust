import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
          testTimeout: 300_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
