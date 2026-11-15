// «Недавние» (spec, sections 7 and 8.16): the newest conversations of all the person's agents, a
// background task's result marked «новое» until opened, and «Ещё» when there are more — it opens all
// of them in the window of «Поиск» (decision of the owner 15.11: a long list stretched the panel).
// Each conversation can be renamed from its three dots. A new `refreshKey` (after an answer or a new
// name) loads the list again in place: the old list stays until the new one comes, a name being typed
// stays.
import { useCallback, useState } from 'react';
import { fetchThreadPage } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './shell.module.css';
import { ThreadRow } from './ThreadRow.tsx';

// How many of the newest conversations the panel shows (decision of the owner 15.11).
export const RECENT_SHOWN = 7;

export function RecentThreads({ refreshKey, currentThreadId, onNavigate, onShowAll }: { refreshKey: number; currentThreadId: string | null; onNavigate: () => void; onShowAll: () => void }) {
  const first = useCallback(() => fetchThreadPage({ limit: RECENT_SHOWN }), []);
  const { state, reload } = useLoad(first);
  // Names saved here: shown at once, and over a list loaded before the server had them.
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [seenKey, setSeenKey] = useState(refreshKey);
  if (seenKey !== refreshKey) {
    setSeenKey(refreshKey);
    reload();
  }

  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') return <ErrorBanner title={ru.shell.recentFailed} error={state.error} onRetry={reload} />;
  const threads = state.data.threads.map((t) => ({ ...t, title: renamed[t.id] ?? t.title }));
  if (threads.length === 0) return <p className={styles.empty}>{ru.shell.recentEmpty}</p>;
  return (
    <>
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} current={t.id === currentThreadId} onNavigate={onNavigate} onRenamed={(title) => setRenamed((prev) => ({ ...prev, [t.id]: title }))} />
      ))}
      {state.data.next ? (
        <button type="button" className={styles.more} onClick={onShowAll}>
          {ru.shell.moreThreads}
        </button>
      ) : null}
    </>
  );
}
