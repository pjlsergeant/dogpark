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
   * Dogpark speaks plain HTTP and must be told what is in front of it.
   *
   * Either `no`, or a comma-separated list of addresses or CIDR ranges that
   * are permitted to set `X-Forwarded-*`. Not a boolean: trusting the headers
   * from *anyone* who can reach the port means anyone who can reach it can
   * claim any client address — bypassing login throttling — and claim
   * `X-Forwarded-Proto: https` while speaking plaintext, which defeats the
   * refusal this setting exists to enforce.
   */
  DOGPARK_TRUST_PROXY: z
    .string()
    .min(1)
    .refine(
      (v) => v === 'no' || v.split(',').every((p) => /^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(p.trim())),
      'must be "no" or a comma-separated list of proxy addresses or CIDR ranges',
    ),

  /** Slack-style incoming webhook. Absent means escalations are recorded only. */
  DOGPARK_WEBHOOK_URL: z.string().url().optional(),

  DOGPARK_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(64_000),
  DOGPARK_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(50_000_000),
  DOGPARK_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(600),
  DOGPARK_MAX_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  /** Must sit below the reverse proxy's idle timeout. */
  DOGPARK_MAX_WAIT_SECONDS: z.coerce.number().int().nonnegative().default(30),
});

export type Config = z.infer<typeof Schema> & {
  /** False, or the addresses permitted to set `X-Forwarded-*`. */
  readonly trustProxy: false | readonly string[];
  readonly behindProxy: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Dogpark cannot start: configuration is invalid.\n${issues}`);
  }
  const declared = parsed.data.DOGPARK_TRUST_PROXY.trim();
  const trustProxy =
    declared === 'no' ? (false as const) : declared.split(',').map((p) => p.trim());
  return { ...parsed.data, trustProxy, behindProxy: trustProxy !== false };
}
