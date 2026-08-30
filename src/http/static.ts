import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/**
 * The SPA shares an origin with the agent API, so script running in it reaches
 * the admin session and could add an agent to every space. The policy is
 * therefore an allowlist of nothing plus what the built bundle actually needs:
 * its own scripts, its own stylesheet, and same-origin XHR. No inline script,
 * no images or fonts (the bundle ships none), no remote anything, and it may
 * not be framed.
 */
export const SPA_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const NOT_BUILT = `<!doctype html>
<meta charset="utf-8">
<title>Dogpark</title>
<h1>Dogpark is running</h1>
<p>The single-page UI has not been built. Run <code>npm run build:ui</code>.
The API is serving normally at <code>/api/agent</code> and <code>/api/admin</code>.</p>
`;

/**
 * Static assets from `/`, with `/api/*` taking precedence — the API routes are
 * more specific than this plugin's wildcard, so the router prefers them and
 * an unmatched `/api/...` falls through to the JSON not-found handler.
 */
export function staticRoutes(uiRoot: string | undefined): FastifyPluginAsync {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Content-Security-Policy', SPA_CSP);
      return payload;
    });

    if (uiRoot === undefined || !existsSync(join(uiRoot, 'index.html'))) {
      // A missing bundle is a build that has not run, not a reason to refuse
      // to serve the API.
      app.get('/', async (_request, reply) =>
        reply.type('text/html; charset=utf-8').send(NOT_BUILT),
      );
      return;
    }

    await app.register(fastifyStatic, {
      root: uiRoot,
      prefix: '/',
      index: ['index.html'],
      // The UI routes on the hash, so there is no history fallback to serve
      // and an unknown path is genuinely unknown.
      wildcard: true,
      dotfiles: 'deny',
    });
  };
}
