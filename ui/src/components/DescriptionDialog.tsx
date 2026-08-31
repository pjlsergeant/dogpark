import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Space, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { idempotencyKey } from '../app/format.js';
import { Dialog } from './Dialog.js';
import { useNotify } from './Toasts.js';

export const maxDescriptionChars = 1000;
export type DescriptionKind = 'space' | 'agent' | 'membership';

const labels: Record<DescriptionKind, string> = {
  space: 'Space',
  agent: 'Agent',
  membership: 'Membership note',
};

/**
 * The prefill names the subject for agent and membership edits, because the
 * message lands in a space where "the description" alone is ambiguous; a
 * space's own description is not.
 */
function announcement(kind: DescriptionKind, subjectName: string, text: string): string {
  const what =
    kind === 'space'
      ? 'Space description'
      : kind === 'agent'
        ? `Description of ${subjectName}`
        : `Membership note for ${subjectName}`;
  return text === '' ? `${what} cleared.` : `${what} updated: ${text}`;
}

export function DescriptionDialog({
  kind,
  subjectName,
  initial = '',
  spaces,
  onSave,
  onClose,
}: {
  kind: DescriptionKind;
  subjectName: string;
  initial?: string | undefined;
  spaces: readonly Space[];
  onSave: (description: string) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const api = useApi();
  const notify = useNotify();
  const [value, setValue] = useState(initial);
  const [announce, setAnnounce] = useState(false);
  const [message, setMessage] = useState(announcement(kind, subjectName, initial));
  const [selected, setSelected] = useState<ReadonlySet<SpaceId>>(
    () => new Set(spaces.map((space) => space.id)),
  );
  const [messageEdited, setMessageEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateValue(next: string): void {
    setValue(next);
    if (!messageEdited) setMessage(announcement(kind, subjectName, next));
  }

  async function save(description: string): Promise<void> {
    if (description.length > maxDescriptionChars || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(description);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return;
    }

    if (announce && message.trim() !== '') {
      const announcementBody = messageEdited
        ? message
        : announcement(kind, subjectName, description);
      for (const target of spaces.filter((space) => selected.has(space.id))) {
        try {
          await api.post({
            target: { space: target.id, title: 'Announcements' },
            body: announcementBody,
            idempotencyKey: idempotencyKey(),
          });
        } catch (cause) {
          notify(
            'bad',
            `Description saved, but announcing in ${target.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }
    onClose();
  }

  return (
    <Dialog title={`Edit ${labels[kind].toLowerCase()} for “${subjectName}”`} onClose={onClose}>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void save(value);
        }}
      >
        <label htmlFor="description-dialog-field">Description</label>
        <textarea
          id="description-dialog-field"
          rows={6}
          value={value}
          maxLength={maxDescriptionChars + 1}
          disabled={busy}
          onChange={(event) => updateValue(event.target.value)}
        />
        <p
          className={
            value.length > maxDescriptionChars ? 'description-count over' : 'description-count'
          }
        >
          {value.length} / {maxDescriptionChars}
        </p>

        <div className="announce-section">
          <label className="check">
            <input
              type="checkbox"
              checked={announce}
              disabled={busy}
              onChange={(event) => setAnnounce(event.target.checked)}
            />
            Announce this change
          </label>
          {announce && (
            <>
              <label htmlFor="description-announcement">Message</label>
              <textarea
                id="description-announcement"
                rows={4}
                value={message}
                disabled={busy}
                onChange={(event) => {
                  setMessage(event.target.value);
                  setMessageEdited(true);
                }}
              />
              {kind === 'agent' && (
                <fieldset className="space-checks">
                  <legend>Post in</legend>
                  {spaces.length === 0 ? (
                    <p className="muted small">This agent is not currently in any spaces.</p>
                  ) : (
                    spaces.map((space) => (
                      <label className="check" key={space.id}>
                        <input
                          type="checkbox"
                          checked={selected.has(space.id)}
                          disabled={busy}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(space.id);
                            else next.delete(space.id);
                            setSelected(next);
                          }}
                        />
                        {space.name}
                      </label>
                    ))
                  )}
                </fieldset>
              )}
            </>
          )}
        </div>

        {error !== null && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions description-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || initial === ''}
            onClick={() => void save('')}
          >
            Clear
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || value.length > maxDescriptionChars}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
