// «Недавние» (spec, sections 7 and 8.16): 30 conversations of all the person's agents, newest first,
// a background task's result marked «новое» until opened, «Показать ещё» for the next page; each
// conversation can be renamed from its three dots.
import type { ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { fetchThreadPage } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './shell.module.css';
import { ThreadRow } from './ThreadRow.tsx';

export function RecentThreads({ currentThreadId, onNavigate }: { currentThreadId: string | null; onNavigate: () => void }) {
  const first = useCallback(() => fetchThreadPage(null), []);
  const { state, reload } = useLoad(first);
  const [more, setMore] = useState<{ threads: ThreadSummaryDto[]; next: string | null } | null>(null);
  const [moreError, setMoreError] = useState<ApiRequestError | null>(null);
  // Names saved here since the list was loaded: the list itself is not loaded again for them.
  const [renamed, setRenamed] = useState<Record<string, string>>({});

  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') return <ErrorBanner title={ru.shell.recentFailed} error={state.error} onRetry={reload} />;
  const threads = [...state.data.threads, ...(more?.threads ?? [])].map((t) => ({ ...t, title: renamed[t.id] ?? t.title }));
  const next = more ? more.next : state.data.next;

  async function showMore() {
    setMoreError(null);
    try {
      const page = await fetchThreadPage(next);
      setMore((prev) => ({ threads: [...(prev?.threads ?? []), ...page.threads], next: page.next }));
    } catch (raw) {
      setMoreError(asApiError(raw));
    }
  }

  if (threads.length === 0) return <p className={styles.empty}>{ru.shell.recentEmpty}</p>;
  return (
    <>
      {threads.map((t) => (
        <ThreadRow key={t.id} thread={t} current={t.id === currentThreadId} onNavigate={onNavigate} onRenamed={(title) => setRenamed((prev) => ({ ...prev, [t.id]: title }))} />
      ))}
      {moreError ? <ErrorBanner error={moreError} onRetry={() => void showMore()} /> : null}
      {next ? (
        <button type="button" className={styles.more} onClick={() => void showMore()}>
          {ru.shell.showMore}
        </button>
      ) : null}
    </>
  );
}
