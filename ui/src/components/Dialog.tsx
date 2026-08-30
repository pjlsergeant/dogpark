/**
 * A modal, hand-rolled on `<dialog>`: focus goes into it, Escape closes it,
 * and the page behind it is inert. No component library, so the keyboard
 * behaviour is written down rather than assumed.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (!element.open) element.showModal();
    const first = element.querySelector<HTMLElement>(
      'input, textarea, select, button:not(.dialog-close)',
    );
    first?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicking the backdrop — the dialog element itself — closes it.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
