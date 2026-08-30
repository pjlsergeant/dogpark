import { expect, it } from 'vitest';

// The package exports only types so far, so this is a module-graph canary: it
// fails if NodeNext/ESM resolution breaks. It does NOT exercise the emitted
// build — Vitest resolves './index.js' back to the TypeScript source.
it('exposes a loadable entrypoint', async () => {
  await expect(import('./index.js')).resolves.toBeDefined();
});
