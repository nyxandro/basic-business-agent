// The list under the bell and its counters (docs/specs/[20.11.2026]-notifications.md, scenario 3): only the person's
// own notifications of 30 days. A notification about a question «Да» reads as read once the question no longer waits —
// the question itself is counted in «Ждут решения», so it never adds to the bell twice.
import { APPROVAL_NOTIFICATION_KINDS, type NotificationItem, type NotificationKind, type NotificationsResponse } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { decidedSql, NOTIFICATION_KEEP_DAYS } from './delivery.ts';

const LIST_MAX = 100;
const KEPT = `n.created_at > now() - interval '${NOTIFICATION_KEEP_DAYS} days'`;

interface Row {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  created_at: Date;
  read: boolean;
}

const toItem = (r: Row): NotificationItem => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at.toISOString(), read: r.read });
const READ = `(n.read_at IS NOT NULL OR ${decidedSql('n', 'now()')})`;

// Questions waiting for the person: of background tasks and of conversations (decision of the owner 21.11, F4); a
// draft check of a prompt is the admin's own and never waits there.
export const WAITING_QUESTION = `status = 'pending' AND expires_at > now() AND run_kind <> 'draft'`;

export async function notificationCounts(db: Db, userId: string): Promise<NotificationsResponse> {
  const [counts, latest] = await Promise.all([
    db.query<{ approvals: number; unread: number }>(
      `SELECT (SELECT count(*)::int FROM app.approval_requests WHERE user_id = $1 AND ${WAITING_QUESTION}) AS approvals,
              (SELECT count(*)::int FROM app.notifications n WHERE n.user_id = $1 AND n.read_at IS NULL AND ${KEPT} AND NOT (n.kind = ANY($2))) AS unread`,
      [userId, APPROVAL_NOTIFICATION_KINDS],
    ),
    db.query<Row>(`SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, false AS read FROM app.notifications n WHERE n.user_id = $1 AND NOT ${READ} AND ${KEPT} ORDER BY n.created_at DESC LIMIT 1`, [userId]),
  ]);
  return { pendingApprovals: counts.rows[0]?.approvals ?? 0, unread: counts.rows[0]?.unread ?? 0, latest: latest.rows[0] ? toItem(latest.rows[0]) : null };
}

export async function listNotifications(db: Db, userId: string): Promise<NotificationItem[]> {
  const { rows } = await db.query<Row>(
    `SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, ${READ} AS read FROM app.notifications n WHERE n.user_id = $1 AND ${KEPT} ORDER BY n.created_at DESC LIMIT ${LIST_MAX}`,
    [userId],
  );
  return rows.map(toItem);
}

// `id` — one notification; null — all of the person's.
export async function markRead(db: Db, userId: string, id: string | null): Promise<void> {
  if (id === null) await db.query('UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  else await db.query('UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND id = $2 AND read_at IS NULL', [userId, id]);
}

// Opening a conversation shows what its notifications told («Готово», «Ответ готов»).
export async function markThreadRead(db: Db, userId: string, threadId: string): Promise<void> {
  await db.query('UPDATE app.notifications SET read_at = now() WHERE user_id = $1 AND thread_id = $2 AND read_at IS NULL', [userId, threadId]);
}
