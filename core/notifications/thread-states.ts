// The states of a person's conversations in the lists (decision of the owner 22.11; docs/specs/[20.11.2026]-notifications.md):
// running — an agent works there now (activity.ts); waiting — a question «Да» waits there; failed / done — its answer
// broke or is ready while nobody watched: an unread «Ответ не получился» / «Задача не выполнена» or «Ответ готов» /
// «Готово: задача», or a result of a background task the person has not opened yet (the mark the list showed as
// «новое»). Opening the conversation reads both, so the mark goes.
import type { NotificationKind, ThreadState } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import type { Activity } from './activity.ts';
import { NOTIFICATION_KEEP_DAYS } from './delivery.ts';

const FAILED: readonly NotificationKind[] = ['answer_failed', 'task_failed'];
const DONE: readonly NotificationKind[] = ['answer_ready', 'task_result'];
const PRECEDENCE: Record<ThreadState, number> = { running: 4, waiting: 3, failed: 2, done: 1 };

export async function threadStates(db: Db, activity: Activity, userId: string): Promise<Record<string, ThreadState>> {
  const states: Record<string, ThreadState> = {};
  const put = (threadId: string, state: ThreadState) => {
    const was = states[threadId];
    if (!was || PRECEDENCE[state] > PRECEDENCE[was]) states[threadId] = state;
  };
  // One statement, one connection: it runs on every «changed» of every open page.
  const { rows } = await db.query<{ thread_id: string; state: Exclude<ThreadState, 'running'> }>(
    `SELECT thread_id, 'waiting' AS state FROM app.approval_requests
      WHERE user_id = $1 AND status = 'pending' AND expires_at > now() AND run_kind <> 'draft'
     UNION ALL
     SELECT thread_id, CASE WHEN kind = ANY($2) THEN 'failed' ELSE 'done' END FROM app.notifications
      WHERE user_id = $1 AND read_at IS NULL AND thread_id IS NOT NULL AND kind = ANY($3) AND created_at > now() - interval '${NOTIFICATION_KEEP_DAYS} days'
     UNION ALL
     SELECT id, 'done' FROM mastra.mastra_threads WHERE "resourceId" = $1 AND metadata->>'unread' = 'true'`,
    [userId, FAILED, [...FAILED, ...DONE]],
  );
  for (const r of rows) put(r.thread_id, r.state);
  for (const threadId of activity.running(userId)) put(threadId, 'running');
  return states;
}
