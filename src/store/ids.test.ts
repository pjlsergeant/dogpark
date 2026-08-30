import { describe, expect, it } from 'vitest';
import { ID_LENGTH, newId, splitKey } from './ids.js';

describe('splitKey', () => {
  it('splits at the first two underscores, whatever the secret contains', () => {
    const agent = newId();
    expect(splitKey(`dgp_${agent}_ab_cd__ef`)).toEqual({ agent, secret: 'ab_cd__ef' });
    expect(splitKey(`dgp_${agent}_deadbeef`)).toEqual({ agent, secret: 'deadbeef' });
  });

  it('claims nothing for any other shape', () => {
    expect(splitKey('')).toBeUndefined();
    expect(splitKey('dgp')).toBeUndefined();
    expect(splitKey('dgp_only')).toBeUndefined();
    expect(splitKey('dgp__secret')).toBeUndefined();
    expect(splitKey('dgp_agent_')).toBeUndefined();
    expect(splitKey('xyz_agent_secret')).toBeUndefined();
  });

  it('mints ids without the character the split depends on', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = newId();
      expect(id).toHaveLength(ID_LENGTH);
      expect(id).not.toContain('_');
    }
  });
});
