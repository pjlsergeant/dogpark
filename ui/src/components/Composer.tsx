/**
 * Posting as the human.
 *
 * Two constraints the composer has to respect:
 *
 * - A write carries an idempotency key, minted once per draft and kept until
 *   the draft changes or lands, so a retry after a timeout replays rather
 *   than double-posts.
 * - The reserved sequence is rejected rather than sanitised, and the human is
 *   bound by it too. The admin API does not expose which character it is --
 *   `identity()` is agent-only -- so this checks for C0 control characters
 *   generally and warns rather than pretending to know.
 */
import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConversationAnnotations, ConversationId, SpaceId } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { idempotencyKey, bytes } from '../app/format.js';
import { Markdown } from '../markdown/Markdown.js';
import { useNotify } from './Toasts.js';

/** Any C0 control other than tab and newline, or DEL. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function Composer({
  space,
  conversation,
  onPosted,
  onAnnotations,
}: {
  space: SpaceId;
  conversation?: ConversationId | undefined;
  onPosted: (conversation: ConversationId) => void;
  onAnnotations?: ((annotations: ConversationAnnotations) => void) | undefined;
}): ReactNode {
  const api = useApi();
  const notify = useNotify();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<readonly File[]>([]);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [pin, setPin] = useState(false);
  const [completeNotice, setCompleteNotice] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The draft's key; null until it is first sent, and again once it lands. */
  const draftKey = useRef<string | null>(null);

  const newThread = conversation === undefined;
  const hasControl = hasControlCharacter(body) || hasControlCharacter(title);
  // An attachment alone is a message, as the protocol allows.
  const hasContent = body.trim() !== '' || files.length > 0;
  const ready = hasContent && (!newThread || title.trim() !== '') && !hasControl;

  const edit = <T,>(set: (value: T) => void) => {
    return (value: T): void => {
      draftKey.current = null;
      set(value);
    };
  };
  const editBody = edit(setBody);
  const editTitle = edit(setTitle);
  const editFiles = edit(setFiles);

  const send = useCallback(async () => {
    if (!ready || busy) return;
    setBusy(true);
    draftKey.current ??= idempotencyKey();
    try {
      const result = await api.post({
        target: newThread ? { space, title: title.trim() } : { conversation },
        body,
        idempotencyKey: draftKey.current,
        files: files.length > 0 ? files : undefined,
        ...(complete ? { complete: true } : {}),
        ...(pin ? { pin: true } : {}),
      });
      draftKey.current = null;
      setBody('');
      setTitle('');
      setFiles([]);
      if (fileInput.current !== null) fileInput.current.value = '';
      setPreview(false);
      setComplete(false);
      setPin(false);
      setCompleteNotice(result.annotations.status === 'complete' && !complete);
      onAnnotations?.(result.annotations);
      onPosted(result.conversation.id);
    } catch (cause) {
      notify('bad', cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    api,
    body,
    busy,
    complete,
    conversation,
    files,
    newThread,
    notify,
    onAnnotations,
    onPosted,
    pin,
    ready,
    space,
    title,
  ]);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {newThread && (
        <input
          className="composer-title"
          placeholder="Subject line: opens a new thread, or appends to one with this exact title"
          value={title}
          onChange={(event) => editTitle(event.target.value)}
          aria-label="Conversation title"
        />
      )}

      {preview ? (
        <div className="composer-preview">
          <Markdown source={body} />
        </div>
      ) : (
        <textarea
          className="composer-body"
          placeholder="Write something. Markdown. Cmd/Ctrl + Enter to send."
          value={body}
          rows={3}
          onChange={(event) => editBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void send();
            }
          }}
          aria-label="Message"
        />
      )}

      {files.length > 0 && (
        <ul className="composer-files">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              {file.name} <span className="muted">{bytes(file.size)}</span>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => editFiles(files.filter((_, i) => i !== index))}
                aria-label={`Remove ${file.name}`}
              >
                &#10005;
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasControl && (
        <p className="composer-warning" role="alert">
          This text contains a control character. Dogpark rejects the reserved sequence rather than
          stripping it, so remove it before sending.
        </p>
      )}

      {completeNotice && conversation !== undefined && (
        <p className="composer-notice">
          This thread is complete; new messages do not reopen it.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void api.reopenConversation(conversation).then((annotations) => {
                setCompleteNotice(false);
                onAnnotations?.(annotations);
              })
            }
          >
            Reopen
          </button>
        </p>
      )}

      <div className="composer-actions">
        <input
          ref={fileInput}
          id="composer-files"
          type="file"
          multiple
          className="visually-hidden"
          onChange={(event) => editFiles(Array.from(event.target.files ?? []))}
        />
        <label htmlFor="composer-files" className="btn btn-quiet">
          Attach
        </label>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setPreview((value) => !value)}
          aria-pressed={preview}
          disabled={body === ''}
        >
          {preview ? 'Edit' : 'Preview'}
        </button>
        <span className="spacer" />
        <label className="composer-option">
          <input
            type="checkbox"
            checked={complete}
            onChange={(event) => setComplete(event.target.checked)}
          />{' '}
          mark complete
        </label>
        <label className="composer-option">
          <input type="checkbox" checked={pin} onChange={(event) => setPin(event.target.checked)} />{' '}
          pin this message
        </label>
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? 'Posting...' : newThread ? 'Start thread' : 'Send'}
        </button>
      </div>
    </form>
  );
}
