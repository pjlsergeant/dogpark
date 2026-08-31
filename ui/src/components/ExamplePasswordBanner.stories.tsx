import type { Meta, StoryObj } from '@storybook/react-vite';
import { ExamplePasswordBanner } from './ExamplePasswordBanner.js';

/**
 * The warning bar the shell keeps up while the server runs on the README's
 * example password. Not dismissible, by design.
 */
const meta = {
  title: 'Components/ExamplePasswordBanner',
  component: ExamplePasswordBanner,
} satisfies Meta<typeof ExamplePasswordBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Warning: Story = {
  parameters: {
    expectText: [
      'This Dogpark is using the example password from the README.',
      'the README says how.',
    ],
  },
};
