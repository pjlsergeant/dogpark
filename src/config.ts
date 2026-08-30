import { z } from 'zod';

/**
 * Environment only (docs/architecture.md). Parsed once at startup so a
 * misconfiguration is a refusal to start rather than a surprise later.
 */
const Schema = z.object({
  DOGPARK_PORT: z.coerce.number().int().positive().default(8080),
  DOGPARK_DATA_DIR: z.string().default('./data'),

  /** The single human. */
  DOGPARK_PASSWORD_HASH: z.string().min(1),
  DOGPARK_DISPLAY_NAME: z.string().min(1).default('human'),

  /**
   * Dogpark speaks plain HTTP and must be told it is behind a proxy that
   * terminates TLS. Refusing to guess: bearer tokens over plaintext is the
   * failure this prevents.
   */
  DOGPARK_TRUST_PROXY: z.enum(['yes', 'no']),

  /** Slack-style incoming webhook. Absent means escalations are recorded only. */
  DOGPARK_WEBHOOK_URL: z.string().url().optional(),

  DOGPARK_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(64_000),
  DOGPARK_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(50_000_000),
  DOGPARK_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(600),
  DOGPARK_MAX_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  /** Must sit below the reverse proxy's idle timeout. */
  DOGPARK_MAX_WAIT_SECONDS: z.coerce.number().int().nonnegative().default(30),
});

export type Config = z.infer<typeof Schema> & { trustProxy: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Dogpark cannot start: configuration is invalid.\n${issues}`);
  }
  return { ...parsed.data, trustProxy: parsed.data.DOGPARK_TRUST_PROXY === 'yes' };
}
