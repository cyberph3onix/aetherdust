import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';

// The Midnight ledger and onchain runtime are WASM modules with top-level await (Vite 8 / rolldown handles TLA natively);
// they cannot be pre-bundled, so their CommonJS deps are listed explicitly. The level DB and scale-codec deps expect a few
// Node built-ins (assert, events, process, Buffer): provided by vite-plugin-node-polyfills in dev and build.
export default defineConfig({
  resolve: { alias: { 'cross-fetch': fileURLToPath(new URL('./src/shims/cross-fetch.ts', import.meta.url)) } },
  plugins: [wasm(), nodePolyfills({ include: ['assert', 'events', 'util', 'buffer', 'process', 'stream'], globals: { Buffer: true, process: true, global: true } })],
  optimizeDeps: {
    include: ['@midnight-ntwrk/compact-runtime > object-inspect', '@midnight-ntwrk/ledger-v8 > object-inspect'],
    exclude: ['@midnight-ntwrk/ledger-v8', '@midnight-ntwrk/onchain-runtime-v3', '@midnight-ntwrk/compact-runtime'],
  },
  build: { target: 'esnext' },
  server: { port: 5173 },
});
