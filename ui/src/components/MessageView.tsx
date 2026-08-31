/**
 * One message, as the human reads it.
 *
 * Attribution is deliberately loud: the difference between "the human said
 * this" and "an agent claiming to be quoting the human said this" is the
 * whole safety story of the product (docs/scenarios.md, "Telling the
 * teacher"). Sender kind is a shape and a colour, not just a name.
 */
import type { ReactNode } from 'react';
import type { Attachment, Message, Sender } from '../api/index.js';
import { bytes, clockTime, absoluteTime } from '../app/format.js';
import { useApi } from '../app/api-context.js';
import { Markdown } from '../markdown/Markdown.js';

function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter((p) => p !== '');
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

function AttachmentLinks({ attachments }: { attachments: readonly Attachment[] }): ReactNode {
  const api = useApi();
  if (attachments.length === 0) return null;
  return (
    <ul className="attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {/*
            Never rendered inline — not as an image, not as a preview. The
            server sends `Content-Disposition: attachment`; this is a link to
            download, and the filename is agent-supplied metadata shown as
            text.
          */}
          <a
            className="attachment"
            href={api.attachmentHref(attachment.id)}
            download={attachment.filename}
            rel="noopener noreferrer"
          >
            <span className="attachment-icon" aria-hidden="true">
              ⤓
            </span>
            <span className="attachment-name">{attachment.filename}</span>
            <span className="attachment-meta">
              {attachment.contentType} · {bytes(attachment.sizeBytes)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function MessageView({
  message,
  highlighted = false,
  pinnedBy = [],
  humanPinned = false,
  onPin,
}: {
  message: Message;
  highlighted?: boolean;
  pinnedBy?: readonly Sender[];
  humanPinned?: boolean;
  onPin?: (() => void) | undefined;
}): ReactNode {
  const human = message.sender.kind === 'human';
  return (
    <article
      className={`message${human ? ' message-human' : ''}${highlighted ? ' message-highlighted' : ''}${pinnedBy.length > 0 ? ' message-pinned' : ''}`}
      id={`m-${message.id}`}
      aria-label={`${human ? 'You' : message.sender.displayName} at ${absoluteTime(message.sentAt)}`}
    >
      <div className={`avatar${human ? ' avatar-human' : ''}`} aria-hidden="true">
        {human ? '☺' : initials(message.sender.displayName)}
      </div>
      <div className="message-main">
        <header className="message-head">
          <span className="sender">{message.sender.displayName}</span>
          <span className={`sender-kind sender-kind-${message.sender.kind}`}>
            {human ? 'you' : 'agent'}
          </span>
          <time dateTime={message.sentAt} title={absoluteTime(message.sentAt)}>
            {clockTime(message.sentAt)}
          </time>
          {pinnedBy.length > 0 && (
            <span className="message-pin-label">
              📌 pinned by{' '}
              {pinnedBy
                .map((actor) => (actor.kind === 'human' ? 'you' : actor.displayName))
                .join(', ')}
            </span>
          )}
          {onPin !== undefined && (
            <button type="button" className="btn btn-quiet message-pin-action" onClick={onPin}>
              {humanPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
        </header>
        <Markdown source={message.body} />
        <AttachmentLinks attachments={message.attachments} />
      </div>
    </article>
  );
}
