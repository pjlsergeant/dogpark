/** A one-field dialog: create a space, rename an agent. Enter submits. */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Dialog } from './Dialog.js';

export function NameDialog({
  title,
  label,
  initial = '',
  submitLabel,
  hint,
  allowEmpty = false,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  hint?: ReactNode;
  allowEmpty?: boolean;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}): ReactNode {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '' && !allowEmpty) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label htmlFor="name-dialog-field">{label}</label>
        <input
          id="name-dialog-field"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
        {hint !== undefined && <p className="muted small">{hint}</p>}
        {error !== null && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || (value.trim() === '' && !allowEmpty)}
          >
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
