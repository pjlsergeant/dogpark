import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the story tests need a DOM and nothing else does.
 *
 * The server's tests and the two UI tests that render to a string keep the
 * node environment they have always had; only `ui/test` gets jsdom, and only
 * it loads the Storybook project annotations.
 */
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          root,
          include: ['src/**/*.test.ts', 'ui/src/**/*.test.ts', 'ui/src/**/*.test.tsx'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'stories',
          root,
          include: ['ui/test/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['ui/test/setup.ts'],
        },
      },
    ],
  },
});
