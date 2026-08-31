/**
 * The look book: every component and screen in the states it is meant to have,
 * so the design can be looked at rather than reasoned about.
 *
 * Stories sit beside their components under `ui/src`, which is what
 * `ui/tsconfig.json` already typechecks. Storybook owns the root, the plugins
 * and the build; what it borrows from `ui/vite.config.ts` is how that config
 * resolves and defines things, so an alias added for the app is an alias the
 * stories get too.
 */
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import { loadConfigFromFile, mergeConfig } from 'vite';

const UI_VITE_CONFIG = fileURLToPath(new URL('../ui/vite.config.ts', import.meta.url));

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../ui/src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs'],
  core: { disableTelemetry: true },
  async viteFinal(storybookConfig) {
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      UI_VITE_CONFIG,
    );
    if (loaded === null) return storybookConfig;
    const { resolve, define, css, assetsInclude } = loaded.config;
    return mergeConfig(storybookConfig, { resolve, define, css, assetsInclude });
  },
};

export default config;
