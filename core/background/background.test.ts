import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olgaId: string;
let olga: string;
let departmentId: string;

async function journalOf(taskId: string): Promise<string[]> {
  const { rows } = await t.db.query<{ event: string; result: string; error_code: string | null }>('SELECT event, result, error_code FROM app.action_journal WHERE task_id = $1 ORDER BY id', [taskId]);
  return rows.map((r) => [r.event, r.result, r.error_code].filter(Boolean).join(':'));
}

async function newTask(id: string, cron = '0 9 * * *'): Promise<void> {
  await t.background.createTask({ id, title: `Сводка ${id}`, agentId: 'sales', ownerUserId: olgaId, cron, prompt: 'Подготовь сводку по сделкам' });
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  departmentId = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [departmentId, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [departmentId]);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.sentMail.length = 0;
});

describe('background tasks', () => {
  it('runs the agent on behalf of the owner in the task’s own conversation and marks the result as new', async () => {
    await newTask('morning');
    t.model.script({ text: 'Сводка: 3 сделки без движения.' });
    expect(await t.background.runTask('morning', 'manual')).toBe('done');
    const history = (await (await t.call('GET', '/app/api/threads/bg:morning/messages', { cookie: olga })).json()) as { messages: { role: string; text: string }[] };
    expect(history.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Сводка: 3 сделки без движения.' });
    expect(await journalOf('morning')).toEqual(['background_started:started', 'background_finished:ok']);
    const notes = (await (await t.call('GET', '/app/api/me/notifications', { cookie: olga })).json()) as { unreadResults: number };
    expect(notes.unreadResults).toBe(1);
  });

  it('puts an action on the approvals screen, skips runs while it waits, and runs it after "Да"', async () => {
    await newTask('reminders');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'supplier@example.com', text: 'Напоминаем о КП' } }] });
    expect(await t.background.runTask('reminders', 'manual')).toBe('awaiting-approval');
    expect(t.sentMail).toEqual([]);

    const screen = (await (await t.call('GET', '/app/api/approvals', { cookie: olga })).json()) as { pending: { id: string; tool: string; task: string }[] };
    expect(screen.pending).toMatchObject([{ tool: 'mail_send', task: 'Сводка reminders' }]);
    expect(await t.background.runTask('reminders', 'manual')).toBe('skipped');
    expect((await journalOf('reminders')).at(-1)).toBe('background_skipped:skipped:APP_BACKGROUND_RUN_SKIPPED');

    t.model.script({ text: 'Напоминание отправлено.' });
    const decision = await t.call('POST', `/app/api/approvals/${screen.pending[0]!.id}/decision`, { cookie: olga, body: { approved: true } });
    expect(decision.status).toBe(200);
    expect(t.sentMail).toEqual([{ to: 'supplier@example.com', text: 'Напоминаем о КП' }]);
    const again = await t.call('POST', `/app/api/approvals/${screen.pending[0]!.id}/decision`, { cookie: olga, body: { approved: true } });
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('APP_APPROVAL_DECIDED');
  });

  it('lets an unanswered question expire after 72 hours without running the action, and the next run is not stuck', async () => {
    await newTask('expiring');
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'late@example.com', text: 'x' } }] }, { text: 'Хорошо.' });
    expect(await t.background.runTask('expiring', 'manual')).toBe('awaiting-approval');
    await t.db.query(`UPDATE app.approval_requests SET expires_at = now() - interval '1 minute' WHERE task_id = 'expiring'`);
    expect(await t.background.expireOverdue()).toBe(1);
    expect(t.sentMail).toEqual([]);
    expect(await journalOf('expiring')).toContain('approval_expired:expired:APP_APPROVAL_EXPIRED');
    t.model.script({ text: 'Новая сводка.' });
    expect(await t.background.runTask('expiring', 'manual')).toBe('done');
  });

  it('pauses the task when the owner no longer has access to the agent', async () => {
    await newTask('orphan');
    const other = await t.createUser({ email: 'gone@example.com' });
    await t.db.query(`UPDATE app.background_tasks SET owner_user_id = $1 WHERE id = 'orphan'`, [other]);
    expect(await t.background.runTask('orphan', 'manual')).toBe('paused');
    const { rows } = await t.db.query<{ status: string; paused_reason: string }>(`SELECT status, paused_reason FROM app.background_tasks WHERE id = 'orphan'`);
    expect(rows[0]).toEqual({ status: 'paused', paused_reason: 'owner_lost_access' });
  });

  it('gives one catch-up run for a fire missed less than a day ago', async () => {
    await newTask('hourly', '0 * * * *');
    await t.db.query(`UPDATE app.background_tasks SET created_at = now() - interval '3 hours', last_run_at = now() - interval '2 hours' WHERE id = 'hourly'`);
    t.model.script({ text: 'Догоняющий запуск.' });
    expect(await t.background.catchUp()).toEqual(['hourly']);
    expect(await t.background.catchUp()).toEqual([]);
  });

  it('fires by the Mastra schedule in the installation time zone', async () => {
    await newTask('every-five-seconds', '*/5 * * * * *');
    await t.background.syncSchedules();
    t.model.script({ text: 'По расписанию.' });
    await t.mastra.startWorkers();
    let lastRun: Date | null = null;
    for (let i = 0; i < 30 && !lastRun; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      lastRun = (await t.db.query<{ last_run_at: Date | null }>(`SELECT last_run_at FROM app.background_tasks WHERE id = 'every-five-seconds'`)).rows[0]!.last_run_at;
    }
    await t.db.query(`UPDATE app.background_tasks SET status = 'paused' WHERE id = 'every-five-seconds'`);
    await t.background.syncSchedules();
    expect(lastRun).not.toBeNull();
  }, 60_000);

  it('runs an agent on an event from a plugin, in its own conversation', async () => {
    t.model.script({ text: 'Разобрал письмо.' });
    const result = await t.background.startAgentRun({ agentId: 'sales', userId: olgaId, prompt: 'Пришло письмо в ящик заявок', title: 'Новое письмо' });
    expect(result.outcome).toBe('done');
    expect(result.threadId).toMatch(/^ev:/);
  });
});
