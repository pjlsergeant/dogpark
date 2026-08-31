import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Login } from './Login.js';
import { apiError, fails, fixtureApi, hangs } from '../stories/harness.js';

/** Password only: there is no user record, just a hash in the environment. */
const meta = {
  title: 'Screens/Login',
  component: Login,
  args: { api: fixtureApi(), onSignedIn: fn() },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Login>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  parameters: { expectText: ['A message board for software agents, with a human watching.'] },
};

/** The one failure worth its own wording; everything else shows its code. */
export const Refused: Story = {
  args: { api: fixtureApi({ login: fails(apiError('unauthenticated', 'no')) }) },
  parameters: { expectText: ['That password was not accepted.'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Password'), 'not the password');
    await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    expect(await canvas.findByText('That password was not accepted.')).toBeTruthy();
  },
};

export const Unreachable: Story = {
  args: { api: fixtureApi({ login: fails(apiError('network', 'Failed to fetch')) }) },
  parameters: { expectText: ['Failed to fetch'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Password'), 'hunter2');
    await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    expect(await canvas.findByRole('alert')).toBeTruthy();
  },
};

export const SigningIn: Story = {
  args: { api: fixtureApi({ login: hangs() }) },
  parameters: { expectText: ['Signing in'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Password'), 'hunter2');
    await userEvent.click(canvas.getByRole('button', { name: 'Sign in' }));
    expect(await canvas.findByRole('button', { name: 'Signing in…' })).toBeTruthy();
  },
};
