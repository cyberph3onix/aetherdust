/**
 * Integration tests need a real Postgres. Use AETHERDUST_TEST_DATABASE_URL if provided (CI, Docker), otherwise start an
 * unprivileged embedded Postgres (no Docker needed).
 */
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject) {
  let url = process.env.AETHERDUST_TEST_DATABASE_URL;
  let stop = async () => {};
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = 54000 + Math.floor(Math.random() * 1000);
    const pg = new EmbeddedPostgres({ databaseDir: `.pg-data/test-${port}`, user: 'aetherdust', password: 'aetherdust', port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('aetherdust_test');
    url = `postgres://aetherdust:aetherdust@127.0.0.1:${port}/aetherdust_test`;
    stop = () => pg.stop();
  }
  process.env.AETHERDUST_TEST_DATABASE_URL = url;
  project.provide('databaseUrl', url);
  return stop;
}

declare module 'vitest' {
  export interface ProvidedContext { databaseUrl: string }
}
