// «Новое обращение» on «Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, F7; owner 24.11): a subject, a text
// and the files the person attaches — up to 10, 50 MB together — go to «Поддержка». Nothing of a conversation goes with it.
// On a failure what was written and attached stays.
import { COMPLAINT_MAX, SUPPORT_FILES_MAX_BYTES, SUPPORT_REQUEST_FILES_MAX, SUPPORT_SUBJECT_MAX } from '@bba/contracts';
import { useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { fileSize } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input, TextArea } from '../ui/Field.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { sendRequest } from './api.ts';
import styles from './feedback.module.css';

const t = ru.feedback.requests;

function RequestForm({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  // Files picked past the limits are not added: the person is told why.
  const [filesError, setFilesError] = useState<string | null>(null);
  const [missing, setMissing] = useState({ subject: false, text: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  function add(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const next = [...files, ...picked];
    if (next.length > SUPPORT_REQUEST_FILES_MAX) return setFilesError(t.tooMany);
    if (next.reduce((sum, f) => sum + f.size, 0) > SUPPORT_FILES_MAX_BYTES) return setFilesError(t.tooLarge);
    setFilesError(null);
    setFiles(next);
  }

  async function send() {
    const gaps = { subject: !subject.trim(), text: !text.trim() };
    setMissing(gaps);
    if (gaps.subject || gaps.text) return;
    setBusy(true);
    setError(null);
    try {
      const done = await sendRequest(subject.trim(), text.trim(), files);
      toast(t.sent(done.id));
      onSent();
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void send();
      }}
    >
      <h2 className={styles.title}>{t.create}</h2>
      <Field label={t.subject} error={missing.subject ? t.noSubject : null}>
        <Input
          autoFocus
          maxLength={SUPPORT_SUBJECT_MAX}
          value={subject}
          placeholder={t.subjectPlaceholder}
          onChange={(e) => {
            setSubject(e.target.value);
            setMissing((m) => ({ ...m, subject: false }));
          }}
        />
      </Field>
      <Field label={t.text} error={missing.text ? t.noText : null}>
        <TextArea
          rows={5}
          maxLength={COMPLAINT_MAX}
          value={text}
          placeholder={t.textPlaceholder}
          onChange={(e) => {
            setText(e.target.value);
            setMissing((m) => ({ ...m, text: false }));
          }}
        />
      </Field>
      <div className={styles.attachRow}>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label={t.attach}
          onChange={(e) => {
            add(e.currentTarget.files);
            // The same file may be picked again after it was removed.
            e.currentTarget.value = '';
          }}
        />
        <Button icon="clip" size="sm" onClick={() => picker.current?.click()}>
          {t.attach}
        </Button>
        <span className={styles.note}>{t.filesHint}</span>
      </div>
      {filesError ? (
        <p className={styles.fileError} role="alert">
          {filesError}
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className={styles.attached} aria-label={t.attached}>
          {files.map((f, i) => (
            <li key={`${i}:${f.name}`} className={styles.attachedItem}>
              <FileIcon name={f.name} size={20} />
              <span className={styles.attachedName} title={f.name}>
                {f.name}
              </span>
              <span className={styles.note}>{fileSize(f.size)}</span>
              <IconButton
                icon="x"
                size="sm"
                label={t.removeFile(f.name)}
                onClick={() => {
                  setFiles(files.filter((_, j) => j !== i));
                  setFilesError(null);
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {t.send}
        </Button>
      </div>
    </form>
  );
}

export function RequestDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: () => void }) {
  return (
    <Modal open={open} onClose={onClose} label={t.create}>
      {/* Drawn anew on each opening: a new request starts empty. */}
      {open ? <RequestForm onClose={onClose} onSent={onSent} /> : null}
    </Modal>
  );
}
