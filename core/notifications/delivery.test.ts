// The delivery of notifications to browsers (docs/specs/[20.11.2026]-notifications.md, steps 3–5): a push readable by a
// real browser, no push to a person in the app, the quiet night, dead subscriptions, one retry, a browser taken over by
// another person, and the list that only its owner reads.
import type { NotificationList, NotificationsResponse } from '@bba/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { startFakePushService, type FakePushService, type FakeSubscription } from './fake-push.ts';
import { notices, type Notice } from './kinds.ts';
import { notify } from './notify.ts';

let t: TestApp;
let push: FakePushService;
// 12:00 Moscow on a weekday: the day, not the quiet night.
let clock = new Date('2026-11-23T09:00:00Z');
let olgaId: string;
let olga: string;
let petr: string;
let petrId: string;
let run = 0;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const subscribe = (cookie: string, sub: FakeSubscription) => t.call('POST', '/app/api/me/push-subscriptions', { cookie, body: sub });
const deliveryOf = async (dedupKey: string) =>
  (await t.db.query<{ status: string; error_code: string | null; attempts: number; send_after: Date }>(
    'SELECT d.status, d.error_code, d.attempts, d.send_after FROM app.notification_deliveries d JOIN app.notifications n ON n.id = d.notification_id WHERE n.dedup_key = $1',
    [dedupKey],
  )).rows[0];
const told = (userId: string) => notices.taskResult({ userId, runId: `run-${++run}`, taskId: 'task-1', taskTitle: 'Утренняя сводка', agentId: 'sales' });
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
// The database writes its own time; the notification is moved to the test's clock, as if written at that moment.
async function tell(notice: Notice): Promise<void> {
  expect(await notify(t.db, notice)).toBe(true);
  const { rows } = await t.db.query<{ id: string }>('UPDATE app.notifications SET created_at = $2 WHERE dedup_key = $1 RETURNING id', [notice.dedupKey, clock]);
  await t.db.query('UPDATE app.notification_deliveries SET send_after = $2 WHERE notification_id = $1', [rows[0]!.id, clock]);
}

beforeAll(async () => {
  push = await startFakePushService();
  t = await createTestApp({ push: { transport: push.transport, testOrigin: push.origin }, now: () => clock });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
  await push.close();
});
beforeEach(async () => {
  clock = new Date('2026-11-23T09:00:00Z');
  push.received.length = 0;
  await t.db.query('DELETE FROM app.push_subscriptions');
  // Presence of an earlier test ends: its tabs say «hidden».
  for (const cookie of [olga, petr]) await t.call('POST', '/app/api/me/presence', { cookie, body: { tab: 'tab-of-the-test', visible: false, threadId: null } });
});

