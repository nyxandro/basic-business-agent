// «Недавние» (spec, section 7): 30 conversations of all the person's agents, newest first, a
// background task's result marked «новое» until opened, «Показать ещё» for the next page.
import type { ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { fetchThreadPage } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './shell.module.css';

export const threadPath = (t: Pick<ThreadSummaryDto, 'agentId' | 'id'>) => `/agents/${encodeURIComponent(t.agentId)}?thread=${encodeURIComponent(t.id)}`;

export function RecentThreads({ currentThreadId, onNavigate }: { currentThreadId: string | null; onNavigate: () => void }) {
  const first = useCallback(() => fetchThreadPage(null), []);
  const { state, reload } = useLoad(first);
  const [more, setMore] = useState<{ threads: ThreadSummaryDto[]; next: string | null } | null>(null);
  const [moreError, setMoreError] = useState<ApiRequestError | null>(null);

  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') return <ErrorBanner title={ru.shell.recentFailed} error={state.error} onRetry={reload} />;
  const threads = [...state.data.threads, ...(more?.threads ?? [])];
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
        <Link key={t.id} to={threadPath(t)} onClick={onNavigate} className={cx(styles.item, t.id === currentThreadId && styles.itemCurrent)} aria-current={t.id === currentThreadId ? 'page' : undefined}>
          <span className={styles.itemText}>{t.title}</span>
          {t.unread ? <span className={styles.newPill}>{ru.chat.unread}</span> : null}
        </Link>
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
