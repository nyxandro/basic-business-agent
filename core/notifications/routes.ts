// The person's notifications (docs/specs/[20.11.2026]-notifications.md, section 17): the counters of the bell, the list,
// «прочитано», presence, the browser's subscription and a trial push. Everything is the signed-in person's own.
import { presenceInputSchema, pushSubscriptionInputSchema, pushUnsubscribeSchema, type NotificationList, type PushKeyResponse, type PushStatusResponse } from '@bba/contracts';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import { PUSH_DELIVERY } from './kinds.ts';
import { listNotifications, markRead, notificationCounts } from './list.ts';
import type { Presence } from './presence.ts';
import { checkEndpoint, type PushSender } from './push.ts';

const readBody = z.union([z.strictObject({ id: z.uuid() }), z.strictObject({ all: z.literal(true) })]);
const USER_AGENT_MAX = 500;

export interface NotificationRouteDeps {
  db: Db;
  presence: Presence;
  sender: PushSender;
  publicKey: string;
  // The origin of the fake push service of tests; null in an installation.
  testOrigin: string | null;
}

export function registerNotificationRoutes(app: Hono<AppEnv>, deps: NotificationRouteDeps): void {
  const { db } = deps;

  app.get('/app/api/me/notifications', async (c) => c.json(await notificationCounts(db, access(c).userId)));

  app.get('/app/api/me/notifications/list', async (c) => {
    const body: NotificationList = { items: await listNotifications(db, access(c).userId) };
    return c.json(body);
  });

  app.post('/app/api/me/notifications/read', async (c) => {
    const body = await parseJson(c, readBody);
    await markRead(db, access(c).userId, 'id' in body ? body.id : null);
    return c.json({ ok: true });
  });

  // A visible tab every 30 s, a hidden one at once; the answer is the bell's counters, so one request does both.
  app.post('/app/api/me/presence', async (c) => {
    const { tab, visible } = await parseJson(c, presenceInputSchema);
    const userId = access(c).userId;
    deps.presence.seen(userId, tab, visible);
    return c.json(await notificationCounts(db, userId));
  });

  app.get('/app/api/push/key', (c) => {
    const body: PushKeyResponse = { publicKey: deps.publicKey };
    return c.json(body);
  });

  // The browser's subscription is the person's; the same browser turned on by another person moves to them.
  app.post('/app/api/me/push-subscriptions', async (c) => {
    const input = await parseJson(c, pushSubscriptionInputSchema);
    checkEndpoint(input.endpoint, deps.testOrigin);
    const userId = access(c).userId;
    await db.query(
      `INSERT INTO app.push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent, created_at = now(), last_ok_at = NULL`,
      [randomUUID(), userId, input.endpoint, input.keys.p256dh, input.keys.auth, c.req.header('user-agent')?.slice(0, USER_AGENT_MAX) ?? null],
    );
    logEvent('info', 'push_subscribed', { userId, host: new URL(input.endpoint).host });
    return c.json({ ok: true });
  });

  // Signing out or turning off: the browser drops its subscription and tells the server.
  app.delete('/app/api/me/push-subscriptions', async (c) => {
    const { endpoint } = await parseJson(c, pushUnsubscribeSchema);
    await db.query('DELETE FROM app.push_subscriptions WHERE user_id = $1 AND endpoint = $2', [access(c).userId, endpoint]);
    return c.json({ ok: true });
  });

  // «Включены в этом браузере»: the browser has a subscription, and the server keeps it for this very person.
  app.post('/app/api/me/push-subscriptions/status', async (c) => {
    const { endpoint } = await parseJson(c, pushUnsubscribeSchema);
    const { rowCount } = await db.query('SELECT 1 FROM app.push_subscriptions WHERE user_id = $1 AND endpoint = $2', [access(c).userId, endpoint]);
    const body: PushStatusResponse = { subscribed: (rowCount ?? 0) > 0 };
    return c.json(body);
  });

  // «Проверить»: a trial push to every browser of the person at once — past quiet hours and presence, and not kept in
  // the list (it tells nothing).
  app.post('/app/api/me/push-test', async (c) => {
    const userId = access(c).userId;
    const { rows } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>('SELECT id, endpoint, p256dh, auth FROM app.push_subscriptions WHERE user_id = $1', [userId]);
    if (rows.length === 0) throw appError('APP_PUSH_NOT_SUBSCRIBED', 'no push subscription of the person');
    const payload = { id: randomUUID(), kind: 'answer_ready' as const, title: 'Уведомления работают', body: 'Так будут приходить вопросы агента и готовые результаты.', link: '/settings/notifications' };
    let sent = 0;
    for (const sub of rows) {
      const result = await deps.sender.send(sub, payload, PUSH_DELIVERY.answer_ready);
      if (result.kind === 'sent') sent++;
      if (result.kind === 'gone') await db.query('DELETE FROM app.push_subscriptions WHERE id = $1', [sub.id]);
    }
    if (sent === 0) throw appError('APP_PUSH_FAILED', `trial push reached none of ${rows.length} browsers`);
    return c.json({ sent });
  });
}
