// What a failed call of an MCP action means (docs/specs/[20.11.2026]-mcp-connections.md, step 7): by the HTTP status,
// not by words in an error's text. 401 — the access is gone; 403 — no right to this one thing, the connection stays;
// a connection lost after the server got the call — nobody knows whether it ran.
import type { McpServerInput, McpServerView } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createTestApp, TEST_ENCRYPTION_KEYS, type TestApp } from '../server/test-app.ts';
import { loadCredential } from './credentials.ts';
import { mcpConnectorId } from './servers.ts';
import { startTestMcpServer, type TestMcpServer } from './test/servers.ts';

const BASE = '/app/api/admin/mcp-servers';
const box = createSecretBox(TEST_ENCRYPTION_KEYS);
let t: TestApp;
let crm: TestMcpServer;
let admin: string;
let olga: { id: string; cookie: string };

beforeAll(async () => {
  crm = await startTestMcpServer();
  crm.acceptedTokens = new Set(['admin-key', 'olga-key', 'shared-key']);
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olga = { id: await t.createUser({ email: 'olga@example.com', departmentIds: [sales] }), cookie: await t.signIn('olga@example.com') };
});
afterAll(async () => {
  await t.close();
  await crm.close();
});

function ctx(userId: string) {
  const requestContext = new RequestContext();
  requestContext.set(REQUEST_KEYS.userId, userId);
  requestContext.set(REQUEST_KEYS.agentId, 'sales');
  return { requestContext } as never;
}

const keyField = { key: 'token', label: 'Ключ API', hint: '', secret: true };
const keyed = (auth: 'personal_key' | 'shared_key', over: Partial<McpServerInput> = {}): McpServerInput => ({
  title: 'Тестовая CRM',
  transport: 'http',
  url: crm.url,
  program: null,
  auth,
  fields: [keyField],
  headers: { Authorization: 'Bearer {{token}}' },
  env: {},
  sharedValues: auth === 'shared_key' ? { token: 'shared-key' } : null,
  client: null,
  ...over,
});

async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await t.call(method, path, { cookie, ...(body === undefined ? {} : { body }) });
  return { status: res.status, json: (await res.json()) as T };
}

async function enabled(input: McpServerInput, check = false): Promise<McpServerView> {
  const server = (await call<{ server: McpServerView }>('POST', BASE, admin, input)).json.server;
  await call('POST', `${BASE}/${server.id}/check`, admin, { values: { token: 'admin-key' } });
  const res = await call<{ server: McpServerView }>('PATCH', `${BASE}/${server.id}`, admin, {
    actions: [
      { name: 'deals_search', enabled: true, readOnly: true, title: null, check },
      { name: 'deal_create', enabled: true, readOnly: false, title: null, check: false },
    ],
    agents: ['sales'],
    status: 'enabled',
  });
  return res.json.server;
}

const toolsOf = () => t.connections.toolsFor(olga.id, { agentId: 'sales', connectorIds: [] });
const credentialStatus = async (serverId: string) => (await loadCredential(t.db, box, olga.id, mcpConnectorId(serverId), 'x'))?.status;

describe('a personal key the system no longer takes (401)', () => {
  it('marks the employee’s connection «Ошибка доступа» and says to connect again', async () => {
    const server = await enabled(keyed('personal_key'));
    await call('PUT', `/app/api/me/connections/mcp/${server.id}`, olga.cookie, { fields: { token: 'olga-key' } });
    const tools = await toolsOf();
    crm.acceptedTokens!.delete('olga-key');
    try {
      await expect(tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))).rejects.toMatchObject({ code: 'APP_CONNECTOR_AUTH_FAILED', userMessage: expect.stringContaining('Подключить заново') });
    } finally {
      crm.acceptedTokens!.add('olga-key');
    }
    expect(await credentialStatus(server.id)).toBe('auth_error');
    // The next turn explains instead of offering actions that cannot work.
    const next = await toolsOf();
    expect(Object.keys(next).filter((name) => name.startsWith(server.slug))).toEqual([`${server.slug}_connection`]);
    await expect(next[`${server.slug}_connection`]!.execute!({}, ctx(olga.id))).rejects.toMatchObject({ userMessage: expect.stringContaining('Подключить заново') });
  });
});

