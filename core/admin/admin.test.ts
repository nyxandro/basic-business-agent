import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeJournal } from '../journal/journal.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let admin: string;
let adminId: string;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  t = await createTestApp();
  adminId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('admin sections', () => {
  it('saves organisation-wide and personal limits and pushes them to LiteLLM', async () => {
    expect((await t.call('PUT', '/app/api/admin/limits', { cookie: admin, body: { orgMonthlyRub: 50000, defaultUserMonthlyRub: 3000, defaultDailySubscriptionTokens: 400000 } })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/limits', { cookie: admin }))).toEqual({ orgMonthlyRub: 50000, defaultUserMonthlyRub: 3000, defaultDailySubscriptionTokens: 400000 });
    expect((await t.litellm.teamBalance()).maxBudget).toBe(50000);
    const olga = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
    await t.gateway.modelConfig('test-paid', olga, 'sales');
    expect((await t.call('PUT', `/app/api/admin/users/${olga}/limits`, { cookie: admin, body: { monthlyRub: 1000, dailySubscriptionTokens: null } })).status).toBe(200);
    const key = (await t.gateway.modelConfig('test-paid', olga, 'sales')).apiKey;
    expect((await t.litellm.keyBalance(key)).maxBudget).toBe(1000);
  });

  it('edits the agent prompt over the file and lists the background tasks', async () => {
    const before = await json<{ fileInstructions: string; draftVersionId: string | null }>(await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: admin }));
    const saved = await json<{ draftVersionId: string }>(await t.call('PUT', '/app/api/admin/agents/sales/prompt/draft', { cookie: admin, body: { text: 'Отвечай кратко.', baseDraftVersionId: before.draftVersionId } }));
    expect(saved.draftVersionId).toBeTruthy();
    expect((await t.call('POST', '/app/api/admin/agents/sales/prompt/publish', { cookie: admin })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: admin }))).toMatchObject({ publishedInstructions: 'Отвечай кратко.' });
    expect((await t.call('POST', '/app/api/admin/agents/sales/prompt/revert', { cookie: admin })).status).toBe(200);

    const body = { title: 'Сводка', agentId: 'sales', trigger: 'schedule', access: { scope: 'users', departmentIds: [], userIds: [adminId] }, schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' };
    expect((await t.call('POST', '/app/api/admin/tasks', { cookie: admin, body })).status).toBe(201);
    const tasks = await json<{ tasks: { title: string; cron: string }[] }>(await t.call('GET', '/app/api/admin/tasks', { cookie: admin }));
    expect(tasks.tasks.map((x) => [x.title, x.cron])).toEqual([['Сводка', '0 9 * * *']]);
  });

  it('keeps the organisation profile, masking switches and shows connections and the journal', async () => {
    const profile = { name: 'Альфа-Строй', tone: 'на «вы»', requisites: 'ИНН 7707083893', industry: 'строительство' };
    expect((await t.call('PUT', '/app/api/admin/org-profile', { cookie: admin, body: profile })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/org-profile', { cookie: admin }))).toEqual(profile);
    expect((await t.call('PUT', '/app/api/admin/masking', { cookie: admin, body: { kinds: ['passport', 'email'] } })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/masking', { cookie: admin }))).toEqual({ kinds: ['passport', 'email'] });
    expect((await t.call('GET', '/app/api/admin/connections', { cookie: admin })).status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect((await t.call('GET', `/app/api/admin/journal?from=${today}&to=${today}`, { cookie: admin })).status).toBe(200);
  });

  it('names who answered «Да» in the journal', async () => {
    await writeJournal(t.db, { userId: adminId, agentId: 'sales', runKind: 'chat', event: 'tool_call', tool: 'mail_send', approvedBy: adminId, result: 'ok' });
    const today = new Date().toISOString().slice(0, 10);
    const { entries } = await json<{ entries: { tool: string | null; approvedBy: string | null }[] }>(await t.call('GET', `/app/api/admin/journal?from=${today}&to=${today}`, { cookie: admin }));
    expect(entries.find((e) => e.tool === 'mail_send')?.approvedBy).toBe('Игорь');
  });

  it('writes every change of the admin panel to the audit trail', async () => {
    const { rows } = await t.db.query<{ action: string }>('SELECT DISTINCT action FROM app.admin_audit');
    const actions = rows.map((r) => r.action);
    for (const a of ['limits.update', 'user.limits', 'agent.prompt.draft', 'agent.prompt.publish', 'agent.prompt.revert', 'org_profile.update', 'masking.update']) expect(actions).toContain(a);
  });

  it('opens each section only to roles with its right', async () => {
    const role = await json<{ id: string }>(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Бухгалтерия', permissions: ['usage', 'journal'] } }));
    await t.createUser({ email: 'buh@example.com', roleIds: [role.id] });
    const buh = await t.signIn('buh@example.com');
    const today = new Date().toISOString().slice(0, 10);
    expect((await t.call('GET', `/app/api/admin/journal?from=${today}&to=${today}`, { cookie: buh })).status).toBe(200);
    for (const path of ['/app/api/admin/limits', '/app/api/admin/agents', '/app/api/admin/org-profile', '/app/api/admin/masking', '/app/api/admin/connections', '/app/api/admin/users']) {
      expect((await t.call('GET', path, { cookie: buh })).status, path).toBe(403);
    }
  });
});

describe('lists the related sections need', () => {
  it('lets the people who invite see roles and departments, and those who build departments see people and agents', async () => {
    const inviter = await json<{ id: string }>(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Кадры', permissions: ['users'] } }));
    await t.createUser({ email: 'hr@example.com', roleIds: [inviter.id] });
    const hr = await t.signIn('hr@example.com');
    for (const path of ['/app/api/admin/roles', '/app/api/admin/departments']) expect((await t.call('GET', path, { cookie: hr })).status, path).toBe(200);
    expect((await t.call('POST', '/app/api/admin/roles', { cookie: hr, body: { name: 'x', permissions: [] } })).status).toBe(403);

    const builder = await json<{ id: string }>(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Оргструктура', permissions: ['departments'] } }));
    await t.createUser({ email: 'org@example.com', roleIds: [builder.id] });
    const org = await t.signIn('org@example.com');
    for (const path of ['/app/api/admin/users', '/app/api/admin/agents']) expect((await t.call('GET', path, { cookie: org })).status, path).toBe(200);
    expect((await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: org })).status).toBe(403);
  });

  it('lets those who give skills and tasks to people pick departments and people', async () => {
    const giver = await json<{ id: string }>(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Методисты', permissions: ['skills'] } }));
    await t.createUser({ email: 'skills@example.com', roleIds: [giver.id] });
    const methodist = await t.signIn('skills@example.com');
    for (const path of ['/app/api/admin/people', '/app/api/admin/departments']) expect((await t.call('GET', path, { cookie: methodist })).status, path).toBe(200);
    // Only names to pick from: no e-mails, roles or blocking.
    const { people } = await json<{ people: Record<string, unknown>[] }>(await t.call('GET', '/app/api/admin/people', { cookie: methodist }));
    expect(people.find((p) => p.name === 'Игорь')).toEqual({ id: adminId, name: 'Игорь' });
    expect((await t.call('GET', '/app/api/admin/users', { cookie: methodist })).status).toBe(403);
    expect((await t.call('PUT', '/app/api/admin/departments/00000000-0000-4000-8000-000000000000', { cookie: methodist, body: { name: 'x' } })).status).toBe(403);

    const planner = await json<{ id: string }>(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Задачи', permissions: ['agents'] } }));
    await t.createUser({ email: 'tasks@example.com', roleIds: [planner.id] });
    const tasks = await t.signIn('tasks@example.com');
    for (const path of ['/app/api/admin/people', '/app/api/admin/departments']) expect((await t.call('GET', path, { cookie: tasks })).status, path).toBe(200);
    expect((await t.call('GET', '/app/api/admin/users', { cookie: tasks })).status).toBe(403);
  });

  it('shows the personal limits set on top of the defaults', async () => {
    const zoe = await t.createUser({ email: 'zoe@example.com', name: 'Зоя' });
    await t.call('PUT', `/app/api/admin/users/${zoe}/limits`, { cookie: admin, body: { monthlyRub: 700, dailySubscriptionTokens: null } });
    const { users } = await json<{ users: { userId: string; monthlyRub: number | null; dailySubscriptionTokens: number | null }[] }>(await t.call('GET', '/app/api/admin/limits/users', { cookie: admin }));
    expect(users.find((u) => u.userId === zoe)).toEqual({ userId: zoe, monthlyRub: 700, dailySubscriptionTokens: null });
  });
});

describe('removing an employee', () => {
  it('removes access, conversations, workspace and account in steps, and a repeat finishes the job', async () => {
    const petr = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
    const session = await t.signIn('petr@example.com');
    await t.gateway.modelConfig('test-paid', petr, 'sales');
    const task = { title: 'Задача Петра', agentId: 'sales', trigger: 'schedule', access: { scope: 'users', departmentIds: [], userIds: [petr] }, schedule: { kind: 'daily', time: '09:00' }, prompt: 'x' };
    expect((await t.call('POST', '/app/api/admin/tasks', { cookie: admin, body: task })).status).toBe(201);
    const workspace = join(t.workspaceRoot, petr);
    mkdirSync(join(workspace, 'files'), { recursive: true });

    // The first attempt fails at the LiteLLM step (gateway down); the person is already blocked.
    const forget = t.gateway.forgetUser.bind(t.gateway);
    t.gateway.forgetUser = () => Promise.reject(new Error('LiteLLM is down'));
    const first = await t.call('DELETE', `/app/api/admin/users/${petr}`, { cookie: admin });
    expect(first.status).toBe(500);
    expect((await json<{ error: { code: string } }>(first)).error.code).toBe('APP_ADMIN_DELETE_PARTIAL');
    expect((await t.call('GET', '/app/api/me', { cookie: session })).status).toBe(401);

    t.gateway.forgetUser = forget;
    expect((await t.call('DELETE', `/app/api/admin/users/${petr}`, { cookie: admin })).status).toBe(200);
    expect((await t.db.query('SELECT 1 FROM app."user" WHERE "id" = $1', [petr])).rowCount).toBe(0);
    expect((await t.db.query('SELECT 1 FROM app.model_keys WHERE user_id = $1', [petr])).rowCount).toBe(0);
    // The task stays; Пётр leaves its scope.
    expect((await t.db.query('SELECT 1 FROM app.task_scope WHERE user_id = $1', [petr])).rowCount).toBe(0);
    expect((await t.db.query("SELECT 1 FROM app.background_tasks WHERE title = 'Задача Петра'")).rowCount).toBe(1);
    expect(existsSync(workspace)).toBe(false);
    const audit = await t.db.query<{ action: string }>('SELECT action FROM app.admin_audit WHERE target = $1 ORDER BY id', [petr]);
    expect(audit.rows.map((r) => r.action)).toEqual(['user.delete.start', 'user.delete.start', 'user.delete.finish']);
  });

  it('does not remove the last superadmin', async () => {
    const res = await t.call('DELETE', `/app/api/admin/users/${adminId}`, { cookie: admin });
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('APP_VALIDATION_FAILED');
  });
});