describe('delivery to the browser', () => {
  it('sends a push a browser can decrypt, signed for the push service, kept 12 h, then marks it sent', async () => {
    const sub = push.subscribe();
    expect((await subscribe(olga, sub)).status).toBe(200);
    const notice = told(olgaId);
    await tell(notice);
    expect(await t.notifications.delivery.deliverDue()).toBe(1);
    expect(push.received).toHaveLength(1);
    const [got] = push.received;
    expect(got!.payload).toMatchObject({ kind: 'task_result', title: 'Готово: Утренняя сводка', body: 'Результат — в разговоре задачи.', link: notice.link });
    expect(got!.ttl).toBe(12 * 3600);
    expect(got!.urgency).toBe('normal');
    expect(got!.topic).toBe(got!.payload.id.replaceAll('-', ''));
    expect(got!.authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(await deliveryOf(notice.dedupKey)).toMatchObject({ status: 'sent', error_code: null });
    // Nothing is due any more.
    expect(await t.notifications.delivery.deliverDue()).toBe(0);
  });

  it('keeps «Ответ готов» at the push service for an hour only', async () => {
    await subscribe(olga, push.subscribe());
    await tell(notices.answerReady({ userId: olgaId, runKey: 'turn-1', agentId: 'sales', threadId: 'thread-1', threadTitle: 'КП для Вектора' }));
    await t.notifications.delivery.deliverDue();
    expect(push.received.map((r) => [r.payload.title, r.ttl])).toEqual([['Ответ готов', 3600]]);
  });

  it('sends no push to a person whose tab was visible 30 s ago, and does when it was 70 s ago', async () => {
    await subscribe(olga, push.subscribe());
    await t.call('POST', '/app/api/me/presence', { cookie: olga, body: { tab: 'computer-tab', visible: true, threadId: null } });
    advance(30_000);
    const here = told(olgaId);
    await tell(here);
    await t.notifications.delivery.deliverDue();
    expect(push.received).toEqual([]);
    expect(await deliveryOf(here.dedupKey)).toMatchObject({ status: 'skipped', error_code: 'present' });

    advance(40_000);
    const gone = told(olgaId);
    await tell(gone);
    await t.notifications.delivery.deliverDue();
    expect(push.received).toHaveLength(1);
  });

  it('pushes at once when the tab says it was hidden', async () => {
    await subscribe(olga, push.subscribe());
    await t.call('POST', '/app/api/me/presence', { cookie: olga, body: { tab: 'computer-tab', visible: true, threadId: null } });
    await t.call('POST', '/app/api/me/presence', { cookie: olga, body: { tab: 'computer-tab', visible: false, threadId: null } });
    await tell(told(olgaId));
    await t.notifications.delivery.deliverDue();
    expect(push.received).toHaveLength(1);
  });

  it('holds a push asked at 23:00 until 8:00 by the time zone of the installation; the list has it at once', async () => {
    await subscribe(olga, push.subscribe());
    clock = new Date('2026-11-23T20:00:00Z'); // 23:00 in Moscow
    const night = told(olgaId);
    await tell(night);
    await t.notifications.delivery.deliverDue();
    expect(push.received).toEqual([]);
    expect(await deliveryOf(night.dedupKey)).toMatchObject({ status: 'pending', attempts: 0, send_after: new Date('2026-11-24T05:00:00Z') });
    const list = await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: olga }));
    expect(list.items.some((n) => n.title === 'Готово: Утренняя сводка' && !n.read)).toBe(true);

    clock = new Date('2026-11-24T04:59:00Z');
    expect(await t.notifications.delivery.deliverDue()).toBe(0);
    clock = new Date('2026-11-24T05:00:00Z');
    await t.notifications.delivery.deliverDue();
    expect(push.received).toHaveLength(1);
  });

  it('drops a subscription the browser gave up (410) or made with other keys (403)', async () => {
    const dead = push.subscribe();
    const foreignKeys = push.subscribe();
    await subscribe(olga, dead);
    await subscribe(olga, foreignKeys);
    push.answer(dead.endpoint, [410]);
    push.answer(foreignKeys.endpoint, [403]);
    const notice = told(olgaId);
    await tell(notice);
    await t.notifications.delivery.deliverDue();
    expect((await t.db.query('SELECT 1 FROM app.push_subscriptions WHERE user_id = $1', [olgaId])).rowCount).toBe(0);
    expect(await deliveryOf(notice.dedupKey)).toMatchObject({ status: 'skipped', error_code: 'subscription_gone' });
  });

  it('tries a failing push service once more a minute later, then leaves the notification in the list', async () => {
    const sub = push.subscribe();
    await subscribe(olga, sub);
    push.answer(sub.endpoint, [503, 503]);
    const notice = told(olgaId);
    await tell(notice);
    await t.notifications.delivery.deliverDue();
    expect(await deliveryOf(notice.dedupKey)).toMatchObject({ status: 'pending', attempts: 1 });
    advance(30_000);
    expect(await t.notifications.delivery.deliverDue()).toBe(0);
    advance(30_000);
    await t.notifications.delivery.deliverDue();
    expect(await deliveryOf(notice.dedupKey)).toMatchObject({ status: 'failed', attempts: 2, error_code: 'push_failed' });
    expect(push.received).toEqual([]);
    // The subscription is alive: the next notification goes.
    await tell(told(olgaId));
    await t.notifications.delivery.deliverDue();
    expect(push.received).toHaveLength(1);
  });

  it('moves a browser to the person who turned notifications on in it: the first one’s notifications stop coming there', async () => {
    const browser = push.subscribe();
    await subscribe(olga, browser);
    await subscribe(petr, browser);
    expect((await t.db.query<{ user_id: string }>('SELECT user_id FROM app.push_subscriptions WHERE endpoint = $1', [browser.endpoint])).rows).toEqual([{ user_id: petrId }]);
    await tell(told(olgaId));
    await t.notifications.delivery.deliverDue();
    expect(push.received).toEqual([]);
    expect(await json<{ subscribed: boolean }>(await t.call('POST', '/app/api/me/push-subscriptions/status', { cookie: olga, body: { endpoint: browser.endpoint } }))).toEqual({ subscribed: false });
    expect(await json<{ subscribed: boolean }>(await t.call('POST', '/app/api/me/push-subscriptions/status', { cookie: petr, body: { endpoint: browser.endpoint } }))).toEqual({ subscribed: true });
    // Signing out drops it.
    expect((await t.call('DELETE', '/app/api/me/push-subscriptions', { cookie: petr, body: { endpoint: browser.endpoint } })).status).toBe(200);
    expect((await t.db.query('SELECT 1 FROM app.push_subscriptions WHERE endpoint = $1', [browser.endpoint])).rowCount).toBe(0);
  });

  it('does not push in the morning what the person already read before 8:00', async () => {
    await subscribe(olga, push.subscribe());
    clock = new Date('2026-11-23T20:00:00Z');
    const night = told(olgaId);
    await tell(night);
    await t.notifications.delivery.deliverDue();
    await t.db.query('UPDATE app.notifications SET read_at = now() WHERE dedup_key = $1', [night.dedupKey]);
    clock = new Date('2026-11-24T05:00:00Z');
    await t.notifications.delivery.deliverDue();
    expect(push.received).toEqual([]);
    expect(await deliveryOf(night.dedupKey)).toMatchObject({ status: 'skipped', error_code: 'read' });
  });

  it('keeps at most 10 browsers per person — the oldest goes — and sends to all of them at once', async () => {
    const browsers = Array.from({ length: 12 }, () => push.subscribe());
    for (const b of browsers) {
      await subscribe(olga, b);
      // Distinct times of subscribing, so «the oldest» is well defined.
      await t.db.query(`UPDATE app.push_subscriptions SET created_at = created_at - interval '1 second' WHERE user_id = $1`, [olgaId]);
    }
    const kept = (await t.db.query<{ endpoint: string }>('SELECT endpoint FROM app.push_subscriptions WHERE user_id = $1', [olgaId])).rows.map((r) => r.endpoint);
    expect(kept.sort()).toEqual(browsers.slice(2).map((b) => b.endpoint).sort());
    await tell(told(olgaId));
    await t.notifications.delivery.deliverDue();
    expect(push.received).toHaveLength(10);
  });

  it('refuses a subscription whose keys cannot encrypt a push', async () => {
    const res = await subscribe(olga, { endpoint: push.subscribe().endpoint, keys: { p256dh: 'not-a-key', auth: 'x' } });
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('APP_PUSH_SUBSCRIBE_FAILED');
  });

  it('refuses an address that is no push service: an inner address of the server, plain http, another port', async () => {
    const keys = push.subscribe().keys;
    for (const endpoint of ['http://localhost:4000/key/generate', 'https://10.0.0.5/push', 'https://127.0.0.1/push', 'https://fcm.googleapis.com:8443/x']) {
      const res = await subscribe(olga, { endpoint, keys });
      expect(res.status).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('APP_PUSH_SUBSCRIBE_FAILED');
    }
  });

  it('sends a trial push past presence, not kept in the list; without a subscription says so', async () => {
    const none = await t.call('POST', '/app/api/me/push-test', { cookie: olga });
    expect((await json<{ error: { code: string } }>(none)).error.code).toBe('APP_PUSH_NOT_SUBSCRIBED');
    await subscribe(olga, push.subscribe());
    await t.call('POST', '/app/api/me/presence', { cookie: olga, body: { tab: 'computer-tab', visible: true, threadId: null } });
    expect(await json<{ sent: number }>(await t.call('POST', '/app/api/me/push-test', { cookie: olga }))).toEqual({ sent: 1 });
    expect(push.received.map((r) => r.payload.title)).toEqual(['Уведомления работают']);
    const list = await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: olga }));
    expect(list.items.some((n) => n.title === 'Уведомления работают')).toBe(false);
  });
});

