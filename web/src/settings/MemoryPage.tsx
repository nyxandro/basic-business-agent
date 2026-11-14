// «Моя память» (spec, scenario 6): what the agents remember about the person — read, edit, forget.
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { PageFrame } from '../layout/PageFrame.tsx';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { TextArea } from '../ui/Field.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchMemory, forgetMemory, saveMemory } from './api.ts';
import styles from './settings.module.css';

export function MemoryPage() {
  const { state, reload } = useLoad(fetchMemory);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setDraft(null);
      toast(done);
      reload();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    if (await confirm({ title: ru.memory.forgetTitle, text: ru.memory.forgetConfirm, confirmLabel: ru.memory.forget, danger: true })) void act(forgetMemory, ru.memory.forgotten);
  }

  return (
    <PageFrame title={ru.settings.memory} lead={ru.memory.hint}>
      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'ready' ? (
        <Card className={`${styles.card} rise`}>
          {draft !== null ? (
            <TextArea aria-label={ru.memory.edit} rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
          ) : state.data.empty ? (
            <EmptyState title={ru.memory.empty} text={ru.memory.emptyHint} />
          ) : (
            <div className={styles.memory}>{state.data.text}</div>
          )}
          <div className={styles.actions}>
            {draft !== null ? (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
                  {ru.memory.cancel}
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => void act(() => saveMemory(draft), ru.memory.saved)}>
                  {ru.memory.save}
                </Button>
              </>
            ) : (
              <>
                {!state.data.empty ? (
                  <Button variant="danger" icon="trash" disabled={busy} onClick={() => void forget()}>
                    {ru.memory.forget}
                  </Button>
                ) : null}
                <Button variant="secondary" icon="edit" disabled={busy} onClick={() => setDraft(state.data.text)}>
                  {ru.memory.edit}
                </Button>
              </>
            )}
          </div>
        </Card>
      ) : null}
    </PageFrame>
  );
}
