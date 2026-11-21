// The delivery of notifications to browsers (docs/specs/[20.11.2026]-notifications.md, section 8): every 2 s the due
// deliveries are taken (FOR UPDATE SKIP LOCKED) and each is judged at that moment — the question was decided meanwhile,
// the person is in the app, it is the quiet night — and then pushed to every browser of the person. A dead subscription
// is dropped; a passing failure gets one more attempt a minute later; after that the notification stays in the list.
import type { PushPayload, NotificationKind } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import { PUSH_DELIVERY } from './kinds.ts';
import type { Presence } from './presence.ts';
import type { PushResult, PushSender } from './push.ts';
import { quietUntil } from './quiet-hours.ts';

export const DELIVERY_POLL_MS = 2_000;
export const RETRY_AFTER_MS = 60_000;
export const MAX_ATTEMPTS = 2;
// A push older than this is not sent at all (a server that was down for a day): the list has it.
export const DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_KEEP_DAYS = 30;
const BATCH = 20;
const PURGE_EVERY_MS = 60 * 60 * 1000;

interface Due {
  notification_id: string;
  attempts: number;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  subject_ref: string | null;
  created_at: Date;
  // The question the notification is about is no longer waiting.
  decided: boolean;
}

export interface DeliveryDeps {
  db: Db;
  presence: Presence;
  timezone: string;
  sender: PushSender;
  now?: () => Date;
}

