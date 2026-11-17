// «Моя память» (spec, section 8.26): what the agents remember about the person, entry by entry — add, change,
// remove; «Забыть всё» after a question.
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { PageFrame } from '../layout/PageFrame.tsx';
import { forgetMemory } from '../memory/api.ts';
import { MemoryEntries } from '../memory/MemoryEntries.tsx';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { useToast } from '../ui/Toast.tsx';
import styles from './settings.module.css';

function Forget({ reload }: { reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  async function forget() {
    if (!(await confirm({ title: ru.memory.forgetTitle, text: ru.memory.forgetConfirm, confirmLabel: ru.memory.forget, danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      await forgetMemory();
      toast(ru.memory.forgotten);
      reload();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="danger" icon="trash" disabled={busy} onClick={() => void forget()}>
          {ru.memory.forget}
        </Button>
      </div>
    </>
  );
}

export function MemoryPage() {
  return (
    <PageFrame title={ru.settings.memory} lead={ru.memory.hint}>
      <Card className={`${styles.card} rise`}>
        <MemoryEntries
          hint={ru.memory.emptyHint}
          empty={ru.memory.empty}
          failed={ru.memory.personalFailed}
          footer={(list, reload) => (list.entries.length > 0 ? <Forget reload={reload} /> : null)}
        />
      </Card>
    </PageFrame>
  );
}
