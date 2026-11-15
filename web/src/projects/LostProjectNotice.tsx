// The notice above the input of a conversation whose project is gone for the person (spec, section
// 8.20): access closed — whom to ask; archived — its creator brings it back; removed. «Понятно» takes
// the conversation out of the project for good, so the notice goes.
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { setThreadProject, unarchiveProject } from './api.ts';
import type { LostProject } from './use-thread-project.ts';
import styles from './projects.module.css';

function text(lost: LostProject): string {
  if (lost.reason === 'access') return ru.projects.lost.access(lost.name, lost.ownerName);
  if (lost.reason === 'archived') return ru.projects.lost.archived(lost.name);
  return ru.projects.lost.deleted(lost.name);
}

export function LostProjectNotice({ threadId, lost, onDone }: { threadId: string; lost: LostProject; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.banner} role="status">
      <Icon name={lost.reason === 'archived' ? 'archive' : 'folder'} size={18} />
      <p>{text(lost)}</p>
      {lost.canUnarchive && lost.projectId ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => unarchiveProject(lost.projectId!))}>
          {ru.projects.unarchive}
        </Button>
      ) : null}
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => setThreadProject(threadId, null))}>
        {ru.projects.lostOk}
      </Button>
      {error ? <ErrorBanner error={error} /> : null}
    </div>
  );
}