export interface Delivery {
  // Delivers what is due now; returns how many deliveries were judged (tests, the loop).
  deliverDue(): Promise<number>;
  purge(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createDelivery(deps: DeliveryDeps): Delivery {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let purgeTimer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;

  async function claim(at: Date): Promise<Due[]> {
    // The claim moves `send_after` a minute on: a delivery cut short by a stop of the server is taken again later.
    const { rows } = await db.query<Due>(
      `WITH due AS (
         SELECT notification_id FROM app.notification_deliveries
          WHERE status = 'pending' AND channel = 'push' AND send_after <= $1
          ORDER BY send_after LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE app.notification_deliveries d SET attempts = d.attempts + 1, send_after = $1::timestamptz + interval '${RETRY_AFTER_MS / 1000} seconds'
           FROM due WHERE d.notification_id = due.notification_id AND d.channel = 'push'
         RETURNING d.notification_id, d.attempts
       )
       SELECT c.notification_id, c.attempts, n.user_id, n.kind, n.title, n.body, n.link, n.subject_ref, n.created_at,
              ${decidedSql('n', '$1')} AS decided
         FROM claimed c JOIN app.notifications n ON n.id = c.notification_id`,
      [at],
    );
    return rows;
  }

  async function settle(id: string, status: 'sent' | 'skipped' | 'failed', code: string | null): Promise<void> {
    await db.query(
      `UPDATE app.notification_deliveries SET status = $2, error_code = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE notification_id = $1 AND channel = 'push'`,
      [id, status, code],
    );
  }

  async function postpone(id: string, until: Date, countAttempt: boolean): Promise<void> {
    await db.query(`UPDATE app.notification_deliveries SET send_after = $2, attempts = attempts - $3 WHERE notification_id = $1 AND channel = 'push'`, [id, until, countAttempt ? 0 : 1]);
  }

  async function deliver(due: Due, at: Date): Promise<void> {
    if (due.decided) return settle(due.notification_id, 'skipped', 'decided');
    if (at.getTime() - due.created_at.getTime() > DELIVERY_MAX_AGE_MS) return settle(due.notification_id, 'skipped', 'stale');
    if (deps.presence.isHere(due.user_id)) return settle(due.notification_id, 'skipped', 'present');
    const quiet = quietUntil(at, deps.timezone);
    if (quiet) return postpone(due.notification_id, quiet, false);

    const { rows: subscriptions } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'SELECT id, endpoint, p256dh, auth FROM app.push_subscriptions WHERE user_id = $1',
      [due.user_id],
    );
    if (subscriptions.length === 0) return settle(due.notification_id, 'skipped', 'no_subscription');

    const payload: PushPayload = { id: due.notification_id, kind: due.kind, title: due.title, body: due.body, link: due.link };
    const results: PushResult[] = [];
    for (const sub of subscriptions) {
      let result: PushResult;
      try {
        result = await deps.sender.send(sub, payload, PUSH_DELIVERY[due.kind]);
      } catch (error) {
        // A subscription whose address is no push service (or the subject is missing): never sent, logged with its code.
        logEvent('error', 'push_failed', { code: 'APP_PUSH_FAILED', notificationId: due.notification_id, host: hostOf(sub.endpoint), error });
        result = { kind: 'refused', status: 0 };
      }
      results.push(result);
      if (result.kind === 'sent') await db.query('UPDATE app.push_subscriptions SET last_ok_at = now() WHERE id = $1', [sub.id]);
      if (result.kind === 'gone') await db.query('DELETE FROM app.push_subscriptions WHERE id = $1', [sub.id]);
      if (result.kind === 'retry' || result.kind === 'refused') {
        logEvent('warn', 'push_failed', { code: 'APP_PUSH_FAILED', notificationId: due.notification_id, host: hostOf(sub.endpoint), status: 'status' in result ? result.status : null, reason: result.kind === 'retry' ? result.code : 'refused' });
      }
    }
    if (results.some((r) => r.kind === 'sent')) return settle(due.notification_id, 'sent', null);
    if (results.some((r) => r.kind === 'retry') && due.attempts < MAX_ATTEMPTS) return postpone(due.notification_id, new Date(at.getTime() + RETRY_AFTER_MS), true);
    const code = results.every((r) => r.kind === 'gone') ? 'subscription_gone' : 'push_failed';
    return settle(due.notification_id, code === 'subscription_gone' ? 'skipped' : 'failed', code);
  }

  async function deliverDue(): Promise<number> {
    const at = now();
    const due = await claim(at);
    for (const item of due) {
      // One broken delivery never holds back the others; it is taken again after its minute.
      await deliver(item, at).catch((error: unknown) => logEvent('error', 'push_failed', { code: 'APP_PUSH_FAILED', notificationId: item.notification_id, error }));
    }
    return due.length;
  }

  const delivery: Delivery = {
    deliverDue,
    async purge() {
      const { rowCount } = await db.query(`DELETE FROM app.notifications WHERE created_at < now() - interval '${NOTIFICATION_KEEP_DAYS} days'`);
      return rowCount ?? 0;
    },
    start() {
      const tick = () => {
        if (running) return;
        running = deliverDue()
          .catch((error: unknown) => (logEvent('error', 'notification_delivery_failed', { code: 'APP_PUSH_FAILED', error }), 0))
          .finally(() => (running = null));
      };
      timer = setInterval(tick, DELIVERY_POLL_MS);
      timer.unref();
      purgeTimer = setInterval(() => void delivery.purge().catch((error: unknown) => logEvent('error', 'notification_purge_failed', { code: 'APP_INTERNAL', error })), PURGE_EVERY_MS);
      purgeTimer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      if (purgeTimer) clearInterval(purgeTimer);
      timer = purgeTimer = null;
      await running;
    },
  };
  return delivery;
}

// A notification about a question «Да» that no longer waits (decided, burnt). CASE keeps the cast away from other
// subjects ('connection:…'): Postgres does not promise the order of AND.
export function decidedSql(alias: string, at: string): string {
  return `(CASE WHEN ${alias}.subject_ref LIKE 'approval:%' THEN NOT EXISTS (
    SELECT 1 FROM app.approval_requests a WHERE a.id = substring(${alias}.subject_ref FROM 10)::uuid AND a.status = 'pending' AND a.expires_at > ${at}) ELSE false END)`;
}

// The address of a subscription is the browser's secret; the log names only the push service.
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid';
  }
}
