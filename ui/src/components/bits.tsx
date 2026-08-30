/** Small shared pieces. Everything hand-rolled; no component library. */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../api/index.js';
import { absoluteTime, relativeTime } from '../app/format.js';

export function Time({ iso, prefix }: { iso: string | null; prefix?: string }): ReactNode {
  if (iso === null) return <span className="muted">never</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {prefix === undefined ? '' : `${prefix} `}
      {relativeTime(iso)}
    </time>
  );
}

export function Loading({ what }: { what: string }): ReactNode {
  return (
    <p className="loading" role="status">
      Loading {what}…
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="empty">{children}</p>;
}

export function Failure({ error, onRetry }: { error: ApiError; onRetry?: () => void }): ReactNode {
  return (
    <div className="failure" role="alert">
      <p>
        <strong>{error.code}</strong> — {error.message}
      </p>
      {error.retryAfterSeconds !== undefined && (
        <p className="muted">Retry after {error.retryAfterSeconds}s.</p>
      )}
      {onRetry !== undefined && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Text with a copy button. Used for the once-only agent key and for the
 * environment snippet beside it, which is the step most likely to go wrong
 * (docs/architecture.md, "The human surface").
 */
export function Copyable({
  value,
  label,
  multiline = false,
}: {
  value: string;
  label: string;
  multiline?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  }, [value]);

  return (
    <div className={multiline ? 'copyable copyable-block' : 'copyable'}>
      <pre>
        <code>{value}</code>
      </pre>
      <button type="button" className="btn" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** A short monospace id, full value on hover. Ids are opaque and long. */
export function Id({ value }: { value: string }): ReactNode {
  return (
    <code className="id" title={value}>
      {value}
    </code>
  );
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }): ReactNode {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/**
 * A name and a value on one line, for detail panels.
 */
export function Facts({ children }: { children: ReactNode }): ReactNode {
  return <dl className="facts">{children}</dl>;
}

export function Fact({ name, children }: { name: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}
