import { isIP } from 'node:net';
import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './store/limits.js';
import { assertValidName } from './store/text.js';

/**
 * The keywords `@fastify/proxy-addr` understands alongside literals — the
 * Express `trust proxy` vocabulary. Their meaning is the resolver's, not
 * Dogpark's; we only let them through. Matched lowercase only, deliberately:
 * one spelling keeps a config value diffable and a typo a startup diagnostic.
 */
const PROXY_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal'] as const;

/**
 * One address, CIDR range, or keyword, checked here so a typo is a startup
 * diagnostic naming the value rather than Fastify's `TypeError: invalid IP
 * address` while the app is being built.
 */
function proxyAddressProblem(entry: string): string | undefined {
  if ((PROXY_KEYWORDS as readonly string[]).includes(entry)) return undefined;
  const [address, prefix, ...rest] = entry.split('/');
  if (address === undefined || rest.length > 0) return `"${entry}" is not an address or range`;
  const family = isIP(address);
  if (family === 0) return `"${entry}" is not an IPv4 or IPv6 address`;
  if (prefix === undefined) return undefined;
  const bits = family === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(prefix)) return `"${entry}" has a prefix length outside 1-${bits}`;
  const length = Number(prefix);
  // `/0` passes `@fastify/proxy-addr`'s own parser only to be rejected at app
  // build with `TypeError: invalid range on address` — the late failure this
  // check exists to prevent — and it means every address anyway, which trusting
  // every peer is exactly what the declaration refuses.
  if (length === 0) return `"${entry}" is a /0 range, which is every address, and is refused`;
  if (length > bits) return `"${entry}" has a prefix length outside 1-${bits}`;
  return undefined;
}

/**
 * Environment only (docs/architecture.md). Parsed once at startup so a
 * misconfiguration is a refusal to start rather than a surprise later.
 */
const Schema = z.object({
  DOGPARK_PORT: z.coerce.number().int().positive().default(8080),
  DOGPARK_DATA_DIR: z.string().default('./data'),

  /**
   * Which interfaces to bind. Default every IPv4 interface (`0.0.0.0`), the only
   * default that reaches a container. On a source build with no proxy, set
   * `127.0.0.1` to keep plaintext off the network — the equivalent of a
   * container's `-p 127.0.0.1:` publish (ADR-0016). An IP literal only: a
   * hostname would resolve ambiguously, so it is refused here rather than
   * left to surface as a bind error later.
   */
  DOGPARK_HOST: z
    .string()
    .default('0.0.0.0')
    .superRefine((value, ctx) => {
      if (isIP(value) === 0) {
        ctx.addIssue({ code: 'custom', message: `"${value}" is not an IPv4 or IPv6 address` });
      }
    }),

  /** The single human. */
  DOGPARK_PASSWORD_HASH: z.string().min(1),
  /**
   * Rendered as the sender of every human message, so it is held to the same
   * rule as an agent's name: the reserved sequence is refused (ADR-0010) and
   * the length is bounded.
   */
  DOGPARK_DISPLAY_NAME: z
    .string()
    .superRefine((value, ctx) => {
      try {
        assertValidName('DOGPARK_DISPLAY_NAME', value);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    })
    .default('human'),

  /**
   * What is in front of Dogpark: either `no`, or a comma-separated list of
   * addresses, CIDR ranges, or the keywords `loopback`, `linklocal`,
   * `uniquelocal` (`@fastify/proxy-addr`'s vocabulary, mixable with literals)
   * permitted to set `X-Forwarded-*`. Keywords are matched lowercase only. A
   * list rather than a boolean, and no default (ADR-0016).
   */
  DOGPARK_TRUST_PROXY: z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      if (value.trim() === 'no') return;
      const problems = value
        .split(',')
        .map((entry) => proxyAddressProblem(entry.trim()))
        .filter((problem): problem is string => problem !== undefined);
      if (problems.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            'must be "no", or a comma-separated list of proxy addresses, CIDR ranges, or the ' +
            'keywords loopback, linklocal, uniquelocal: ' +
            problems.join('; '),
        });
      }
    }),

  /** Slack-style incoming webhook. Absent means escalations are recorded only. */
  DOGPARK_WEBHOOK_URL: z.string().url().optional(),

  DOGPARK_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(64_000),
  DOGPARK_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(50_000_000),
  DOGPARK_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(600),
  /** Bounded by the store's own ceiling, so the advertised limit is the honoured one. */
  DOGPARK_MAX_PAGE_SIZE: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).default(200),
  /** Must sit below the reverse proxy's idle timeout. */
  DOGPARK_MAX_WAIT_SECONDS: z.coerce.number().int().nonnegative().default(30),
  /**
   * How old a run of empty stream polls must be before it is compacted into
   * its last read. `0` — or `no`, like the proxy declaration — never
   * compacts. A default rather than an opt-in because only empty stream polls
   * are touched and the compaction is visible in the surviving row, so
   * nothing is lost by it.
   */
  DOGPARK_READ_COLLAPSE_DAYS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === 'no' ? 0 : value),
    z.coerce.number().int().nonnegative().default(7),
  ),
});

export type Config = z.infer<typeof Schema> & {
  /** False, or the addresses permitted to set `X-Forwarded-*`. */
  readonly trustProxy: false | readonly string[];
  readonly behindProxy: boolean;
  /**
   * The interfaces to bind, `DOGPARK_HOST` (default every IPv4 interface). A field
   * rather than a literal in `server.ts` so the decision is unit-testable.
   */
  readonly listenHost: string;
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
  return {
    ...parsed.data,
    trustProxy,
    behindProxy: trustProxy !== false,
    listenHost: parsed.data.DOGPARK_HOST,
  };
}
