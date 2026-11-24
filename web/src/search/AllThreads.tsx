// All the person's conversations in the window of «Поиск» while no query is typed (decision of the
// owner 15.11; «Ещё» under «Недавние» opens it): newest first, the next page as soon as the end of the
// list comes into view — «Показать ещё» does the same from the keyboard.
import type { ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { fetchThreadPage, THREAD_PAGE } from '../threads/api.ts';
import { ru } from '../i18n/ru.ts';
import { threadPath } from '../threads/ThreadRow.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './search.module.css';
import { ThreadResult } from './ThreadResult.tsx';
import { DelayedBar } from '../ui/Loading.tsx';

interface Pages {
  threads: ThreadSummaryDto[];
  next: string | null;
}

// Pages loaded further, with the first page they continue: a first page loaded anew (shown from memory,
// then from the server) drops them, or a conversation would be lost or shown twice.
interface More extends Pages {
  over: Pages;
}

export function AllThreads({ wide, projectName, onPick }: { wide: boolean; projectName: (id: string | null) => string; onPick: (path: string) => void }) {
  const first = useCallback(() => fetchThreadPage({ limit: THREAD_PAGE }), []);
  const { state, reload } = useLoad(first, ['threads', 'first-page']);
  const [loadedMore, setMore] = useState<More | null>(null);
  const firstPage = state.status === 'ready' ? state.data : null;
  const more = loadedMore && loadedMore.over === firstPage ? loadedMore : null;
  const [moreError, setMoreError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  // The end of the list may come into view again before the page asked for has come.
  const asking = useRef(false);
  const end = useRef<HTMLButtonElement>(null);
  const next = more ? more.next : firstPage ? firstPage.next : null;

  const showMore = useCallback(async () => {
    if (!next || !firstPage || asking.current) return;
    const over = firstPage;
    asking.current = true;
    setBusy(true);
    setMoreError(null);
    try {
      const page = await fetchThreadPage({ limit: THREAD_PAGE, before: next });
      setMore((prev) => ({ over, threads: [...(prev && prev.over === over ? prev.threads : []), ...page.threads], next: page.next }));
    } catch (raw) {
      setMoreError(asApiError(raw));
    } finally {
      asking.current = false;
      setBusy(false);
    }
  }, [next, firstPage]);

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

  if (state.status === 'loading') return <DelayedBar />;
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
