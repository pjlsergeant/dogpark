import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { attachmentRoot, sweepUnreferenced } from './http/attachments.js';
import { buildApp } from './http/app.js';
import { hashPassword } from './http/password.js';
import type { EscalationQueue, PendingEscalation } from './notify/webhook.js';
import { Notifier } from './notify/webhook.js';
import type { Store } from './store/index.js';
import { openStore } from './store/index.js';
import type { AttachmentId, Timestamp } from './types.js';

/**
 * The entry point: configuration, storage, HTTP, notification, and a shutdown
 * that ends them in that order reversed.
 */

/**
 * Where to listen follows from the proxy declaration: every interface when one
 * is in front, loopback when nothing is — the one place plaintext is honest
 * (ADR-0016).
 */
export function resolveBinding(config: Config): { readonly host: string } {
  return { host: config.behindProxy ? '0.0.0.0' : '127.0.0.1' };
}

/**
 * The notifier wants four verbs over pending escalations; the store keeps them
 * as rows with their own retry state. This is the whole of the adapter.
 */
export function escalationQueue(store: Store): EscalationQueue {
  return {
    claimDue(now, limit) {
      const due = store.listEscalations({
        state: 'pending',
        dueAt: new Date(now).toISOString() as Timestamp,
        limit,
      });
      return due.map((record): PendingEscalation => {
        const conversation = store.getConversation(record.conversation);
        const space = conversation === undefined ? undefined : store.getSpace(conversation.space);
        return {
          id: record.id,
          agentName: store.getAgent(record.agent)?.displayName ?? record.agent,
          spaceName: space?.name ?? 'an unknown space',
          conversationTitle: conversation?.title ?? 'an unknown conversation',
          reason: record.reason,
          raisedAt: record.createdAt,
          attempts: record.attempts,
        };
      });
    },
    markSent(id) {
      store.markEscalationNotification(id, 'sent');
    },
    markFailed(id, nextAttemptAt) {
      // Still pending: a failure that is going to be retried is not a failed
      // notification, and the store counts the attempt itself.
      store.markEscalationNotification(id, 'pending', {
        nextAttemptAt: new Date(nextAttemptAt).toISOString() as Timestamp,
      });
    },
    markGivenUp(id) {
      store.markEscalationNotification(id, 'failed', {
        error: 'gave up after repeated delivery failures',
      });
    },
  };
}

/**
 * Files on the volume that no message references, collected at startup.
 *
 * The write ordering is deliberate — bytes first, message row last, so a crash
 * between them strands a file rather than leaving a message pointing at
 * nothing — but nothing ever collected the strays. Startup is where there is
 * no upload in flight to race, and an age floor covers the case where there
 * somehow is.
 *
 * Never fatal: a volume that cannot be swept is not a reason to refuse to
 * serve.
 */
async function sweepOrphanedAttachments(store: Store, config: Config): Promise<readonly string[]> {
  return sweepUnreferenced(
    attachmentRoot(config.DOGPARK_DATA_DIR),
    (id) => store.getAttachment(id as AttachmentId) !== undefined,
  );
}

/** `dist/ui` beside the compiled server, or beneath the working directory. */
function findUiRoot(): string | undefined {
  const candidates = [
    fileURLToPath(new URL('./ui', import.meta.url)),
    resolve(process.cwd(), 'dist/ui'),
  ];
  return candidates.find((path) => existsSync(path));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'hash-password') {
    const password = rest[0];
    if (password === undefined) {
      process.stderr.write('usage: node dist/server.js hash-password <password>\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${hashPassword(password)}\n`);
    return;
  }

  const config = loadConfig();
  const binding = resolveBinding(config);

  const store = openStore({
    file: join(config.DOGPARK_DATA_DIR, 'dogpark.sqlite'),
    humanDisplayName: config.DOGPARK_DISPLAY_NAME,
  });
  const uiRoot = findUiRoot();
  const app = await buildApp({
    store,
    config,
    ...(uiRoot === undefined ? {} : { uiRoot }),
    logger: true,
  });
  app.log.info(
    { schemaVersion: store.schema.to, trustProxy: config.behindProxy, host: binding.host },
    'dogpark starting',
  );
  if (config.behindProxy) {
    // 0.0.0.0 is the whole point of the declaration — the proxy has to reach
    // us — but it is also every other interface. If the port is published, the
    // proxy is no longer the only way in, and the TLS refusal that
    // `X-Forwarded-Proto` powers is bypassed by simply not sending the header.
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

  // Before the notifier and before listening: it walks the volume, and there
  // is nothing in flight to race at this point.
  const swept = await sweepOrphanedAttachments(store, config);
  if (swept.length > 0) {
    app.log.info({ count: swept.length }, 'collected attachment files no message references');
  }

  const notifier = new Notifier(escalationQueue(store), {
    ...(config.DOGPARK_WEBHOOK_URL === undefined ? {} : { webhookUrl: config.DOGPARK_WEBHOOK_URL }),
  });
  notifier.start(undefined, (error: unknown) => {
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
