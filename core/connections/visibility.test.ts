// Who sees what (docs/specs/[20.11.2026]-mcp-connections.md, step 8): an employee sees only the servers the admin
// turned on for their agents — never a draft; the admin sees how many of those who could use a server use it.
import type { McpServerInput, McpServerView, MyMcpServer } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { createTestApp, TEST_ENCRYPTION_KEYS, type TestApp } from '../server/test-app.ts';
import { saveCredential } from './credentials.ts';
import { mcpConnectorId } from './servers.ts';
import { startTestMcpServer, type TestMcpServer } from './test/servers.ts';

const BASE = '/app/api/admin/mcp-servers';
let t: TestApp;
let crm: TestMcpServer;
let admin: string;
const people: Record<string, { id: string; cookie: string }> = {};

beforeAll(async () => {
  crm = await startTestMcpServer();
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  for (const [name, departments] of [['olga', [sales]], ['anna', [sales]], ['petr', []]] as const) {
    people[name] = { id: await t.createUser({ email: `${name}@example.com`, departmentIds: [...departments] }), cookie: await t.signIn(`${name}@example.com`) };
  }
});
afterAll(async () => {
  await t.close();
  await crm.close();
});

const input = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  title: 'Тестовая CRM',
  transport: 'http',
  url: crm.url,
  program: null,
  auth: 'none',
  fields: [],
  headers: {},
  env: {},
  sharedValues: null,
  client: null,
  ...over,
});

async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<T> {
  const res = await t.call(method, path, { cookie, ...(body === undefined ? {} : { body }) });
  return (await res.json()) as T;
}

async function server(over: Partial<McpServerInput>, enable: boolean): Promise<McpServerView> {
  const created = (await call<{ server: McpServerView }>('POST', BASE, admin, input(over))).server;
  if (!enable) return created;
  await call('POST', `${BASE}/${created.id}/check`, admin, { values: { token: 'admin-key' } });
  return (
    await call<{ server: McpServerView }>('PATCH', `${BASE}/${created.id}`, admin, {
      actions: [{ name: 'deals_search', enabled: true, readOnly: true, title: null, check: false }],
      agents: ['sales'],
      status: 'enabled',
    })
  ).server;
}

const listOf = async (name: string) => (await call<{ servers: MyMcpServer[] }>('GET', '/app/api/me/connections/mcp', people[name]!.cookie)).servers;

describe('«Настройки → Подключения» of an employee', () => {
  it('shows the servers the admin turned on for the employee’s agents, and never a draft', async () => {
    const draft = await server({ title: 'Черновик' }, false);
    const shared = await server({ title: 'Склад' }, true);
    const olga = await listOf('olga');
    expect(olga.map((s) => s.id)).toContain(shared.id);
    expect(olga.map((s) => s.id)).not.toContain(draft.id);
    expect(olga.find((s) => s.id === shared.id)).toMatchObject({ title: 'Склад', auth: 'none', using: false, agents: ['Продажи'], trouble: null });
    // Пётр — без отдела: агентов «Продаж» у него нет.
    expect((await listOf('petr')).map((s) => s.id)).not.toContain(shared.id);

    await call('POST', `/app/api/me/connections/mcp/${shared.id}/use`, people.olga!.cookie, { on: true });
    expect((await listOf('olga')).find((s) => s.id === shared.id)?.using).toBe(true);
  });

  it('shows the state of the employee’s own key', async () => {
    const keyed = await server({ title: 'МойСклад', url: `${crm.url}?key={{token}}`, auth: 'personal_key', fields: [{ key: 'token', label: 'Ключ API', hint: 'Настройки → Интеграции', secret: true }] }, true);
    expect((await listOf('anna')).find((s) => s.id === keyed.id)).toMatchObject({ status: 'not_connected', fields: [{ key: 'token', label: 'Ключ API' }] });
    await call('PUT', `/app/api/me/connections/mcp/${keyed.id}`, people.anna!.cookie, { fields: { token: 'anna-key' } });
    expect((await listOf('anna')).find((s) => s.id === keyed.id)?.status).toBe('unverified');
  });
});

describe('«Подключения» of the admin', () => {
  it('counts the employees out of those whose agents may use the server', async () => {
    const keyed = await server({ title: 'Битрикс24', url: `${crm.url}?key={{token}}`, auth: 'personal_key', fields: [{ key: 'token', label: 'Ключ API', hint: '', secret: true }] }, true);
    const box = createSecretBox(TEST_ENCRYPTION_KEYS);
    await saveCredential(t.db, box, { userId: people.olga!.id, connectorId: mcpConnectorId(keyed.id), credential: { kind: 'static', fields: { token: 'o' } }, status: 'connected' });
    await saveCredential(t.db, box, { userId: people.anna!.id, connectorId: mcpConnectorId(keyed.id), credential: { kind: 'static', fields: { token: 'a' } }, status: 'auth_error' });
    const view = (await call<{ server: McpServerView }>('GET', `${BASE}/${keyed.id}`, admin)).server;
    // Игорь (суперадминистратор), Ольга и Анна — у них есть агент «Продажи»; Пётр — нет.
    expect(view.usage).toEqual({ using: 0, connected: 1, authErrors: 1, possible: 3 });
  });
});
