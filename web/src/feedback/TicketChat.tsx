// The parts of a ticket's conversation (docs/specs/[20.11.2026]-feedback-and-value.md, F9; owner 24.11): the messages of
// both sides with their files, the field to write with «Прикрепить файлы», and the picker of files shared with
// «Новое обращение». Each page — the employee's and the support's — gives whose side is «mine» and where a file downloads.
import { SUPPORT_FILES_MAX_BYTES, SUPPORT_REQUEST_FILES_MAX, type SupportMessageDto, type SupportSide, type SupportStatus } from '@bba/contracts';
import { useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { dateTime, fileSize } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { Button, ButtonLink, cx, IconButton } from '../ui/Button.tsx';
import type { Tone } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, TextArea } from '../ui/Field.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import styles from './feedback.module.css';

const t = ru.feedback.ticket;
const TEXT_MAX = 4000;

// The colour of a state for each side: what waits for this side stands out.
export const STATUS_TONE: Record<SupportSide, Record<SupportStatus, Tone>> = {
  employee: { open: 'neutral', answered: 'accent', resolved: 'ok', rejected: 'neutral' },
  support: { open: 'accent', answered: 'warn', resolved: 'ok', rejected: 'neutral' },
};

// Files picked for one message: up to 10, 50 MB together; files picked past the limits are not added, and the person is
// told why.
export function useAttached() {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  function add(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const next = [...files, ...picked];
    if (next.length > SUPPORT_REQUEST_FILES_MAX) return setError(t.tooMany);
    if (next.reduce((sum, f) => sum + f.size, 0) > SUPPORT_FILES_MAX_BYTES) return setError(t.tooLarge);
    setError(null);
    setFiles(next);
  }
  function remove(index: number) {
    setFiles(files.filter((_, i) => i !== index));
    setError(null);
  }
  return { files, error, add, remove, clear: () => setFiles([]) };
}

export function AttachPicker({ attached }: { attached: ReturnType<typeof useAttached> }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className={styles.attachRow}>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label={t.attach}
          onChange={(e) => {
            attached.add(e.currentTarget.files);
            // The same file may be picked again after it was removed.
            e.currentTarget.value = '';
          }}
        />
        <Button icon="clip" size="sm" onClick={() => picker.current?.click()}>
          {t.attach}
        </Button>
        <span className={styles.note}>{t.filesHint}</span>
      </div>
      {attached.error ? (
        <p className={styles.fileError} role="alert">
          {attached.error}
        </p>
      ) : null}
      {attached.files.length > 0 ? (
        <ul className={styles.attached} aria-label={t.attached}>
          {attached.files.map((f, i) => (
            <li key={`${i}:${f.name}`} className={styles.attachedItem}>
              <FileIcon name={f.name} size={20} />
              <span className={styles.attachedName} title={f.name}>
                {f.name}
              </span>
              <span className={styles.note}>{fileSize(f.size)}</span>
              <IconButton icon="x" size="sm" label={t.removeFile(f.name)} onClick={() => attached.remove(i)} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

// `mine` — the side of the page's person: its messages stand on the right. `nameOf` — how the author of a message is
// written on this page. `fileUrl` — where a file of the ticket downloads for this page.
export function TicketMessages({ messages, mine, nameOf, fileUrl }: { messages: readonly SupportMessageDto[]; mine: SupportSide; nameOf: (m: SupportMessageDto) => string; fileUrl: (ord: number) => string }) {
  return (
    <ol className={styles.thread} aria-label={t.conversation}>
      {messages.map((m) => (
        <li key={m.id} className={cx(styles.message, m.side === mine && styles.mine)}>
          <span className={styles.who}>
            {nameOf(m)} · {dateTime(m.at)}
          </span>
          {m.text}
          {m.files.length > 0 ? (
            <ul className={styles.messageFiles}>
              {m.files.map((f) => (
                <li key={f.ord}>
                  <ButtonLink href={fileUrl(f.ord)} download={f.name} icon="download" size="sm" variant="ghost" aria-label={t.downloadFile(f.name)}>
                    {f.name}
                    {f.size === null ? '' : ` · ${fileSize(f.size)}`}
                  </ButtonLink>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// The field to write a message: what was written and attached stays when sending fails.
export function TicketComposer({ onSend, hint }: { onSend: (text: string, files: readonly File[]) => Promise<void>; hint?: string }) {
  const [text, setText] = useState('');
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const attached = useAttached();
  async function send() {
    if (!text.trim()) return setEmpty(true);
    setBusy(true);
    setError(null);
    try {
      await onSend(text.trim(), attached.files);
      setText('');
      attached.clear();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void send();
      }}
    >
      <Field label={t.write} error={empty ? t.noText : null} hint={hint}>
        <TextArea
          rows={3}
          maxLength={TEXT_MAX}
          value={text}
          placeholder={t.writePlaceholder}
          onChange={(e) => {
            setText(e.target.value);
            setEmpty(false);
          }}
        />
      </Field>
      <AttachPicker attached={attached} />
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {t.send}
        </Button>
      </div>
    </form>
  );
}
