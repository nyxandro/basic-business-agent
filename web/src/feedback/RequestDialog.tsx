// «Новое обращение» on «Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, F7, F9; owner 24.11): a subject, and
// the text with the files the person attaches — up to 10, 50 MB together — as the first message of a ticket's
// conversation. Nothing of a chat with an agent goes with it. On a failure what was written and attached stays.
import { COMPLAINT_MAX, SUPPORT_SUBJECT_MAX } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input, TextArea } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { sendRequest } from './api.ts';
import { AttachPicker, useAttached } from './TicketChat.tsx';
import styles from './feedback.module.css';

const t = ru.feedback.requests;

function RequestForm({ onClose, onSent }: { onClose: () => void; onSent: (id: string) => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const attached = useAttached();
  const [missing, setMissing] = useState({ subject: false, text: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  async function send() {
    const gaps = { subject: !subject.trim(), text: !text.trim() };
    setMissing(gaps);
    if (gaps.subject || gaps.text) return;
    setBusy(true);
    setError(null);
    try {
      const done = await sendRequest(subject.trim(), text.trim(), attached.files);
      toast(t.sent(done.id));
      onSent(done.id);
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
      <AttachPicker attached={attached} />
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

// `onSent` — the number of the ticket made: the page opens its conversation.
export function RequestDialog({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (id: string) => void }) {
  return (
    <Modal open={open} onClose={onClose} label={t.create}>
      {/* Drawn anew on each opening: a new request starts empty. */}
      {open ? <RequestForm onClose={onClose} onSent={onSent} /> : null}
    </Modal>
  );
}
