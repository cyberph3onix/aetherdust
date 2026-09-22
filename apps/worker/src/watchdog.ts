/**
 * Event-loop watchdog. The wallet SDK can spin synchronously forever (seen 2026-09-22: wallet-sdk-dust-wallet 4.2.0
 * `computeBalancingRecipe` with a zero network fee), which freezes the whole worker — RPC, snapshots, sponsoring —
 * with no way to time it out from inside the loop. A worker thread watches a shared heartbeat that the main thread
 * bumps every second; when it goes stale it kills the process so the supervisor (compose `restart: unless-stopped`,
 * systemd, k8s) can restart it. Cost of a restart: a wallet re-sync — still far better than a silent hang.
 */
import { writeSync } from 'node:fs';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

export interface Watchdog { stop(): void }

export const startEventLoopWatchdog = (staleAfterMs: number, log: { error: (o: object, m?: string) => void }): Watchdog => {
  const shared = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(shared);
  const bump = () => { beat[0] = BigInt(Date.now()); };
  bump();
  const timer = setInterval(bump, 1000);
  timer.unref();
  const thread = new Worker(new URL(import.meta.url), { workerData: { shared, staleAfterMs } });
  thread.unref();
  thread.on('error', (e) => log.error({ err: e }, 'event-loop watchdog thread failed'));
  return { stop: () => { clearInterval(timer); void thread.terminate(); } };
};

if (!isMainThread && workerData?.shared) {
  const beat = new BigInt64Array(workerData.shared as SharedArrayBuffer);
  const staleAfterMs: number = workerData.staleAfterMs;
  setInterval(() => {
    const age = Date.now() - Number(beat[0]);
    if (age > staleAfterMs) {
      writeSync(2, `${JSON.stringify({ level: 60, time: Date.now(), msg: `event loop blocked for ${Math.round(age / 1000)} s (> ${staleAfterMs / 1000} s): killing the worker so the supervisor restarts it` })}\n`);
      process.kill(process.pid, 'SIGKILL');
    }
  }, 5000);
}
