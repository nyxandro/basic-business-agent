// Background tasks with a scope (spec, scenario 4, section 8.6): a fire runs on behalf of every
// employee in scope, at most 3 at once, each in their own conversation, with their questions on
// their approvals screen.
import type { AdminTask, NotificationList, NotificationsResponse, TaskAccess, TaskRunsResponse } from '@bba/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { taskThreadId } from './service.ts';
import { createTask, type TasksDeps } from './tasks.ts';

let t: TestApp;
let tasks: TasksDeps;
let igorId: string;
let igor: string;
let olgaId: string;
let olga: string;
let sales: string;

const only = (userId: string): TaskAccess => ({ scope: 'users', departmentIds: [], userIds: [userId] });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
let minute = 0;
// Each fire at its own scheduled minute, as the schedule would name it.
const nextFireTime = () => new Date(Date.UTC(2026, 10, 2, 6, ++minute, 0));

async function newTask(title: string, access: TaskAccess = only(olgaId)): Promise<AdminTask> {
  return createTask(tasks, igorId, { title, agentId: 'sales', access, schedule: { kind: 'daily', time: '09:00' }, prompt: 'Подготовь сводку по сделкам' });
}

// Fires the task "now" with a cron of every minute, then waits for the queue.
async function fire(taskId: string) {
  const { rows } = await t.db.query<{ cron: string }>(`UPDATE app.background_tasks SET cron = '* * * * *' WHERE id = $1 RETURNING (SELECT cron FROM app.background_tasks WHERE id = $1)`, [taskId]);
  const result = await t.background.fire(taskId, nextFireTime());
  await t.db.query('UPDATE app.background_tasks SET cron = $2 WHERE id = $1', [taskId, rows[0]?.cron ?? '0 9 * * *']);
  await t.background.idle();
  return result;
}

async function journalOf(taskId: string): Promise<string[]> {
  const { rows } = await t.db.query<{ event: string; result: string; error_code: string | null }>('SELECT event, result, error_code FROM app.action_journal WHERE task_id = $1 ORDER BY id', [taskId]);
  return rows.map((r) => [r.event, r.result, r.error_code].filter(Boolean).join(':'));
}

const runsOf = async (taskId: string) => json<TaskRunsResponse>(await t.call('GET', `/app/api/admin/tasks/${taskId}/runs`, { cookie: igor }));
const messagesOf = async (threadId: string, cookie = olga) =>
  ((await (await t.call('GET', `/app/api/threads/${encodeURIComponent(threadId)}/messages`, { cookie })).json()) as { messages: { role: string; text: string }[] }).messages;

beforeAll(async () => {
  t = await createTestApp();
  tasks = { db: t.db, registry: t.registry, background: t.background, timezone: 'Europe/Moscow' };
  igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь Власов', roleIds: [await t.roleId('superadmin')] });
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга', departmentIds: [sales] });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.sentMail.length = 0;
});

