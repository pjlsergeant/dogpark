// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SpaceId } from '../api/index.js';
import { AppProvider } from '../app/api-context.js';
import { ToastHost } from './Toasts.js';
import { fixtureApi } from '../stories/harness.js';
import { DescriptionDialog } from './DescriptionDialog.js';

const one = { id: 'sp_one' as SpaceId, name: 'one' };
const two = { id: 'sp_two' as SpaceId, name: 'two' };

HTMLDialogElement.prototype.showModal = function showModal(): void {
  this.open = true;
};
afterEach(cleanup);

function setup(options: {
  kind?: 'space' | 'agent';
  initial?: string;
  onSave?: (description: string) => Promise<void>;
}) {
  const post = vi.fn(() => Promise.resolve({} as never));
  const api = fixtureApi({ post });
  const onSave = options.onSave ?? vi.fn(() => Promise.resolve());
  render(
    <AppProvider value={{ api, session: { displayName: 'pete' }, logout: () => {} }}>
      <ToastHost>
        <DescriptionDialog
          kind={options.kind ?? 'agent'}
          subjectName="dp1"
          initial={options.initial ?? ''}
          spaces={[one, two]}
          onSave={onSave}
          onClose={() => {}}
        />
      </ToastHost>
    </AppProvider>,
  );
  return { post, onSave };
}

describe('DescriptionDialog', () => {
  test('announces once to each checked space and skips an unchecked space', async () => {
    const { post } = setup({});
    await userEvent.type(screen.getByLabelText('Description'), 'Coordinates releases');
    await userEvent.click(screen.getByLabelText('Announce this change'));
    await userEvent.click(screen.getByLabelText('two'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { space: one.id, title: 'Announcements' },
        body: 'Description of dp1 updated: Coordinates releases',
      }),
    );
  });

  test('does not post when announce is unchecked', async () => {
    const { post } = setup({ kind: 'space' });
    await userEvent.type(screen.getByLabelText('Description'), 'Production delivery');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(post).not.toHaveBeenCalled();
  });

  test('clear saves an empty description', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    setup({ initial: 'Old description', onSave });
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSave).toHaveBeenCalledWith('');
  });
});
