// What an agent's turn gets of the MCP servers the admin added (docs/specs/[20.11.2026]-mcp-connections.md, step 6):
// only the actions the admin turned on, from the snapshot, of servers the employee uses, without waiting for them.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServerInput, McpServerView } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { startTestMcpServer, type TestMcpServer } from './test/servers.ts';

// A read-only tool waits for «Да» only while an approval rule is on it (docs/specs/[20.11.2026]-multi-step-approvals.md):
// its `requireApproval` asks the rules; without a rule it does not ask.
const asksYes = async (tool: { requireApproval?: unknown }): Promise<unknown> => (typeof tool.requireApproval === 'function' ? await (tool.requireApproval as () => Promise<boolean>)() : tool.requireApproval);

const BASE = '/app/api/admin/mcp-servers';
let t: TestApp;
let crm: TestMcpServer;
let silent: Server;
let admin: string;
let olga: { id: string; cookie: string };
let petr: { id: string; cookie: string };

beforeAll(async () => {
  crm = await startTestMcpServer();
  silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olga = { id: await t.createUser({ email: 'olga@example.com', departmentIds: [sales] }), cookie: await t.signIn('olga@example.com') };
  // Пётр — без отдела: агенты «Продаж» ему не доступны.
  petr = { id: await t.createUser({ email: 'petr@example.com' }), cookie: await t.signIn('petr@example.com') };
});
afterAll(async () => {
  await t.close();
  await crm.close();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

function ctx(userId: string) {
  const requestContext = new RequestContext();
  requestContext.set(REQUEST_KEYS.userId, userId);
  requestContext.set(REQUEST_KEYS.agentId, 'sales');
  return { requestContext } as never;
}

const input = (over: Partial<McpServerInput>): McpServerInput => ({
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

async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await t.call(method, path, { cookie, ...(body === undefined ? {} : { body }) });
  return { status: res.status, json: (await res.json()) as T };
}

// A server the admin added, checked and turned on for «Продажи» with the given actions.
async function enabled(over: Partial<McpServerInput>, actions: { name: string; readOnly: boolean }[], checkValues: Record<string, string> = {}): Promise<McpServerView> {
  const server = (await call<{ server: McpServerView }>('POST', BASE, admin, input(over))).json.server;
  await call('POST', `${BASE}/${server.id}/check`, admin, { values: checkValues });
  const res = await call<{ server: McpServerView }>('PATCH', `${BASE}/${server.id}`, admin, {
    actions: actions.map((a) => ({ ...a, enabled: true, title: null, check: false })),
    agents: ['sales'],
    status: 'enabled',
  });
  expect(res.json.server.status).toBe('enabled');
  return res.json.server;
}

const toolsOf = (userId: string, agentId = 'sales') => t.connections.toolsFor(userId, { agentId, connectorIds: [] });

describe('an agent of an employee', () => {
  it('gets only the actions the admin turned on, of a server the employee uses', async () => {
    const server = await enabled({}, [{ name: 'deals_search', readOnly: true }]);
    expect(await toolsOf(olga.id)).toEqual({});

    expect((await call('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: true })).status).toBe(200);
    const tools = await toolsOf(olga.id);
    expect(Object.keys(tools)).toEqual([`${server.slug}_deals_search`]);
    expect(await asksYes(tools[`${server.slug}_deals_search`]!)).toBe(false);
    // The server's answer as MCP gives it: the text the model reads.
    const answer = (await tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))) as { content: { text: string }[] };
    expect(JSON.parse(answer.content[0]!.text)).toEqual({ deals: 12 });
    expect(await toolsOf(olga.id, 'assistant')).toEqual({});

    await call('PATCH', `${BASE}/${server.id}`, admin, { actions: [{ name: 'deal_create', enabled: true, readOnly: false, title: 'Новая сделка', check: false }] });
    const both = await toolsOf(olga.id);
    expect(await asksYes(both[`${server.slug}_deal_create`]!)).toBe(true);
    expect(t.connections.actionsSeen()[`${server.slug}_deal_create`]).toMatchObject({ title: 'Новая сделка', readOnly: false });

    await call('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: false });
    expect(await toolsOf(olga.id)).toEqual({});
  });

  it('gets nothing of a server the admin turned off', async () => {
    const server = await enabled({}, [{ name: 'deals_search', readOnly: true }]);
    await call('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: true });
    await call('PATCH', `${BASE}/${server.id}`, admin, { status: 'disabled' });
    expect(Object.keys(await toolsOf(olga.id)).filter((name) => name.startsWith(server.slug))).toEqual([]);
    expect((await call<{ error: { code: string } }>('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: true })).json.error.code).toBe('APP_NOT_FOUND');
  });

  it('cannot use a server none of the employee’s agents may use', async () => {
    const server = await enabled({}, [{ name: 'deals_search', readOnly: true }]);
    const refused = await call<{ error: { code: string } }>('POST', `/app/api/me/connections/mcp/${server.id}/use`, petr.cookie, { on: true });
    expect(refused.json.error.code).toBe('APP_NOT_FOUND');
  });

  it('sends the employee’s own key, encoded once in the address', async () => {
    const keyField = { key: 'token', label: 'Ключ API', hint: '', secret: true };
    const server = await enabled({ url: `${crm.url}?key={{token}}`, auth: 'personal_key', fields: [keyField] }, [{ name: 'deals_search', readOnly: true }], { token: 'admin-key' });
    const saved = await call<{ status: string }>('PUT', `/app/api/me/connections/mcp/${server.id}`, olga.cookie, { fields: { token: 'a/b {{token}}' } });
    expect(saved.json.status).toBe('unverified');

    crm.requested.length = 0;
    const tools = await toolsOf(olga.id);
    await tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id));
    expect(crm.requested.length).toBeGreaterThan(0);
    expect(new Set(crm.requested)).toEqual(new Set(['/mcp?key=a%2Fb%20%7B%7Btoken%7D%7D']));

    expect((await call('DELETE', `/app/api/me/connections/mcp/${server.id}`, olga.cookie)).status).toBe(200);
    expect(Object.keys(await toolsOf(olga.id)).filter((name) => name.startsWith(server.slug))).toEqual([]);
  });

  it('does not wait for a silent server: the turn starts, the server is asked only when an action is called', async () => {
    const server = await enabled({}, [{ name: 'deals_search', readOnly: true }]);
    await call('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: true });
    await t.db.query('UPDATE app.mcp_servers SET url = $2 WHERE id = $1', [server.id, `http://127.0.0.1:${(silent.address() as AddressInfo).port}/mcp`]);
    const started = Date.now();
    const tools = await toolsOf(olga.id);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(tools[`${server.slug}_deals_search`]).toBeDefined();
  });
});