describe('the list under the bell', () => {
  it('shows a person only their own notifications; «прочитано» of a foreign one changes nothing', async () => {
    const own = told(petrId);
    await tell(own);
    const mine = await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: petr }));
    const theirs = await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: olga }));
    const item = mine.items.find((n) => n.title === 'Готово: Утренняя сводка')!;
    expect(theirs.items.some((n) => n.id === item.id)).toBe(false);
    await t.call('POST', '/app/api/me/notifications/read', { cookie: olga, body: { id: item.id } });
    expect((await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: petr }))).items.some((n) => n.id === item.id)).toBe(true);
  });

  it('counts unread notifications for the bell, gives the newest as a hint, and reads them one by one or all', async () => {
    await t.call('POST', '/app/api/me/notifications/read', { cookie: petr, body: { all: true } });
    await tell(told(petrId));
    advance(1_000);
    await tell(notices.projectShared({ userId: petrId, projectId: '00000000-0000-4000-8000-000000000001', projectName: 'Тендер', ownerName: 'Ольга', sharedAt: new Date() }));
    const counts = await json<NotificationsResponse>(await t.call('POST', '/app/api/me/presence', { cookie: petr, body: { tab: 'phone-tab-1', visible: true, threadId: null } }));
    expect(counts).toMatchObject({ pendingApprovals: 0, unread: 2, latest: { kind: 'project_shared', title: 'Вам открыли проект «Тендер»' } });
    await t.call('POST', '/app/api/me/notifications/read', { cookie: petr, body: { id: counts.latest!.id } });
    expect(await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: petr }))).toMatchObject({ unread: 1, latest: { kind: 'task_result' } });
    await t.call('POST', '/app/api/me/notifications/read', { cookie: petr, body: { all: true } });
    expect(await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: petr }))).toMatchObject({ unread: 0, latest: null });
  });

  it('refuses a malformed «прочитано»', async () => {
    expect((await t.call('POST', '/app/api/me/notifications/read', { cookie: petr, body: { id: 'not-an-id' } })).status).toBe(400);
    expect((await t.call('POST', '/app/api/me/presence', { cookie: petr, body: { tab: 'x', visible: true, threadId: null } })).status).toBe(400);
  });
});
