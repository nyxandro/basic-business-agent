// Conversations with the agent (spec, section 7): newest first, a background task's conversation
// marked «новое» until opened, deletion with a question first.
import type { ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { deleteThread, fetchThreads } from './api.ts';

export function ThreadList({ agentId, currentThreadId, refreshKey, onNew, onDeleted }: { agentId: string; currentThreadId: string; refreshKey: number; onNew: () => void; onDeleted: (threadId: string) => void }) {
  const load = useCallback(() => fetchThreads(agentId), [agentId]);
  const { state, reload } = useLoad(load);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);

  useEffect(() => {
    if (refreshKey > 0) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on a new refresh signal only
  }, [refreshKey]);

  async function remove(thread: ThreadSummaryDto) {
    if (!window.confirm(ru.chat.deleteConfirm)) return;
    setError(null);
    try {
      await deleteThread(thread.id);
      setNotice(ru.chat.threadDeleted);
      onDeleted(thread.id);
      reload();
    } catch (raw) {
      setError(asApiError(raw));
    }
  }

  return (
    <aside className="threads">
      <button type="button" onClick={onNew}>
        {ru.chat.newThread}
      </button>
      <h2>{ru.chat.threadsTitle}</h2>
      {notice ? <p className="banner banner-ok">{notice}</p> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.threads.length === 0 ? <p className="empty">{ru.chat.threadsEmpty}</p> : null}
      {state.status === 'ready' ? (
        <ul>
          {state.data.threads.map((t) => (
            <li key={t.id} className={t.id === currentThreadId ? 'current' : undefined}>
              <Link to={`?thread=${encodeURIComponent(t.id)}`}>
                {t.title}
                {t.unread ? <span className="badge">{ru.chat.unread}</span> : null}
              </Link>
              <button type="button" className="link-button" aria-label={`${ru.chat.deleteThread}: ${t.title}`} onClick={() => void remove(t)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
