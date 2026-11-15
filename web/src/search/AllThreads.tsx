// All the person's conversations in the window of «Поиск» while no query is typed (decision of the
// owner 15.11; «Ещё» under «Недавние» opens it): newest first, the next page as soon as the end of the
// list comes into view — «Показать ещё» does the same from the keyboard; «В проекте» keeps those of
// one project. The parent gives a new `key` for another project: its pages start anew.
import type { ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { fetchThreadPage, THREAD_PAGE } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { threadPath } from '../layout/ThreadRow.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './search.module.css';
import { ThreadResult } from './ThreadResult.tsx';

interface Pages {
  threads: ThreadSummaryDto[];
  next: string | null;
}

export function AllThreads({ projectId, wide, projectName, onPick }: { projectId: string | null; wide: boolean; projectName: (id: string | null) => string; onPick: (path: string) => void }) {
  const first = useCallback(() => fetchThreadPage({ limit: THREAD_PAGE, projectId }), [projectId]);
  const { state, reload } = useLoad(first);
  const [more, setMore] = useState<Pages | null>(null);
  const [moreError, setMoreError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  // The end of the list may come into view again before the page asked for has come.
  const asking = useRef(false);
  const end = useRef<HTMLButtonElement>(null);
  const next = more ? more.next : state.status === 'ready' ? state.data.next : null;

  const showMore = useCallback(async () => {
    if (!next || asking.current) return;
    asking.current = true;
    setBusy(true);
    setMoreError(null);
    try {
      const page = await fetchThreadPage({ limit: THREAD_PAGE, before: next, projectId });
      setMore((prev) => ({ threads: [...(prev?.threads ?? []), ...page.threads], next: page.next }));
    } catch (raw) {
      setMoreError(asApiError(raw));
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }, [next, projectId]);

  // A page that does not fill the window keeps the end in view: the next one is asked at once.
  useEffect(() => {
    const el = end.current;
    if (!el || moreError) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void showMore();
    });
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [showMore, moreError]);

  if (state.status === 'loading') {
    return (
      <p className={styles.hint} role="status">
        <span className={styles.spin} />
        {ru.search.loadingThreads}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.error}>
        <ErrorBanner title={ru.shell.recentFailed} error={state.error} onRetry={reload} />
      </div>
    );
  }
  const threads = [...state.data.threads, ...(more?.threads ?? [])];
  if (threads.length === 0) {
    return (
      <div className={styles.nothing}>
        <div className={styles.nothingTitle}>{ru.shell.recentEmpty}</div>
      </div>
    );
  }
  return (
    <>
      <div className={styles.group}>{ru.search.threads}</div>
      {threads.map((t) => (
        <ThreadResult key={t.id} thread={t} projectName={projectName(t.projectId)} wide={wide} onOpen={() => onPick(threadPath(t))} />
      ))}
      {moreError ? (
        <div className={styles.error}>
          <ErrorBanner error={moreError} onRetry={() => void showMore()} />
        </div>
      ) : next ? (
        <button ref={end} type="button" className={styles.more} disabled={busy} onClick={() => void showMore()}>
          {busy ? <span className={styles.spin} /> : null}
          {ru.search.more}
        </button>
      ) : null}
    </>
  );
}
