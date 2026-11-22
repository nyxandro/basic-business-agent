// «Недавние» (spec, sections 7 and 8.16): the newest conversations of all the person's agents, each with its mark — an
// agent at work, a question waiting, an answer broken or ready while nobody watched (owner, 22.11) — and «Ещё» when
// there are more — it opens all
// of them in the window of «Поиск» (decision of the owner 15.11: a long list stretched the panel).
// Each conversation can be renamed or deleted from its three dots. A new `refreshKey` (after an answer or a new
// name) loads the list again in place: the old list stays until the new one comes, a name being typed
// stays.
import type { ThreadState, ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { fetchThreadPage } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './shell.module.css';
import { threadPath, ThreadRow } from './ThreadRow.tsx';

// How many of the newest conversations the panel shows (decision of the owner 15.11).
export const RECENT_SHOWN = 7;

// `names` — names given by hand in this tab (here or in the header of the conversation), kept by the
// frame; `onDeleted` tells the panel that a conversation went (a project page lists its conversations too).
export function RecentThreads({
  refreshKey,
  names,
  states,
  currentThreadId,
  onNavigate,
  onShowAll,
  onRenamed,
  onDeleted,
}: {
  refreshKey: number;
  names: Readonly<Record<string, string>>;
  // The marks of conversations (layout/notifications.tsx: they come with the bell's counters).
  states: Readonly<Record<string, ThreadState>>;
  currentThreadId: string | null;
  onNavigate: () => void;
  onShowAll: () => void;
  onRenamed: (threadId: string, title: string) => void;
  onDeleted: () => void;
}) {
  // The conversations of each background task's events come as one row (docs/specs/[20.11.2026]-event-tasks.md).
  const first = useCallback(() => fetchThreadPage({ limit: RECENT_SHOWN, group: 'tasks' }), []);
  const { state, reload } = useLoad(first, ['threads', 'recent']);
  const navigate = useNavigate();
  const [seenKey, setSeenKey] = useState(refreshKey);
  if (seenKey !== refreshKey) {
    setSeenKey(refreshKey);
    reload();
  }

  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner title={ru.shell.recentFailed} error={state.error} onRetry={reload} />;
  // A name saved by hand shows at once, and over a list loaded before the server had it.
  const threads = state.data.threads.map((t) => ({ ...t, title: names[t.id] ?? t.title }));
  if (threads.length === 0) return <p className={styles.empty}>{ru.shell.recentEmpty}</p>;
  return (
    <>
      {threads.map((t) => {
        const row = (thread: ThreadSummaryDto) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            state={states[thread.id]}
            current={thread.id === currentThreadId}
            onNavigate={onNavigate}
            onRenamed={(title) => onRenamed(thread.id, title)}
            onDeleted={() => {
              // The open conversation is gone: a new one with the same agent takes its place.
              if (thread.id === currentThreadId) void navigate(threadPath({ agentId: thread.agentId, id: crypto.randomUUID() }), { replace: true });
              reload();
              onDeleted();
            }}
          />
        );
        return t.group ? <TaskGroup key={`task-${t.group.taskId}`} group={t.group} names={names} row={row} /> : row(t);
      })}
      {state.data.next ? (
        <button type="button" className={styles.more} onClick={onShowAll}>
          {ru.shell.moreThreads}
        </button>
      ) : null}
    </>
  );
}

// One row for the conversations of a task's events: «Разбор входящих · 3 новых»; opened, the conversations of the task.
function TaskGroup({ group, names, row }: { group: NonNullable<ThreadSummaryDto['group']>; names: Readonly<Record<string, string>>; row: (thread: ThreadSummaryDto) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={styles.item} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="bolt" size={15} />
        <span className={styles.itemText}>{ru.shell.taskGroup(group.taskTitle, group.total, group.fresh)}</span>
      </button>
      {open ? <TaskThreads taskId={group.taskId} title={group.taskTitle} names={names} row={row} /> : null}
    </>
  );
}

function TaskThreads({ taskId, title, names, row }: { taskId: string; title: string; names: Readonly<Record<string, string>>; row: (thread: ThreadSummaryDto) => ReactNode }) {
  const load = useCallback(() => fetchThreadPage({ limit: TASK_THREADS_SHOWN, task: taskId }), [taskId]);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner title={ru.shell.recentFailed} error={state.error} onRetry={reload} />;
  return (
    <div role="group" aria-label={ru.shell.taskGroupOpen(title)} className={styles.taskThreads}>
      {state.data.threads.map((t) => row({ ...t, title: names[t.id] ?? t.title }))}
    </div>
  );
}

// How many conversations of a task's events the opened group shows; the rest are in «Ещё».
const TASK_THREADS_SHOWN = 20;
