// «Пожаловаться» under an answer (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 1): «Что было не так?», the
// warning that the whole conversation and its files go with it, «Отправить в поддержку». A complaint about the same
// answer already made is said so, and the new text is added to it. On a failure the text stays.
import type { ComplaintStateResponse } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, TextArea } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { complain, complaintState } from './api.ts';
import styles from './feedback.module.css';

const t = ru.feedback.complaint;

function ComplainForm({ threadId, turn, onClose }: { threadId: string; turn: number; onClose: () => void }) {
  const toast = useToast();
  const [before, setBefore] = useState<ComplaintStateResponse | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let live = true;
    complaintState(threadId, turn).then(
      (state) => live && setBefore(state),
      (raw: unknown) => live && (setError(asApiError(raw)), setBefore({ ticket: null })),
    );
    return () => {
      live = false;
    };
  }, [threadId, turn]);

  async function send() {
    if (!text.trim()) return setEmpty(true);
    setBusy(true);
    setError(null);
    try {
      const done = await complain(threadId, turn, text.trim());
      toast(done.appended ? t.appended(done.id) : t.sent(done.id));
      onClose();
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }

  if (!before) return <DelayedBar />;
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void send();
      }}
    >
      <h2 className={styles.title}>{t.title}</h2>
      {before.ticket ? <p className={styles.note}>{t.already(before.ticket.id)}</p> : null}
      <Field label={t.field} error={empty ? t.empty : null}>
        <TextArea
          autoFocus
          rows={4}
          maxLength={4000}
          value={text}
          placeholder={t.placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setEmpty(false);
          }}
        />
      </Field>
      <p className={styles.note}>{t.warning}</p>
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {before.ticket ? t.append : t.send}
        </Button>
      </div>
    </form>
  );
}

export function ComplainDialog({ open, threadId, turn, onClose }: { open: boolean; threadId: string; turn: number; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} label={t.title} narrow>
      {/* Drawn anew on each opening: the state of the complaint is asked again. */}
      {open ? <ComplainForm threadId={threadId} turn={turn} onClose={onClose} /> : null}
    </Modal>
  );
}
