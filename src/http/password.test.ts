import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_PASSWORD_HASH, hashPassword, readSecret, verifyPassword } from './password.js';

function sink(): { write: (text: string) => void; text: string } {
  const out = { text: '', write: (text: string) => void (out.text += text) };
  return out;
}

describe('readSecret', () => {
  it('takes a piped password whole, minus its trailing newline', async () => {
    const input = new PassThrough();
    input.end('correct horse_battery staple\n');
    const out = sink();
    expect(await readSecret(input, out)).toBe('correct horse_battery staple');
    expect(out.text).toBe('');
  });

  it('keeps a piped password that has no newline, and inner ones', async () => {
    const input = new PassThrough();
    input.write('two\n');
    input.end('lines');
    expect(await readSecret(input, sink())).toBe('two\nlines');
  });

  it('prompts a terminal with echo off and reads to Enter', async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      raw: [] as boolean[],
      setRawMode(mode: boolean) {
        this.raw.push(mode);
        return this;
      },
    });
    const out = sink();
    const pending = readSecret(input, out);
    input.write('se');
    input.write('x\u007f');
    input.write('cret\r');
    input.write('never read');
    expect(await pending).toBe('secret');
    expect(input.raw).toEqual([true, false]);
    expect(out.text).toBe('Password: \n');
  });

  it('is abandoned by Ctrl-C', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const pending = readSecret(input, sink());
    input.write('se\u0003');
    await expect(pending).rejects.toThrow(/interrupted/);
  });
});

describe('the hash round-trips', () => {
  it('verifies what it minted and nothing else', async () => {
    const hash = hashPassword('a password');
    await expect(verifyPassword(hash, 'a password')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'a passwor')).resolves.toBe(false);
  });
});

describe('the README example hash', () => {
  // Keeps the constant and the password the README prints honest: if the two
  // ever drift, the one-command `docker run` stops logging in.
  it('is the hash of the password `dogpark` the README prints', async () => {
    await expect(verifyPassword(EXAMPLE_PASSWORD_HASH, 'dogpark')).resolves.toBe(true);
  });
});
