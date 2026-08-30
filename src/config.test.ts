import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
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

describe('DOGPARK_TRUST_PROXY', () => {
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
      /"10\.0\.0\.0\/33" has a prefix length outside 0-32/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: 'fd00::/129' })).toThrow(
      /outside 0-128/,
    );
    expect(() => loadConfig({ ...base, DOGPARK_TRUST_PROXY: '10.0.0.0/8/x' })).toThrow(
      /is not an address or range/,
    );
  });
});
