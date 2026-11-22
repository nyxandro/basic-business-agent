// 👍 «Хороший образец» on the block of a document the agent made (docs/specs/[20.11.2026]-feedback-and-value.md,
// scenario 3; owner 21.11, F4): the window «Сохранить как образец» with the kind of document (guessed from its name, can
// be corrected) and the base it goes to — a department of the person, or the organisation's for the one who keeps it.
// Saved — the document is in the knowledge base at once. A file saved already reads «Уже сохранён как образец»; one the
// keeper removed — «Был образцом».
import type { ExampleStateResponse } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { exampleState, saveExample } from './api.ts';
import styles from './feedback.module.css';
import genui from '../genui/genui.module.css';

const t = ru.feedback.example;
type BaseChoice = ExampleStateResponse['bases'][number];
const baseKey = (b: BaseChoice) => (b.scope === 'org' ? 'org' : b.departmentId);

function ExampleForm({ threadId, path, state, onClose, onSaved }: { threadId: string; path: string; state: ExampleStateResponse; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [docType, setDocType] = useState(state.docType);
  const [base, setBase] = useState<BaseChoice | null>(state.bases[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  async function save() {
    if (!base || !docType.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await saveExample({ threadId, path, docType: docType.trim(), base: base.scope === 'org' ? { scope: 'org' } : { scope: 'department', departmentId: base.departmentId } });
      toast(t.done);
      onSaved();
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
        if (!busy) void save();
      }}
    >
      <h2 className={styles.title}>{t.title}</h2>
      <p className={styles.note}>{t.lead}</p>
      <Field label={t.docType}>
        <Input autoFocus value={docType} maxLength={100} onChange={(e) => setDocType(e.target.value)} />
      </Field>
      {state.bases.length > 1 ? (
        <div role="group" aria-label={t.base} className={styles.bases}>
          {state.bases.map((b) => (
            <Button key={baseKey(b)} size="sm" variant={base && baseKey(base) === baseKey(b) ? 'primary' : 'secondary'} aria-pressed={base !== null && baseKey(base) === baseKey(b)} onClick={() => setBase(b)}>
              {b.name}
            </Button>
          ))}
        </div>
      ) : null}
      {base ? <p className={styles.note}>{t.into(base.name)}</p> : <p className={styles.note}>{t.noBase}</p>}
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !base || !docType.trim()}>
          {t.save}
        </Button>
      </div>
    </form>
  );
}

export function ExampleButton({ threadId, path }: { threadId: string; path: string }) {
  const [state, setState] = useState<ExampleStateResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  async function ask() {
    setAsking(true);
    setFailed(null);
    try {
      const found = await exampleState(threadId, path);
      setState(found);
      if (found.state !== 'saved') setOpen(true);
    } catch (raw) {
      setFailed(asApiError(raw).message);
    } finally {
      setAsking(false);
    }
  }
  if (state?.state === 'saved') return <span className={cx(genui.fileExample)}>{t.saved}</span>;
  return (
    <>
      <Button icon="star" size="sm" disabled={asking} aria-label={`${t.button}: ${path.split('/').pop() ?? path}`} onClick={() => void ask()}>
        {state?.state === 'removed' ? t.removed : t.button}
      </Button>
      {failed ? <p className={genui.fileNoteError}>{failed}</p> : null}
      <Modal open={open} onClose={() => setOpen(false)} label={t.title} narrow>
        {open && state ? (
          <ExampleForm
            threadId={threadId}
            path={path}
            state={state}
            onClose={() => setOpen(false)}
            onSaved={() => {
              setOpen(false);
              setState({ ...state, state: 'saved' });
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}
