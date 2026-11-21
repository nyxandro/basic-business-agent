// Writes a notification right after its event (docs/specs/[20.11.2026]-notifications.md, section 8): the row of the list
// and its delivery to the browser in one statement. The delivery itself is the job of the delivery loop
// (delivery.ts) — so the eight places that notify need only the database, and a push not sent before the server
// stopped goes after it starts. The event matters more than its notification: a failure here is logged and never
// thrown into the code that called.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import type { Notice } from './kinds.ts';

// A person blocked or being removed gets no notifications (section 10).
const ACTIVE_PERSON = `EXISTS (SELECT 1 FROM app."user" u WHERE u."id" = $2)
  AND NOT EXISTS (SELECT 1 FROM app.user_profiles p WHERE p.user_id = $2 AND (p.blocked_at IS NOT NULL OR p.deletion_started_at IS NOT NULL))`;

// True when a new notification was written; false for a repeat of the same case, a blocked person or a failure.
export async function notify(db: Db, notice: Notice): Promise<boolean> {
  try {
    const { rowCount } = await db.query(
      `WITH n AS (
         INSERT INTO app.notifications (id, user_id, kind, title, body, link, subject_ref, thread_id, dedup_key)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE ${ACTIVE_PERSON}
         ON CONFLICT (user_id, dedup_key) DO NOTHING
         RETURNING id
       )
       INSERT INTO app.notification_deliveries (notification_id, channel, status) SELECT id, 'push', 'pending' FROM n`,
      [randomUUID(), notice.userId, notice.kind, notice.title, notice.body, notice.link, notice.subjectRef, notice.threadId, notice.dedupKey],
    );
    const created = (rowCount ?? 0) > 0;
    if (created) logEvent('info', 'notification_created', { kind: notice.kind, userId: notice.userId });
    return created;
  } catch (error) {
    logEvent('error', 'notification_failed', { code: 'APP_NOTIFICATION_FAILED', kind: notice.kind, userId: notice.userId, error });
    return false;
  }
}

export async function notifyAll(db: Db, list: readonly Notice[]): Promise<void> {
  for (const notice of list) await notify(db, notice);
}
