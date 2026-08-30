import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/**
 * The SPA shares an origin with the agent API, so script running in it reaches
 * the admin session and could add an agent to every space. The policy is
 * therefore an allowlist of nothing plus what the built bundle actually needs:
 * its own scripts, its own stylesheet, same-origin XHR, and its own images —
 * the logo and the favicon, both bundled assets. Markdown never embeds an
 * image (it links instead), so 'self' opens no message-controlled loads. No
 * inline script, no fonts, no remote anything, and it may not be framed.
 */
export const SPA_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
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

/** Where the agent guide is served from, so the UI and the docs can name it. */
export const GUIDE_PATH = '/agent-guide.md';

/** Where the bash client is served from. `.sh` because a browser needs a hint. */
export const CLIENT_PATH = '/dogpark.sh';

export interface StaticOptions {
  /** Directory holding the built SPA. A missing one serves a placeholder. */
  readonly uiRoot?: string | undefined;
  /** The agent guide on disk. A missing one is simply not served. */
  readonly guidePath?: string | undefined;
  /** The bash client on disk. A missing one is simply not served. */
  readonly clientPath?: string | undefined;
}

/**
 * Static assets from `/`, with `/api/*` taking precedence — the API routes are
 * more specific than this plugin's wildcard, so the router prefers them and
 * an unmatched `/api/...` falls through to the JSON not-found handler.
 *
 * `guidePath` is the agent guide on disk (`docs/agent-guide.md`) and
 * `clientPath` the bash client (`client/dogpark`), both copied beside the
 * compiled server by the build. Served unauthenticated at `GUIDE_PATH` and
 * `CLIENT_PATH`: they are the instructions handed over with a key, and an
 * agent that has to authenticate to learn how to authenticate has been handed
 * nothing. Read once, at startup — they ship with the server and change with
 * it. `text/plain` rather than `text/markdown` or a shell type so a browser
 * following the link from the key dialog shows them rather than downloading
 * them.
 */
export function staticRoutes(options: StaticOptions): FastifyPluginAsync {
  const { uiRoot, guidePath, clientPath } = options;
  return async function routes(app: FastifyInstance): Promise<void> {
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Content-Security-Policy', SPA_CSP);
      return payload;
    });

    if (guidePath !== undefined && existsSync(guidePath)) {
      const guide = readFileSync(guidePath, 'utf8');
      app.get(GUIDE_PATH, async (_request, reply) =>
        reply.type('text/plain; charset=utf-8').send(guide),
      );
    }

    if (clientPath !== undefined && existsSync(clientPath)) {
      const client = readFileSync(clientPath, 'utf8');
      app.get(CLIENT_PATH, async (_request, reply) =>
        reply.type('text/plain; charset=utf-8').send(client),
      );
    }

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
