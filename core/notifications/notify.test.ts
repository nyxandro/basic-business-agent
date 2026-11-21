// A notification is written right after its event (docs/specs/[20.11.2026]-notifications.md, step 1): one per case,
// with its delivery to the browser, never for a blocked person, and a failure never breaks the event that called.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { notices } from './kinds.ts';
import { notify } from './notify.ts';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES
    ('olga', 'Ольга Смирнова', 'olga@example.com', true), ('petr', 'Пётр Иванов', 'petr@example.com', true)`);
  await db.query(`INSERT INTO app.user_profiles (user_id, blocked_at) VALUES ('petr', now())`);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

const rowsOf = async (userId: string) =>
  (await db.query<{ kind: string; title: string; dedup_key: string; status: string }>(
    `SELECT n.kind, n.title, n.dedup_key, d.status FROM app.notifications n JOIN app.notification_deliveries d ON d.notification_id = n.id WHERE n.user_id = $1 ORDER BY n.created_at, n.dedup_key`,
    [userId],
  )).rows;

describe('notify', () => {
  it('writes one notification per case with a pending delivery to the browser', async () => {
    const notice = notices.connectionBroken({ userId: 'olga', connectionKey: 'mcp:crm', title: 'Битрикс24', brokenAt: new Date('2026-11-21T09:00:00Z') });
    expect(await notify(db, notice)).toBe(true);
    // The same breakage reported again (another failed call of the agent) writes nothing.
    expect(await notify(db, notice)).toBe(false);
    // The connection broke once more after being fixed: a new case, a new notification.
    expect(await notify(db, notices.connectionBroken({ userId: 'olga', connectionKey: 'mcp:crm', title: 'Битрикс24', brokenAt: new Date('2026-11-21T15:30:00Z') }))).toBe(true);
    const rows = await rowsOf('olga');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'connection_broken' && r.status === 'pending' && r.title === 'Не работает доступ к Битрикс24')).toBe(true);
    expect(new Set(rows.map((r) => r.dedup_key)).size).toBe(2);
  });

  it('writes nothing for a blocked person', async () => {
    expect(await notify(db, notices.taskResult({ userId: 'petr', runId: 'run-1', taskTitle: 'Утренняя сводка', taskId: 'task-1', agentId: 'sales' }))).toBe(false);
    expect(await rowsOf('petr')).toEqual([]);
  });

  it('never throws to the event that called: a failure goes to the log with its code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // A person who does not exist: the database refuses, the caller goes on.
      await expect(notify(db, notices.taskResult({ userId: 'nobody', runId: 'run-2', taskTitle: 'Сводка', taskId: 'task-1', agentId: 'sales' }))).resolves.toBe(false);
      // A broken database connection.
      const broken = createPool(database.url.replace(/\/[^/]+$/, '/bba_no_such_database'));
      await expect(notify(broken, notices.taskResult({ userId: 'olga', runId: 'run-3', taskTitle: 'Сводка', taskId: 'task-1', agentId: 'sales' }))).resolves.toBe(false);
      await broken.end();
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; code: string; kind: string });
      expect(lines.some((l) => l.event === 'notification_failed' && l.code === 'APP_NOTIFICATION_FAILED' && l.kind === 'task_result')).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('never carries a passport, a phone or an e-mail of a conversation named by its first message', () => {
    const notice = notices.answerReady({ userId: 'olga', runKey: 'turn-pd', agentId: 'sales', threadId: 't-pd', threadTitle: 'Оформи договор: паспорт 4510 123456, тел. +7 916 123-45-67, ivan@example.com' });
    expect(notice.body).toBe('Разговор «Оформи договор: паспорт [ПАСПОРТ], тел. [ТЕЛЕФОН], [ПОЧТА]»');
  });

  it('keeps the texts within what a notification may hold', async () => {
    const long = 'Очень длинное название задачи '.repeat(20);
    expect(await notify(db, notices.taskFailed({ userId: 'olga', runId: 'run-4', taskTitle: long, taskId: 'task-1', agentId: 'sales' }))).toBe(true);
    const { rows } = await db.query<{ title: string }>(`SELECT title FROM app.notifications WHERE dedup_key = 'task_failed:run-4'`);
    expect(rows[0]!.title.length).toBeLessThanOrEqual(200);
    expect(rows[0]!.title.endsWith('…')).toBe(true);
  });
});
