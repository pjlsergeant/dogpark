import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { attachmentRoot, sweepUnreferenced } from './http/attachments.js';
import { buildApp } from './http/app.js';
import { hashPassword, readSecret } from './http/password.js';
import { WriteSignals } from './http/signal.js';
import { escalationQueue } from './notify/queue.js';
import { Notifier } from './notify/webhook.js';
import { openStore } from './store/index.js';
import type { AttachmentId, Timestamp } from './types.js';

/** `dist/ui` beside the compiled server, or beneath the working directory. */
function findUiRoot(): string | undefined {
  const candidates = [
    fileURLToPath(new URL('./ui', import.meta.url)),
    resolve(process.cwd(), 'dist/ui'),
  ];
  return candidates.find((path) => existsSync(path));
}

/** `dist/agent-guide.md` beside the compiled server, or the source under `docs/`. */
function findGuide(): string | undefined {
  const candidates = [
    fileURLToPath(new URL('./agent-guide.md', import.meta.url)),
    resolve(process.cwd(), 'docs/agent-guide.md'),
  ];
  return candidates.find((path) => existsSync(path));
}

/** `dist/dogpark.sh` beside the compiled server, or the source under `client/`. */
function findClient(): string | undefined {
  const candidates = [
    fileURLToPath(new URL('./dogpark.sh', import.meta.url)),
    resolve(process.cwd(), 'client/dogpark'),
  ];
  return candidates.find((path) => existsSync(path));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'hash-password') {
    // Never from argv: a command line is visible in process listings and
    // lands in shell history, which is the wrong place for a secret.
    if (rest.length > 0) {
      process.stderr.write(
        'usage: node dist/server.js hash-password\n' +
          'The password is read from stdin, not the command line: run it alone to be ' +
          'prompted, or pipe it in with printf \'%s\' "$PASSWORD" | ...\n',
      );
      process.exitCode = 2;
      return;
    }
    let password: string;
    try {
      password = await readSecret(process.stdin, process.stderr);
    } catch {
      process.exitCode = 130;
      return;
    }
    if (password === '') {
      process.stderr.write('hash-password: no password was given\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${hashPassword(password)}\n`);
    return;
  }

  const config = loadConfig();
  // Every interface when a proxy is in front, loopback when nothing is — the
  // one place plaintext is honest (ADR-0016).
  const binding = { host: config.behindProxy ? '0.0.0.0' : '127.0.0.1' };

  const store = openStore({
    file: join(config.DOGPARK_DATA_DIR, 'dogpark.sqlite'),
    humanDisplayName: config.DOGPARK_DISPLAY_NAME,
  });
  // Before the app is built, so no request is served under a password that has
  // changed while sessions minted under the old one are still valid. The log
  // has to wait for the app.
  const revokedSessions = store.syncPasswordFingerprint(config.DOGPARK_PASSWORD_HASH);
  const uiRoot = findUiRoot();
  const guidePath = findGuide();
  const clientPath = findClient();
  const writes = new WriteSignals();
  const app = await buildApp({
    store,
    config,
    ...(uiRoot === undefined ? {} : { uiRoot }),
    ...(guidePath === undefined ? {} : { guidePath }),
    ...(clientPath === undefined ? {} : { clientPath }),
    logger: true,
    writes,
  });
  app.log.info(
    { schemaVersion: store.schema.to, trustProxy: config.behindProxy, host: binding.host },
    'dogpark starting',
  );
  if (revokedSessions > 0) {
    app.log.warn(
      { revoked: revokedSessions },
      'the admin password changed; existing sessions are revoked',
    );
  }
  if (config.behindProxy) {
    // A direct caller is refused, but not before its credentials have crossed
    // the network in the clear (ADR-0016).
    app.log.warn(
      { host: binding.host, trustedProxies: config.trustProxy },
      'listening on every interface because a proxy is declared: publish this port only to ' +
        'that proxy, or anything that can reach it speaks to Dogpark directly, in plaintext',
    );
  } else {
    app.log.warn(
      'DOGPARK_TRUST_PROXY=no: listening on loopback only and issuing non-Secure ' +
        "session cookies. Set it to the proxy's address when a TLS-terminating proxy " +
        'is in front.',
    );
  }

  // Before listening: nothing is in flight to race the walk, and a volume
  // that cannot be swept is not a reason to refuse to serve.
  const swept = await sweepUnreferenced(
    attachmentRoot(config.DOGPARK_DATA_DIR),
    (id) => store.getAttachment(id as AttachmentId) !== undefined,
  );
  if (swept.length > 0) {
    app.log.info({ count: swept.length }, 'collected attachment files no message references');
  }

  // An idle agent's long poll writes two empty read-log rows a minute, for
  // ever. Runs of them are compacted into the last read of each run, which
  // says how many it stands for; nothing that returned content is touched.
  const collapseDays = config.DOGPARK_READ_COLLAPSE_DAYS;
  let collapseTimer: NodeJS.Timeout | undefined;
  if (collapseDays > 0) {
    const collapse = (): void => {
      try {
        const cutoff = new Date(Date.now() - collapseDays * 86_400_000).toISOString() as Timestamp;
        const { collapsed, removed } = store.collapseEmptyStreamReads(cutoff);
        if (removed > 0) {
          app.log.info({ collapsed, removed }, 'compacted runs of empty stream polls');
        }
      } catch (error) {
        // A sweep that cannot run is not a reason to stop serving, nor to
        // stop trying an hour later.
        app.log.error({ err: error }, 'the read-log collapse sweep failed');
      }
    };
    collapse();
    collapseTimer = setInterval(collapse, 3_600_000);
    collapseTimer.unref();
  }

  const notifier = new Notifier(
    escalationQueue(store, () => writes.adminOnly()),
    {
      ...(config.DOGPARK_WEBHOOK_URL === undefined
        ? {}
        : { webhookUrl: config.DOGPARK_WEBHOOK_URL }),
    },
  );
  notifier.start((error: unknown) => {
    app.log.error({ err: error }, 'the escalation queue failed to drain');
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    // A second signal while the first is in flight is impatience, not a new
    // instruction.
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    notifier.stop();
    if (collapseTimer !== undefined) clearInterval(collapseTimer);
    void app
      .close()
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'the server did not close cleanly');
      })
      .finally(() => {
        // Last: in-flight requests hold statements against this database.
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: binding.host, port: config.DOGPARK_PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
