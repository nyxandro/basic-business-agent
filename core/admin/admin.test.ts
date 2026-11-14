import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('edits the agent prompt over the file and lists tasks without an owner', async () => {
    const before = await json<{ fileInstructions: string; draftVersionId: string | null }>(await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: admin }));
    const saved = await json<{ draftVersionId: string }>(await t.call('PUT', '/app/api/admin/agents/sales/prompt/draft', { cookie: admin, body: { text: 'Отвечай кратко.', baseDraftVersionId: before.draftVersionId } }));
    expect(saved.draftVersionId).toBeTruthy();
    expect((await t.call('POST', '/app/api/admin/agents/sales/prompt/publish', { cookie: admin })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: admin }))).toMatchObject({ publishedInstructions: 'Отвечай кратко.' });
    expect((await t.call('POST', '/app/api/admin/agents/sales/prompt/revert', { cookie: admin })).status).toBe(200);

    await t.background.createTask({ id: 'orphan-task', title: 'Сводка', agentId: 'sales', ownerUserId: adminId, cron: '0 9 * * *', prompt: 'x' });
    await t.db.query(`UPDATE app.background_tasks SET owner_user_id = NULL, status = 'paused', paused_reason = 'owner_missing' WHERE id = 'orphan-task'`);
    const tasks = await json<{ withoutOwner: { id: string }[] }>(await t.call('GET', '/app/api/admin/tasks', { cookie: admin }));
    expect(tasks.withoutOwner.map((x) => x.id)).toEqual(['orphan-task']);
  });

  it('keeps the organisation profile, masking switches and shows connections and the journal', async () => {
    expect((await t.call('PUT', '/app/api/admin/org-profile', { cookie: admin, body: { tone: 'на «вы»', requisites: 'ИНН 7707083893', industry: 'строительство' } })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/org-profile', { cookie: admin }))).toEqual({ tone: 'на «вы»', requisites: 'ИНН 7707083893', industry: 'строительство' });
    expect((await t.call('PUT', '/app/api/admin/masking', { cookie: admin, body: { kinds: ['passport', 'email'] } })).status).toBe(200);
    expect(await json(await t.call('GET', '/app/api/admin/masking', { cookie: admin }))).toEqual({ kinds: ['passport', 'email'] });
    expect((await t.call('GET', '/app/api/admin/connections', { cookie: admin })).status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect((await t.call('GET', `/app/api/admin/journal?from=${today}&to=${today}`, { cookie: admin })).status).toBe(200);
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
    await t.background.createTask({ id: 'petr-task', title: 'Задача Петра', agentId: 'sales', ownerUserId: petr, cron: '0 9 * * *', prompt: 'x' });
    const workspace = join(t.workspaceRoot, petr);
    mkdirSync(join(workspace, 'uploads'), { recursive: true });

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
    const task = await t.db.query<{ owner_user_id: string | null }>(`SELECT owner_user_id FROM app.background_tasks WHERE id = 'petr-task'`);
    expect(task.rows[0]!.owner_user_id).toBeNull();
    expect(existsSync(workspace)).toBe(false);
    const audit = await t.db.query<{ action: string }>('SELECT action FROM app.admin_audit WHERE target = $1 ORDER BY id', [petr]);
    expect(audit.rows.map((r) => r.action)).toEqual(['user.delete.start', 'user.delete.start', 'user.delete.finish']);
  });

  it('does not remove the last superadmin', async () => {
    const res = await t.call('DELETE', `/app/api/admin/users/${adminId}`, { cookie: admin });
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('APP_VALIDATION_FAILED');
  });
});
