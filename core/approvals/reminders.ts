// «Вопрос сгорит через N ч» (docs/specs/[20.11.2026]-notifications.md, scenario 2): when a quarter of a question's term
// is left — 6 hours of a day, 18 of three days — the employee is reminded once. The sweep of expired questions calls it.
import type { Db } from '../db/pool.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { questionOrigin } from './requests.ts';

const HOUR_MS = 60 * 60 * 1000;

export async function remindExpiring(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string; user_id: string; agent_id: string; task_id: string | null; thread_id: string; summary: string; expires_at: Date }>(
    `SELECT a.id, a.user_id, a.agent_id, a.task_id, a.thread_id, a.summary, a.expires_at FROM app.approval_requests a
      WHERE a.status = 'pending' AND a.run_kind <> 'draft' AND a.expires_at > now()
        AND now() >= a.expires_at - (a.expires_at - a.created_at) / 4
        AND NOT EXISTS (SELECT 1 FROM app.notifications n WHERE n.user_id = a.user_id AND n.dedup_key = 'approval_expiring:' || a.id::text)`,
  );
  for (const q of rows) {
    const hoursLeft = Math.max(1, Math.ceil((q.expires_at.getTime() - Date.now()) / HOUR_MS));
    const origin = await questionOrigin(db, { taskId: q.task_id, agentId: q.agent_id, threadId: q.thread_id });
    await notify(db, notices.approvalExpiring({ userId: q.user_id, approvalId: q.id, action: q.summary, origin, hoursLeft }));
  }
  return rows.length;
}
