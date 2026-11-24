// «Переименовать» in the header of the open conversation (owner's list 16.11): a window with the name
// the server keeps, since the header shows the agent and not the conversation. A conversation not
// started yet has no name on the server, so the window says it will come with the first message.
import { THREAD_TITLE_MAX } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchThreadName, renameThread } from '../threads/api.ts';
import styles from './chat.module.css';

const NOT_FOUND = 'APP_NOT_FOUND';

function NameForm({ threadId, name, onClose, onRenamed }: { threadId: string; name: string; onClose: () => void; onRenamed: (title: string) => void }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const clean = value.trim();
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await renameThread(threadId, clean);
      toast(ru.chat.threadRenamed);
      onRenamed(saved.thread.title);
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.dialogBody}
      onSubmit={(e) => {
        e.preventDefault();
        if (clean && clean !== name && !busy) void save();
      }}
    >
      <Field label={ru.shell.threadName}>
        <Input autoFocus maxLength={THREAD_TITLE_MAX} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.dialogActions}>
        <Button variant="secondary" onClick={onClose}>
          {ru.chat.renameCancel}
        </Button>
        <Button type="submit" variant="primary" disabled={!clean || clean === name || busy}>
          {ru.chat.renameSave}
        </Button>
      </div>
    </form>
  );
}

export function RenameThreadDialog({ threadId, onClose, onRenamed }: { threadId: string; onClose: () => void; onRenamed: (title: string) => void }) {
  const load = useCallback(() => fetchThreadName(threadId), [threadId]);
  const { state, reload } = useLoad(load);
  return (
    <Modal open onClose={onClose} label={ru.chat.renameThread} narrow>
      <div className={styles.dialog}>
        <h2 className={styles.dialogTitle}>{ru.chat.renameThread}</h2>
        {state.status === 'loading' ? <DelayedBar /> : null}
        {state.status === 'error' && state.error.code === NOT_FOUND ? (
          <>
            <Notice>{ru.chat.renameNotStarted}</Notice>
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={onClose}>
                {ru.chat.renameCancel}
              </Button>
            </div>
          </>
        ) : null}
        {state.status === 'error' && state.error.code !== NOT_FOUND ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' ? <NameForm threadId={threadId} name={state.data.thread.title} onClose={onClose} onRenamed={onRenamed} /> : null}
      </div>
    </Modal>
  );
}
