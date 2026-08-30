import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA. Built into `dist/ui`, which Fastify serves from `/` with `/api/*`
 * taking precedence (docs/http-api.md).
 *
 * `npm run dev:ui` serves the SPA alone and proxies `/api` to a running
 * Dogpark (`DOGPARK_DEV_API`, default `http://127.0.0.1:8080`).
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
