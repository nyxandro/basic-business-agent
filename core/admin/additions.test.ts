// Small additions of stage 2 (spec, step 36): the organisation's name in the database, the admin's
// starter questions, spend by day, names of actions and labels of their fields, employees in total.
import type { AgentListResponse, ApprovalsResponse, MeResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureOrgName } from './org-profile.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { createTask } from '../background/tasks.ts';

let t: TestApp;
let admin: string;
let adminId: string;
let olga: string;
let olgaId: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

beforeAll(async () => {
  t = await createTestApp();
  adminId = await t.createUser({ email: 'boss@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга', departmentIds: [sales] });
  admin = await t.signIn('boss@example.com');
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('stage 2 additions', () => {
  it('takes the organisation’s name from config/app.ts once; then it is the admin’s', async () => {
    expect((await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie: olga }))).organisation).toEqual({ name: 'Альфа-Строй' });
    const profile = { name: 'ООО «Альфа-Строй»', tone: 'на «вы»', requisites: '', industry: 'строительство' };
    expect((await t.call('PUT', '/app/api/admin/org-profile', { cookie: admin, body: profile })).status).toBe(200);
    await ensureOrgName(t.db, 'Демо-организация'); // the next start of the server
    expect(await json(await t.call('GET', '/app/api/admin/org-profile', { cookie: admin }))).toEqual(profile);
    expect((await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie: olga }))).organisation).toEqual({ name: 'ООО «Альфа-Строй»' });
    // The agents see the name of the profile.
    t.model.script({ text: 'Здравствуйте.' });
    const body = { threadId: 'org-name', runId: 'r', messages: [{ id: 'm1', role: 'user', content: 'привет' }], tools: [], context: [], state: {}, forwardedProps: {} };
    await (await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie: olga, body })).text();
    expect(JSON.stringify(t.model.requests.at(-1)!.messages.filter((m) => m.role === 'system'))).toContain('Название: ООО «Альфа-Строй»');
  });

  it('has no starter questions of the empty chat any more (owner 24.11): not in the list of agents, no address to set them', async () => {
    const sales = (await json<AgentListResponse>(await t.call('GET', '/app/api/agents', { cookie: olga }))).agents.find((a) => a.id === 'sales')!;
    expect(sales).not.toHaveProperty('starters');
    expect((await t.call('PUT', '/app/api/admin/agents/sales/starters', { cookie: admin, body: { starters: ['Сводка'] } })).status).toBe(404);
  });

  it('lists the agents for the admin with who may use them, their skills and a mark of an edited prompt', async () => {
    type Agent = { id: string; access: { org: boolean; departmentIds: string[]; userIds: string[] }; skillNames: string[]; promptChanged: boolean };
    const sales = async () => (await json<{ agents: Agent[] }>(await t.call('GET', '/app/api/admin/agents', { cookie: admin }))).agents.find((a) => a.id === 'sales')!;
    const department = (await t.db.query<{ id: string }>(`SELECT id FROM app.departments WHERE name = 'Продажи'`)).rows[0]!.id;
    expect(await sales()).toMatchObject({ access: { org: false, departmentIds: [department], userIds: [] }, skillNames: [], promptChanged: false });
    expect(await sales()).not.toHaveProperty('starters');
    const draft = await json<{ draftVersionId: string }>(await t.call('PUT', '/app/api/admin/agents/sales/prompt/draft', { cookie: admin, body: { text: 'Ты агент продаж. Кратко.', baseDraftVersionId: null } }));
    expect(draft.draftVersionId).toBeTruthy();
    await t.call('POST', '/app/api/admin/agents/sales/prompt/publish', { cookie: admin, body: {} });
    expect(await sales()).toMatchObject({ promptChanged: true });
    await t.call('POST', '/app/api/admin/agents/sales/prompt/revert', { cookie: admin, body: {} });
  });

  it('offers the agent’s model by names, only while agents may choose', async () => {
    type Prompt = { allowedModels: { id: string; label: string }[] };
    const prompt = async () => json<Prompt>(await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: admin }));
    await t.db.query('UPDATE app.model_settings SET agents_choose_model = false');
    expect((await prompt()).allowedModels).toEqual([]);
    await t.db.query('UPDATE app.model_settings SET agents_choose_model = true');
    const allowed = (await prompt()).allowedModels;
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed[0]).toEqual({ id: expect.any(String), label: expect.any(String) });
    await t.db.query('UPDATE app.model_settings SET agents_choose_model = false');
  });

  it('names the organisation’s primary model next to «Основная организации», only while it is on', async () => {
    type Prompt = { primaryModel: string | null };
    const prompt = async () => json<Prompt>(await t.call('GET', '/app/api/admin/agents/sales/prompt', { cookie: admin }));
    const { rows } = await t.db.query<{ primary_model_id: string | null }>('SELECT primary_model_id FROM app.model_settings');
    const before = rows[0]!.primary_model_id;
    const { rows: chat } = await t.db.query<{ id: string; label: string }>("SELECT id, label FROM app.models WHERE kind = 'chat' AND enabled ORDER BY id LIMIT 1");
    const model = chat[0]!;
    try {
      await t.db.query('UPDATE app.model_settings SET primary_model_id = $1', [model.id]);
      expect((await prompt()).primaryModel).toBe(model.label);
      await t.db.query('UPDATE app.models SET enabled = false WHERE id = $1', [model.id]);
      expect((await prompt()).primaryModel).toBeNull();
      await t.db.query('UPDATE app.model_settings SET primary_model_id = NULL');
      expect((await prompt()).primaryModel).toBeNull();
    } finally {
      await t.db.query('UPDATE app.models SET enabled = true WHERE id = $1', [model.id]);
      await t.db.query('UPDATE app.model_settings SET primary_model_id = $1', [before]);
    }
  });

  it('names an action and the fields of its card from the tool’s description, and keeps them with a task’s question', async () => {
    const sales = (await json<AgentListResponse>(await t.call('GET', '/app/api/agents', { cookie: olga }))).agents.find((a) => a.id === 'sales')!;
    expect(sales.actions.mail_send).toEqual({ title: 'Отправить письмо клиенту', fields: { to: 'Кому', text: 'Текст письма' }, readOnly: false });

    const task = await createTask(t.tasks, adminId, {
      title: 'Письма',
      agentId: 'sales',
      access: { scope: 'users', departmentIds: [], userIds: [olgaId] },
      trigger: 'schedule',
      schedule: { kind: 'daily', time: '09:00' },
      prompt: 'Напиши клиенту',
    });
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Добрый день' } }] });
    await t.background.fire(task.id);
    await t.background.idle();
    // Even if the tool changes later, the question keeps what the employee was asked.
    const screen = await json<ApprovalsResponse>(await t.call('GET', '/app/api/approvals', { cookie: olga }));
    expect(screen.pending[0]).toMatchObject({ tool: 'mail_send', action: { title: 'Отправить письмо клиенту', fields: { to: 'Кому', text: 'Текст письма' } } });
  });

  it('counts the spend by day of the installation’s time zone', async () => {
    const day = async (at: string, cost: number) =>
      t.db.query(`INSERT INTO app.usage_events (at, user_id, agent_id, model, cost_rub, litellm_call_id) VALUES ($1, $2, 'sales', 'test-paid', $3, gen_random_uuid()::text)`, [at, olgaId, cost]);
    await day('2026-11-03T20:59:00Z', 10); // 23:59 in Moscow — 3 November
    await day('2026-11-03T21:01:00Z', 5); // 00:01 in Moscow — 4 November
    await day('2026-11-04T12:00:00Z', 2.5);
    const res = await json<{ days: { day: string; costRub: number }[] }>(await t.call('GET', '/app/api/admin/usage/daily?from=2026-11-03&to=2026-11-04', { cookie: admin }));
    expect(res.days).toEqual([
      { day: '2026-11-03', costRub: 10 },
      { day: '2026-11-04', costRub: 7.5 },
    ]);
    expect((await t.call('GET', '/app/api/admin/usage/daily?from=2026-11-03&to=2026-11-04', { cookie: olga })).status).toBe(403);
  });

  it('tells the interface the employee’s departments and whether models are set up', async () => {
    expect(await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie: olga }))).toMatchObject({ departmentNames: ['Продажи'], modelsConfigured: true });
    await t.db.query("UPDATE app.models SET enabled = false WHERE id = 'test-paid'");
    expect((await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie: olga }))).modelsConfigured).toBe(false);
    await t.db.query("UPDATE app.models SET enabled = true WHERE id = 'test-paid'");
  });

  // «Подключено у N из M» counts M by the agents of each system (core/connections/visibility.test.ts covers the count).
  it('lists the systems of plugins in «Подключения» (none in the test installation)', async () => {
    const res = await json<{ connections: unknown[] }>(await t.call('GET', '/app/api/admin/connections', { cookie: admin }));
    expect(res.connections).toEqual([]);
  });
});
