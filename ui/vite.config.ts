import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA. Built into `dist/ui`, which Fastify serves from `/` with `/api/*`
 * taking precedence (docs/http-api.md).
 *
 * `--mode mock` (see `.env.mock`, used by `npm run dev:ui`) swaps the API
 * client for the fixture-backed one so screens can be developed with no
 * server. In every other mode the mock is not reachable: it lives behind a
 * dynamic import that the flag never satisfies.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['DOGPARK_DEV_API'] ?? 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
});
