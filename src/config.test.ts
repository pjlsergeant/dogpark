import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { EXAMPLE_PASSWORD_HASH } from './http/password.js';
import { RESERVED_SEQUENCE } from './store/text.js';

const base = { DOGPARK_PASSWORD_HASH: 'scrypt$1$1$1$a$b', DOGPARK_TRUST_PROXY: 'no' };

describe('DOGPARK_DISPLAY_NAME', () => {
  it('is held to the same rule as every other name', () => {
    expect(loadConfig({ ...base, DOGPARK_DISPLAY_NAME: 'pete' }).DOGPARK_DISPLAY_NAME).toBe('pete');
    expect(loadConfig(base).DOGPARK_DISPLAY_NAME).toBe('human');
  });

  it('refuses the reserved sequence, which would defeat flattening (ADR-0010)', () => {
    expect(() => loadConfig({ ...base, DOGPARK_DISPLAY_NAME: `pe${RESERVED_SEQUENCE}te` })).toThrow(
      /DOGPARK_DISPLAY_NAME.*reserved sequence U\+001E/,
    );
  });

  it('is bounded in length like an agent name', () => {
    expect(() => loadConfig({ ...base, DOGPARK_DISPLAY_NAME: 'p'.repeat(65) })).toThrow(
      /DOGPARK_DISPLAY_NAME.*1-64 characters/,
    );
    expect(loadConfig({ ...base, DOGPARK_DISPLAY_NAME: 'p'.repeat(64) }).DOGPARK_DISPLAY_NAME).toBe(
      'p'.repeat(64),
    );
  });
});

describe('DOGPARK_READ_COLLAPSE_DAYS', () => {
  it('defaults to a week, and takes "no" as never, like the proxy declaration', () => {
    expect(loadConfig(base).DOGPARK_READ_COLLAPSE_DAYS).toBe(7);
    expect(
      loadConfig({ ...base, DOGPARK_READ_COLLAPSE_DAYS: '30' }).DOGPARK_READ_COLLAPSE_DAYS,
    ).toBe(30);
    expect(
      loadConfig({ ...base, DOGPARK_READ_COLLAPSE_DAYS: 'no' }).DOGPARK_READ_COLLAPSE_DAYS,
    ).toBe(0);
    expect(
      loadConfig({ ...base, DOGPARK_READ_COLLAPSE_DAYS: '0' }).DOGPARK_READ_COLLAPSE_DAYS,
    ).toBe(0);
  });

  it('refuses a negative or fractional number of days', () => {
    expect(() => loadConfig({ ...base, DOGPARK_READ_COLLAPSE_DAYS: '-1' })).toThrow(
      /DOGPARK_READ_COLLAPSE_DAYS/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_READ_COLLAPSE_DAYS: 'sometimes' })).toThrow(
      /DOGPARK_READ_COLLAPSE_DAYS/,
    );
  });
});

describe('DOGPARK_TRUST_PROXY', () => {
  it('has no default: an undeclared proxy refuses to start (ADR-0008, ADR-0016)', () => {
    expect(() => loadConfig({ DOGPARK_PASSWORD_HASH: 'scrypt$1$1$1$a$b' })).toThrow(
      /DOGPARK_TRUST_PROXY/,
    );
  });

  it('accepts addresses and ranges of either family', () => {
    const config = loadConfig({
      ...base,
      DOGPARK_TRUST_PROXY: '127.0.0.1, 172.18.0.0/16,::1,fd00::/8',
    });
    expect(config.trustProxy).toEqual(['127.0.0.1', '172.18.0.0/16', '::1', 'fd00::/8']);
    expect(config.behindProxy).toBe(true);
    expect(loadConfig(base).trustProxy).toBe(false);
  });

  it('refuses an impossible address at load, naming it', () => {
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: '999.999.999.999' })).toThrow(
      /DOGPARK_TRUST_PROXY.*"999\.999\.999\.999" is not an IPv4 or IPv6 address/,
    );
  });

  it('refuses a prefix length the family cannot have', () => {
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: '10.0.0.0/33' })).toThrow(
      /"10\.0\.0\.0\/33" has a prefix length outside 1-32/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: 'fd00::/129' })).toThrow(
      /outside 1-128/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: '10.0.0.0/8/x' })).toThrow(
      /is not an address or range/,
    );
  });

  it('refuses a /0 range, which is every address, of either family', () => {
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: '10.0.0.0/0' })).toThrow(
      /"10\.0\.0\.0\/0" is a \/0 range, which is every address, and is refused/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: '::/0' })).toThrow(
      /"::\/0" is a \/0 range, which is every address, and is refused/,
    );
  });

  it('accepts the proxy-addr keywords, alone and mixed with literals', () => {
    for (const keyword of ['loopback', 'linklocal', 'uniquelocal']) {
      expect(loadConfig({ ...base, DOGPARK_TRUST_PROXY: keyword }).trustProxy).toEqual([keyword]);
    }
    expect(
      loadConfig({ ...base, DOGPARK_TRUST_PROXY: 'uniquelocal, 203.0.113.7' }).trustProxy,
    ).toEqual(['uniquelocal', '203.0.113.7']);
  });

  it('takes the keywords lowercase only, and names them when a word is not one', () => {
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: 'UniqueLocal' })).toThrow(
      /loopback, linklocal, uniquelocal/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: 'yes' })).toThrow(
      /loopback, linklocal, uniquelocal/,
    );
  });
});

describe('examplePassword', () => {
  it('is true only when the hash is the README example, compared as a string after trim', () => {
    expect(loadConfig(base).examplePassword).toBe(false);
    expect(
      loadConfig({ ...base, DOGPARK_PASSWORD_HASH: EXAMPLE_PASSWORD_HASH }).examplePassword,
    ).toBe(true);
    // Trimmed before the compare: a stray newline off a copy-paste still counts
    // as the example, so the warning cannot be silenced by whitespace.
    expect(
      loadConfig({ ...base, DOGPARK_PASSWORD_HASH: `  ${EXAMPLE_PASSWORD_HASH}\n` })
        .examplePassword,
    ).toBe(true);
  });
});

describe('DOGPARK_HOST', () => {
  // The exact name is ADR-0016's arm (docs/adr/README.md): the default binds
  // every interface in both proxy modes, so a container is reachable without a
  // proxy in front.
  it('is every interface in both modes, so a container is reachable without a proxy', () => {
    expect(loadConfig(base).listenHost).toBe('0.0.0.0');
    expect(loadConfig({ ...base, DOGPARK_TRUST_PROXY: '127.0.0.1' }).listenHost).toBe('0.0.0.0');
  });

  it('honours an explicit bind address', () => {
    expect(loadConfig({ ...base, DOGPARK_HOST: '127.0.0.1' }).listenHost).toBe('127.0.0.1');
    expect(loadConfig({ ...base, DOGPARK_HOST: '::1' }).listenHost).toBe('::1');
  });

  it('refuses a hostname, naming it: the bind target must be an IP literal', () => {
    expect(() => loadConfig({ ...base, DOGPARK_HOST: 'localhost' })).toThrow(
      /DOGPARK_HOST.*"localhost" is not an IPv4 or IPv6 address/,
    );
  });
});
