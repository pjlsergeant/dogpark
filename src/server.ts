import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { attachmentRoot, sweepUnreferenced } from './http/attachments.js';
import { buildApp } from './http/app.js';
import { assertUsablePasswordHash, hashPassword, readSecret } from './http/password.js';
import { WriteSignals } from './http/signal.js';
import { escalationQueue } from './notify/queue.js';
import { Notifier } from './notify/webhook.js';
import { openStore } from './store/index.js';
import type { CollapseResume } from './store/index.js';
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
  // Every interface, in both modes: exposure is the deployer's port publish,
  // as for every containerised service (ADR-0016).
  const binding = { host: config.listenHost };

  const store = openStore({
    file: join(config.DOGPARK_DATA_DIR, 'dogpark.sqlite'),
    humanDisplayName: config.DOGPARK_DISPLAY_NAME,
  });
  // Before the fingerprint is touched: a hash nobody can match must refuse the
  // start before it is allowed to revoke anything. Syncing first would log
  // everyone out, record the unusable hash, and only then refuse — and the
  // corrected hash would look like another rotation on the next boot.
  // buildApp asserts it again for callers that reach it directly.
  assertUsablePasswordHash(config.DOGPARK_PASSWORD_HASH);
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
      'DOGPARK_TRUST_PROXY=no: no proxy declared, so X-Forwarded-* is ignored, session ' +
        'cookies are not Secure, and plaintext is accepted. This listens on every ' +
        "interface, so publish the port only where plaintext is acceptable (a laptop's " +
        "127.0.0.1). Set DOGPARK_TRUST_PROXY to the proxy's address when a TLS-terminating " +
        'proxy is in front.',
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
  // One sweep at a time: a second walk over the same candidates would find
  // only the first one's work, and the two would contend for the same rows.
  let sweeping = false;
  const collapse = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      const cutoff = new Date(Date.now() - collapseDays * 86_400_000).toISOString() as Timestamp;
      let collapsed = 0;
      let removed = 0;
      let resume: CollapseResume | undefined;
      for (;;) {
        const batch = store.collapseEmptyStreamReads(cutoff, {
          ...(resume === undefined ? {} : { resume }),
        });
        collapsed += batch.collapsed;
        removed += batch.removed;
        if (batch.done) break;
        resume = batch.resume;
        // Back to the event loop between batches: a backlog of months is a
        // long sweep, and a long sweep must not be a stalled server.
        await new Promise((done) => setImmediate(done));
        // Checked after the yield, not before it: a signal can land while the
        // driver is parked, and everything from here to the next batch is
        // synchronous, so this is the last word before the database is
        // touched. A sweep is resumable by construction and the next one is
        // an hour away, so shutdown does not wait for the rest of this one.
        if (closing) break;
      }
      // Once a sweep, not once a batch: what the operator wants is the total.
      if (removed > 0) {
        app.log.info({ collapsed, removed }, 'compacted runs of empty stream polls');
      }
    } catch (error) {
      // A sweep that cannot run is not a reason to stop serving, nor to
      // stop trying an hour later.
      app.log.error({ err: error }, 'the read-log collapse sweep failed');
    } finally {
      sweeping = false;
    }
  };

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

  // After listening, and not awaited: the first sweep of an instance upgraded
  // after months of idle polling has a long backlog to walk, and readiness is
  // not allowed to wait on it. Errors are the driver's own business.
  if (collapseDays > 0) {
    void collapse();
    collapseTimer = setInterval(() => void collapse(), 3_600_000);
    collapseTimer.unref();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
