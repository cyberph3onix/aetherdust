import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the API runs on 8080: proxy /v1 and /metrics so the dashboard is same-origin and needs no CORS setup.
// In production the bundle is static; the API base URL is chosen at runtime (see src/api.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/v1': 'http://127.0.0.1:8080', '/healthz': 'http://127.0.0.1:8080' },
  },
  build: { target: 'es2022' },
});
