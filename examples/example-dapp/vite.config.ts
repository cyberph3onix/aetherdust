import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

// The Midnight ledger and onchain runtime are WASM modules with top-level await (Vite 8 / rolldown handles TLA natively).
// `assert` / `events` are Node built-ins that the level DB and scale-codec dependencies expect: alias browser shims.
export default defineConfig({
  plugins: [wasm()],
  resolve: { alias: { assert: 'assert', events: 'events' } },
  optimizeDeps: { exclude: ['@midnight-ntwrk/ledger-v8', '@midnight-ntwrk/onchain-runtime-v3', '@midnight-ntwrk/compact-runtime'] },
  build: { target: 'esnext' },
  server: { port: 5173 },
});
