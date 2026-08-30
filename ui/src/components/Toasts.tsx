/** Transient confirmations and failures. Announced politely to a screen reader. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type Tone = 'ok' | 'bad';

interface Toast {
  readonly id: number;
  readonly tone: Tone;
  readonly text: string;
}

const ToastContext = createContext<((tone: Tone, text: string) => void) | null>(null);

export function useNotify(): (tone: Tone, text: string) => void {
  const notify = useContext(ToastContext);
  if (notify === null) throw new Error('useNotify outside the provider');
  return notify;
}

export function ToastHost({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((tone: Tone, text: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, tone, text }]);
    window.setTimeout(
      () => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      },
      tone === 'bad' ? 9000 : 4000,
    );
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            className={`toast toast-${toast.tone}`}
            onClick={() => dismiss(toast.id)}
            title="Dismiss"
          >
            {toast.text}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