describe('no right to one thing (403)', () => {
  it('is an error of this action only: the connection stays', async () => {
    const server = await enabled(keyed('personal_key'));
    await call('PUT', `/app/api/me/connections/mcp/${server.id}`, olga.cookie, { fields: { token: 'olga-key' } });
    const tools = await toolsOf();
    crm.forbiddenTokens.add('olga-key');
    try {
      await expect(tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))).rejects.toMatchObject({ code: 'APP_CONNECTOR_FORBIDDEN', userMessage: expect.stringContaining('нет прав') });
    } finally {
      crm.forbiddenTokens.delete('olga-key');
    }
    expect(await credentialStatus(server.id)).not.toBe('auth_error');
    await expect(tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))).resolves.toBeTruthy();
  });
});

describe('the shared key the system no longer takes (401)', () => {
  it('marks the server «Общий ключ не принят» for the admin; a new key brings it back', async () => {
    const server = await enabled(keyed('shared_key'));
    await call('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: true });
    const tools = await toolsOf();
    crm.acceptedTokens!.delete('shared-key');
    await expect(tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))).rejects.toMatchObject({ code: 'APP_CONNECTOR_AUTH_FAILED' });
    const view = (await call<{ server: McpServerView }>('GET', `${BASE}/${server.id}`, admin)).json.server;
    expect(view).toMatchObject({ status: 'shared_auth_error', statusErrorCode: 'APP_CONNECTOR_AUTH_FAILED' });

    crm.acceptedTokens!.add('new-shared-key');
    const renewed = await call<{ server: McpServerView }>('PATCH', `${BASE}/${server.id}`, admin, { sharedValues: { token: 'new-shared-key' } });
    expect(renewed.json.server.status).toBe('enabled');
    const fresh = await toolsOf();
    await expect(fresh[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))).resolves.toBeTruthy();
  });
});

describe('a server turned off while failing', () => {
  it('is not turned on again before the cure: a new shared key', async () => {
    // The test above leaves the system refusing «shared-key».
    crm.acceptedTokens!.add('shared-key');
    const server = await enabled(keyed('shared_key'));
    await call('POST', `/app/api/me/connections/mcp/${server.id}/use`, olga.cookie, { on: true });
    const tools = await toolsOf();
    crm.acceptedTokens!.delete('shared-key');
    try {
      await expect(tools[`${server.slug}_deals_search`]!.execute!({}, ctx(olga.id))).rejects.toMatchObject({ code: 'APP_CONNECTOR_AUTH_FAILED' });
    } finally {
      crm.acceptedTokens!.add('shared-key');
    }
    await call('PATCH', `${BASE}/${server.id}`, admin, { status: 'disabled' });
    const refused = await call<{ error: { message: string } }>('PATCH', `${BASE}/${server.id}`, admin, { status: 'enabled' });
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toContain('общий ключ');
    await call('PATCH', `${BASE}/${server.id}`, admin, { sharedValues: { token: 'shared-key' } });
    expect((await call<{ server: McpServerView }>('PATCH', `${BASE}/${server.id}`, admin, { status: 'enabled' })).json.server.status).toBe('enabled');
  });
});

describe('a connection lost after the system got the call', () => {
  it('says the outcome is unknown and does not call again', async () => {
    const server = await enabled(keyed('personal_key'));
    await call('PUT', `/app/api/me/connections/mcp/${server.id}`, olga.cookie, { fields: { token: 'olga-key' } });
    const tools = await toolsOf();
    crm.dropCalls.add('deal_create');
    crm.requested.length = 0;
    try {
      await expect(tools[`${server.slug}_deal_create`]!.execute!({ title: 'Поставка' }, ctx(olga.id))).rejects.toMatchObject({
        code: 'APP_CONNECTOR_UNKNOWN_OUTCOME',
        userMessage: expect.stringContaining('неизвестно, выполнилось ли действие'),
      });
    } finally {
      crm.dropCalls.delete('deal_create');
    }
    expect(await credentialStatus(server.id)).not.toBe('auth_error');
  });
});

describe('the check of a key at saving', () => {
  it('refuses a key the system does not take and keeps the connection «Ошибка доступа»', async () => {
    const server = await enabled(keyed('personal_key'), true);
    const refused = await call<{ error: { code: string; message: string } }>('PUT', `/app/api/me/connections/mcp/${server.id}`, olga.cookie, { fields: { token: 'wrong-key' } });
    expect(refused.json.error.code).toBe('APP_CONNECTOR_AUTH_FAILED');
    expect(refused.json.error.message).toContain('не приняла ключ');
    expect(await credentialStatus(server.id)).toBe('auth_error');
    const accepted = await call<{ status: string }>('PUT', `/app/api/me/connections/mcp/${server.id}`, olga.cookie, { fields: { token: 'olga-key' } });
    expect(accepted.json.status).toBe('connected');
  });
});
