// Who may use an agent (owner's decision 24.11, spec section 8.15): the whole organisation, a department or an employee by
// name — set on the agent's page — and the one rule every place that asks «does this person have the agent» takes.
import type { AdminAgentsResponse, AdminDepartment, AgentAccess, AgentListResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { membersOf } from '../background/scope.ts';
import { countEmployeesWithAgents } from '../connections/audience.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let sales: string;
let igor: string;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const agentsOf = async (who: string) => (await json<AgentListResponse>(await t.call('GET', '/app/api/agents', { cookie: cookies[who]! }))).agents.map((a) => a.id).sort();
const setAccess = (agentId: string, access: AgentAccess, cookie = igor) => t.call('PUT', `/app/api/admin/agents/${agentId}/access`, { cookie, body: access });
const accessOf = async (agentId: string) => (await json<AdminAgentsResponse>(await t.call('GET', '/app/api/admin/agents', { cookie: igor }))).agents.find((a) => a.id === agentId)!.access;
const nobody: AgentAccess = { org: false, departmentIds: [], userIds: [] };

beforeAll(async () => {
  t = await createTestApp();
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  igor = await t.signIn('igor@example.com');
  ids.olga = await t.createUser({ email: 'olga@example.com', departmentIds: [sales] });
  ids.petr = await t.createUser({ email: 'petr@example.com' });
  ids.anna = await t.createUser({ email: 'anna@example.com' });
  for (const who of ['olga', 'petr', 'anna']) cookies[who] = await t.signIn(`${who}@example.com`);
});
afterAll(async () => {
  await t.close();
});

describe('access to an agent', () => {
  it('opens the agent to a department and to an employee by name at once, and to nobody else', async () => {
    expect((await setAccess('sales', { org: false, departmentIds: [sales], userIds: [ids.petr!] })).status).toBe(200);
    expect(await agentsOf('olga')).toEqual(['sales']);
    expect(await agentsOf('petr')).toEqual(['sales']);
    expect(await agentsOf('anna')).toEqual([]);
    expect(await accessOf('sales')).toEqual({ org: false, departmentIds: [sales], userIds: [ids.petr] });
  });

  it('shows the department of the agent on the department card: one link from both sides', async () => {
    const { departments } = await json<{ departments: AdminDepartment[] }>(await t.call('GET', '/app/api/admin/departments', { cookie: igor }));
    expect(departments.find((d) => d.id === sales)!.agentIds).toEqual(['sales']);
    await t.call('PUT', `/app/api/admin/departments/${sales}/agents`, { cookie: igor, body: { agentIds: ['sales', 'assistant'] } });
    expect(await accessOf('assistant')).toEqual({ org: false, departmentIds: [sales], userIds: [] });
    expect(await agentsOf('olga')).toEqual(['assistant', 'sales']);
  });

  it('opens the agent to the whole organisation and closes it to everyone', async () => {
    await setAccess('assistant', { org: true, departmentIds: [], userIds: [] });
    expect(await agentsOf('anna')).toEqual(['assistant']);
    expect(await accessOf('assistant')).toEqual({ org: true, departmentIds: [], userIds: [] });
    await setAccess('assistant', nobody);
    expect(await agentsOf('olga')).toEqual(['sales']);
    expect(await agentsOf('anna')).toEqual([]);
    // A superadministrator has every agent, whatever the lists.
    expect((await json<AgentListResponse>(await t.call('GET', '/app/api/agents', { cookie: igor }))).agents.map((a) => a.id).sort()).toEqual(['assistant', 'sales']);
  });

  it('is the same rule for a background task and for «Подключили N из M»', async () => {
    await setAccess('assistant', { org: false, departmentIds: [], userIds: [ids.anna!] });
    // A task for the whole organisation reaches those who may use its agent: Anna by name and the superadministrator.
    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const members = await membersOf(t.db, 'no-such-task', 'org', 'assistant');
    expect(members.map((m) => m.userId).sort()).toEqual([ids.anna, igorId].sort());
    // Anna by name and the superadministrator.
    expect(await countEmployeesWithAgents(t.db, ['assistant'])).toBe(2);
    await setAccess('assistant', { org: true, departmentIds: [], userIds: [] });
    expect(await countEmployeesWithAgents(t.db, ['assistant'])).toBe(4);
    await setAccess('assistant', nobody);
  });

  it('refuses departments and employees that are gone, an agent the installation has not and a role without «Агенты»', async () => {
    const gone = await setAccess('sales', { org: false, departmentIds: ['00000000-0000-4000-8000-000000000000'], userIds: [] });
    expect(gone.status).toBe(400);
    expect((await json<{ error: { code: string; message: string } }>(gone)).error).toMatchObject({ code: 'APP_VALIDATION_FAILED', message: 'Некоторых отделов или сотрудников уже нет. Обновите страницу.' });
    expect((await setAccess('sales', { org: false, departmentIds: [], userIds: ['no-such-person'] })).status).toBe(400);
    expect((await setAccess('no-such-agent', nobody)).status).toBe(404);
    expect((await setAccess('sales', nobody, cookies.olga)).status).toBe(403);
    // Nothing changed by the refused ones.
    expect(await accessOf('sales')).toEqual({ org: false, departmentIds: [sales], userIds: [ids.petr] });
  });

  it('forgets an employee who is removed', async () => {
    await t.db.query('DELETE FROM app."user" WHERE "id" = $1', [ids.petr]);
    expect(await accessOf('sales')).toEqual({ org: false, departmentIds: [sales], userIds: [] });
  });

  it('writes who changed the access into the audit', async () => {
    const { rows } = await t.db.query<{ action: string; target: string }>(`SELECT action, target FROM app.admin_audit WHERE action = 'agent.access' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toEqual({ action: 'agent.access', target: 'assistant' });
  });
});