describe('background tasks', () => {
  it('runs for the employee in their own conversation, opened by a line about who set the task up', async () => {
    const task = await newTask('Утренняя сводка');
    t.model.script({ text: 'Сводка: 3 сделки без движения.' });
    expect(await fire(task.id)).toMatchObject({ status: 'fired', queued: 1, skipped: 0 });
    const messages = await messagesOf(taskThreadId(task.id, olgaId));
    expect(messages[0]).toMatchObject({ role: 'assistant', text: 'Задачу «Утренняя сводка» завёл администратор Игорь Власов. Поставить на паузу или удалить её может администратор.' });
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Сводка: 3 сделки без движения.' });
    expect(await journalOf(task.id)).toEqual(['background_started:started', 'background_finished:ok']);
    expect((await runsOf(task.id)).runs).toMatchObject([{ userId: olgaId, name: 'Ольга', outcome: 'done' }]);

    // «Готово: …» tells the result (docs/specs/[20.11.2026]-notifications.md); opening the conversation reads it.
    const threadId = taskThreadId(task.id, olgaId);
    const notes = await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: olga }));
    expect(notes).toMatchObject({ unread: 1, latest: { kind: 'task_result', title: 'Готово: Утренняя сводка', link: `/agents/sales?thread=${encodeURIComponent(threadId)}` } });
    const body = { threadId, runId: 'r1', messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
    expect((await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie: olga, body })).status).toBe(200);
    expect(await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: olga }))).toMatchObject({ unread: 0, latest: null });
  });

  it('puts an action on the approvals screen, skips the employee’s next run while it waits, and runs it after "Да"', async () => {
    const task = await newTask('Напоминания');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'supplier@example.com', text: 'Напоминаем о КП' } }] });
    await fire(task.id);
    expect(t.sentMail).toEqual([]);
    expect((await runsOf(task.id)).runs[0]!.outcome).toBe('awaiting-approval');

    const screen = await json<{ pending: { id: string; tool: string; task: string }[] }>(await t.call('GET', '/app/api/approvals', { cookie: olga }));
    expect(screen.pending).toMatchObject([{ tool: 'mail_send', task: 'Напоминания', conversation: null, args: { to: 'supplier@example.com', text: 'Напоминаем о КП' } }]);
    // The question is told at once and leads to itself; a run waiting for «Да» tells no «Готово».
    const questionId = screen.pending[0]!.id;
    const list = await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: olga }));
    expect(list.items.filter((n) => n.title.includes('Напоминания') || n.body.includes('Напоминания'))).toMatchObject([
      { kind: 'approval_waiting', title: 'Ждёт вашего решения', body: 'Напоминания · Отправить письмо клиенту', link: `/approvals?question=${questionId}`, read: false },
    ]);
    expect(await json<NotificationsResponse>(await t.call('GET', '/app/api/me/notifications', { cookie: olga }))).toMatchObject({ pendingApprovals: 1, latest: { kind: 'approval_waiting' } });
    expect(await fire(task.id)).toMatchObject({ queued: 0, skipped: 1 });
    expect((await runsOf(task.id)).runs).toMatchObject([{ outcome: 'skipped', reasonCode: 'awaiting_approval' }]);
    expect((await journalOf(task.id)).at(-1)).toBe('background_skipped:skipped:APP_BACKGROUND_RUN_SKIPPED');

    t.model.script({ text: 'Напоминание отправлено.' });
    expect((await t.call('POST', `/app/api/approvals/${screen.pending[0]!.id}/decision`, { cookie: olga, body: { approved: true } })).status).toBe(200);
    expect(t.sentMail).toEqual([{ to: 'supplier@example.com', text: 'Напоминаем о КП' }]);
    const first = await t.db.query<{ outcome: string }>('SELECT outcome FROM app.background_task_runs WHERE task_id = $1 ORDER BY fire_at LIMIT 1', [task.id]);
    expect(first.rows[0]!.outcome).toBe('done');
    const again = await t.call('POST', `/app/api/approvals/${screen.pending[0]!.id}/decision`, { cookie: olga, body: { approved: true } });
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe('APP_APPROVAL_DECIDED');
    // The decided question leaves the list of what is not dealt with; its old link leads to «Вопрос уже решён».
    const after = await json<NotificationList>(await t.call('GET', '/app/api/me/notifications/list', { cookie: olga }));
    expect(after.items.some((n) => n.link === `/approvals?question=${questionId}`)).toBe(false);
    expect(await json<unknown>(await t.call('GET', `/app/api/approvals/${questionId}`, { cookie: olga }))).toMatchObject({ status: 'approved', action: 'Отправить письмо клиенту', decidedAt: expect.any(String) });
    expect((await t.call('GET', `/app/api/approvals/${questionId}`, { cookie: igor })).status).toBe(404);
  });

  it('keeps the approvals screen working after the task’s conversation was deleted', async () => {
    const task = await newTask('Удалённый разговор');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'gone@example.com', text: 'x' } }] });
    await fire(task.id);
    expect((await t.call('DELETE', `/app/api/threads/${encodeURIComponent(taskThreadId(task.id, olgaId))}`, { cookie: olga })).status).toBe(200);
    const res = await t.call('GET', '/app/api/approvals', { cookie: olga });
    expect(res.status).toBe(200);
    const { pending } = await json<{ pending: { task: string; args: unknown }[] }>(res);
    // Without the conversation only the summary kept in the database is left to show.
    expect(pending.find((p) => p.task === 'Удалённый разговор')?.args).toEqual({ to: '<почта>', text: 'x' });
  });

  it('answers a task’s question only on the approvals screen, not from the chat', async () => {
    const task = await newTask('Ответ из чата');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'chat@example.com', text: 'x' } }] });
    await fire(task.id);
    const body = { threadId: taskThreadId(task.id, olgaId), runId: 'r', messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
    expect(await (await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie: olga, body })).text()).not.toContain('"interrupt"');
    const row = (await t.db.query<{ run_id: string; tool_call_id: string }>('SELECT run_id, tool_call_id FROM app.approval_requests WHERE task_id = $1', [task.id])).rows[0]!;
    const resume = [{ interruptId: `mastra-approval::${row.run_id}::${row.tool_call_id}`, status: 'resolved', payload: { approved: true } }];
    expect((await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie: olga, body: { ...body, resume } })).status).toBe(400);
    expect(t.sentMail).toEqual([]);
  });

  it('lets an unanswered question expire after 72 hours without running the action; the next run goes', async () => {
    const task = await newTask('Истечение');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'late@example.com', text: 'x' } }] }, { text: 'Хорошо.' });
    await fire(task.id);
    await t.db.query(`UPDATE app.approval_requests SET expires_at = now() - interval '1 minute' WHERE task_id = $1`, [task.id]);
    expect(await t.background.expireOverdue()).toBe(1);
    expect(t.sentMail).toEqual([]);
    expect(await journalOf(task.id)).toContain('approval_expired:expired:APP_APPROVAL_EXPIRED');
    expect((await runsOf(task.id)).runs[0]).toMatchObject({ outcome: 'failed', reasonCode: 'APP_APPROVAL_EXPIRED' });
    t.model.script({ text: 'Новая сводка.' });
    expect(await fire(task.id)).toMatchObject({ queued: 1 });
    expect((await runsOf(task.id)).runs[0]!.outcome).toBe('done');
  });

  it('reaches a department of 8: 7 runs and 1 skipped without access, never more than 3 at once (M4)', async () => {
    const warehouse = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Склад') RETURNING id`)).rows[0]!.id;
    const team: string[] = [];
    for (let i = 1; i <= 6; i++) team.push(await t.createUser({ email: `sales${i}@example.com`, name: `Продавец ${i}`, departmentIds: [sales] }));
    const keeper = await t.createUser({ email: 'keeper@example.com', name: 'Кладовщик', departmentIds: [warehouse] });
    const task = await newTask('Сводка отдела', { scope: 'departments', departmentIds: [sales, warehouse], userIds: [] });
    for (let i = 0; i < 7; i++) t.model.script({ text: `Сводка ${i}`, delayMs: 300 });
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    expect(await fire(task.id)).toMatchObject({ queued: 7, skipped: 1 });
    console.log(`M4: 7 runs, 3 at a time: ${Math.round(performance.now() - started)} ms, RSS +${Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024)} MB`);

    const { runs } = await runsOf(task.id);
    expect(runs.filter((r) => r.outcome === 'done')).toHaveLength(7);
    expect(runs.find((r) => r.userId === keeper)).toMatchObject({ outcome: 'skipped', reasonCode: 'no_access' });
    const spans = runs.filter((r) => r.startedAt).map((r) => [Date.parse(r.startedAt!), Date.parse(r.finishedAt!)] as const);
    const overlap = Math.max(...spans.map(([s]) => spans.filter(([a, b]) => a <= s && s < b).length));
    expect(overlap).toBeLessThanOrEqual(3);
    for (const userId of team) expect((await t.memory.getThreadById({ threadId: taskThreadId(task.id, userId) }))?.resourceId).toBe(userId);

    const listed = (await json<{ tasks: AdminTask[] }>(await t.call('GET', '/app/api/admin/tasks', { cookie: igor }))).tasks.find((x) => x.id === task.id);
    expect(listed?.lastFire).toMatchObject({ total: 8, counts: { done: 7, skipped: 1 } });

    // A new member of the department is in the next fire.
    await t.createUser({ email: 'sales7@example.com', name: 'Продавец 7', departmentIds: [sales] });
    for (let i = 0; i < 8; i++) t.model.script({ text: 'Сводка' });
    expect(await fire(task.id)).toMatchObject({ queued: 8, skipped: 1 });
  }, 60_000);

  it('after a restart runs only what has no result; a run a day late is skipped', async () => {
    const task = await newTask('После перезапуска');
    const fireAt = nextFireTime();
    await t.db.query(
      `INSERT INTO app.background_task_runs (task_id, fire_at, user_id, outcome, started_at) VALUES
         ($1, now() - interval '5 minutes', $2, 'running', now()),
         ($1, now() - interval '2 days', $2, 'queued', NULL),
         ($1, $3, $2, 'done', now())`,
      [task.id, olgaId, fireAt],
    );
    t.model.script({ text: 'Догнал.' });
    await t.background.recover();
    await t.background.idle();
    const { rows } = await t.db.query<{ outcome: string; reason_code: string | null }>('SELECT outcome, reason_code FROM app.background_task_runs WHERE task_id = $1 ORDER BY fire_at', [task.id]);
    // By the time of the fire: the finished one untouched, the one two days late skipped, the
    // interrupted one run again.
    expect(rows).toEqual([
      { outcome: 'done', reason_code: null },
      { outcome: 'skipped', reason_code: 'too_late' },
      { outcome: 'done', reason_code: null },
    ]);
  });

  it('declines the waiting questions when the admin removes the task; the conversations stay', async () => {
    const task = await newTask('На удаление');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'x@example.com', text: 'x' } }] }, { text: 'Понял.' });
    await fire(task.id);
    const approvalId = (await t.db.query<{ id: string }>('SELECT id FROM app.approval_requests WHERE task_id = $1', [task.id])).rows[0]!.id;
    expect((await t.call('DELETE', `/app/api/admin/tasks/${task.id}`, { cookie: igor })).status).toBe(200);
    expect((await t.db.query('SELECT 1 FROM app.approval_requests WHERE id = $1', [approvalId])).rowCount).toBe(0);
    expect(await journalOf(task.id)).toContain('tool_declined:declined:APP_TASK_DELETED');
    expect(t.sentMail).toEqual([]);
    expect(await t.memory.getThreadById({ threadId: taskThreadId(task.id, olgaId) })).not.toBeNull();
  });

  it('stops the whole task when its agent is gone, and refuses an empty scope', async () => {
    const task = await newTask('Без агента');
    await t.db.query(`UPDATE app.background_tasks SET agent_id = 'ghost' WHERE id = $1`, [task.id]);
    expect(await fire(task.id)).toEqual({ status: 'paused', reason: 'agent_missing' });
    const { rows } = await t.db.query<{ status: string; paused_reason: string }>('SELECT status, paused_reason FROM app.background_tasks WHERE id = $1', [task.id]);
    expect(rows[0]).toEqual({ status: 'paused', paused_reason: 'agent_missing' });

    const empty = { title: 'Пустая', agentId: 'sales', access: { scope: 'departments', departmentIds: [], userIds: [] }, schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' };
    const res = await t.call('POST', '/app/api/admin/tasks', { cookie: igor, body: empty });
    expect(await json(res)).toMatchObject({ error: { code: 'APP_VALIDATION_FAILED', message: 'Выберите хотя бы один отдел.' } });
    expect((await t.call('GET', '/app/api/admin/tasks', { cookie: olga })).status).toBe(403);
  });

  it('gives one catch-up fire for a fire missed less than a day ago', async () => {
    const task = await newTask('Ежечасная');
    await t.db.query(`UPDATE app.background_tasks SET cron = '0 * * * *', created_at = now() - interval '3 hours', last_run_at = now() - interval '2 hours' WHERE id = $1`, [task.id]);
    t.model.script({ text: 'Догоняющий запуск.' });
    expect(await t.background.catchUp()).toContain(task.id);
    expect(await t.background.catchUp()).not.toContain(task.id);
    await t.background.idle();
  });

  it('fires by the Mastra schedule in the installation time zone', async () => {
    const task = await newTask('Каждые пять секунд');
    await t.db.query(`UPDATE app.background_tasks SET cron = '*/5 * * * * *' WHERE id = $1`, [task.id]);
    await t.background.syncSchedules();
    t.model.script({ text: 'По расписанию.' });
    await t.mastra.startWorkers();
    let runs = 0;
    for (let i = 0; i < 30 && runs === 0; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      runs = (await t.db.query('SELECT 1 FROM app.background_task_runs WHERE task_id = $1', [task.id])).rowCount ?? 0;
    }
    await t.db.query(`UPDATE app.background_tasks SET status = 'paused' WHERE id = $1`, [task.id]);
    await t.background.syncSchedules();
    await t.background.idle();
    expect(runs).toBeGreaterThan(0);
  }, 60_000);

  it('runs an agent on an event from a plugin, in its own conversation', async () => {
    t.model.script({ text: 'Разобрал письмо.' });
    const result = await t.background.startAgentRun({ agentId: 'sales', userId: olgaId, prompt: 'Пришло письмо в ящик заявок', title: 'Новое письмо' });
    expect(result.outcome).toBe('done');
    expect(result.threadId).toMatch(/^ev:/);
  });
});
