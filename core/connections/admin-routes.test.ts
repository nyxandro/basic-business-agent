// «Подключения» → «Сервер MCP» of the admin panel (docs/specs/[20.11.2026]-mcp-connections.md, step 3): who may do
// it, a server from the address to «Включить», keys for the check, and what deleting takes away.
import type { McpServerInput, McpServerView } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveCredential } from './credentials.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { createTestApp, TEST_ENCRYPTION_KEYS, type TestApp } from '../server/test-app.ts';
import { mcpConnectorId } from './servers.ts';
import { startTestMcpServer, type TestMcpServer } from './test/servers.ts';

const BASE = '/app/api/admin/mcp-servers';
let t: TestApp;
let crm: TestMcpServer;
let keyed: TestMcpServer;
let admin: string;
let employee: string;

beforeAll(async () => {
  [crm, keyed] = await Promise.all([startTestMcpServer(), startTestMcpServer()]);
  keyed.acceptedTokens = new Set(['igor-key', 'shared-key']);
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  await t.createUser({ email: 'olga@example.com' });
  admin = await t.signIn('igor@example.com');
  employee = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
  await Promise.all([crm.close(), keyed.close()]);
});

const server = (over: Partial<McpServerInput>): McpServerInput => ({
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
const keyField = { key: 'token', label: 'Ключ API', hint: 'Настройки → Интеграции', secret: true };

async function call<T>(method: string, path: string, body?: unknown, cookie = admin): Promise<{ status: number; json: T }> {
  const res = await t.call(method, path, { cookie, ...(body === undefined ? {} : { body }) });
  return { status: res.status, json: (await res.json()) as T };
}
type Failure = { error: { code: string; message: string } };

async function created(input: McpServerInput): Promise<McpServerView> {
  const res = await call<{ server: McpServerView }>('POST', BASE, input);
  expect(res.status).toBe(200);
  return res.json.server;
}

describe('the right «Подключения»', () => {
  it('is needed to see, look at an address and add servers', async () => {
    expect((await call<Failure>('GET', BASE, undefined, employee)).status).toBe(403);
    expect((await call<Failure>('POST', `${BASE}/probe`, { url: crm.url, fields: [], values: {} }, employee)).status).toBe(403);
    const refused = await call<Failure>('POST', BASE, server({}), employee);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('APP_ADMIN_FORBIDDEN');
  });
});

describe('a server from the address to «Включить»', () => {
  it('is looked at, added as a draft for every agent, checked, and turned on with the actions the admin chose', async () => {
    expect((await call('POST', `${BASE}/probe`, { url: crm.url, fields: [], values: {} })).json).toEqual({ auth: 'none' });

    const draft = await created(server({}));
    expect(draft).toMatchObject({ status: 'draft', actions: [], snapshotAt: null, agents: [...t.registry.ids()].sort() });

    const early = await call<Failure>('PATCH', `${BASE}/${draft.id}`, { status: 'enabled' });
    expect(early.status).toBe(400);
    expect(early.json.error.message).toContain('проверьте сервер');

    const checked = (await call<{ server: McpServerView }>('POST', `${BASE}/${draft.id}/check`, { values: {} })).json.server;
    expect(checked.actions.map((a) => [a.name, a.modelName, a.enabled, a.isNew])).toEqual([
      ['deals_search', `${draft.slug}_deals_search`, false, false],
      ['deal_create', `${draft.slug}_deal_create`, false, false],
    ]);
    expect(checked.status).toBe('draft');

    const nothingOn = await call<Failure>('PATCH', `${BASE}/${draft.id}`, { status: 'enabled' });
    expect(nothingOn.json.error.message).toContain('хотя бы одно действие');

    const enabled = await call<{ server: McpServerView }>('PATCH', `${BASE}/${draft.id}`, {
      actions: [{ name: 'deals_search', enabled: true, readOnly: true, title: 'Поиск сделок', check: false }],
      agents: ['sales'],
      status: 'enabled',
    });
    expect(enabled.status).toBe(200);
    expect(enabled.json.server).toMatchObject({ status: 'enabled', agents: ['sales'] });
    expect(enabled.json.server.actions.find((a) => a.name === 'deals_search')).toMatchObject({ enabled: true, readOnly: true, title: 'Поиск сделок' });

    const audit = await t.db.query<{ action: string }>('SELECT action FROM app.admin_audit WHERE target = $1 ORDER BY id', [draft.id]);
    // Refused changes write nothing: only what happened is in the audit.
    expect(audit.rows.map((r) => r.action)).toEqual(['mcp_server.create', 'mcp_server.update']);
  });

  it('keeps the address and the way of sign-in of a server in use', async () => {
    const draft = await created(server({}));
    const moved = await call<{ server: McpServerView }>('PATCH', `${BASE}/${draft.id}`, { definition: server({ title: 'CRM', url: keyed.url, auth: 'personal_key', fields: [keyField], headers: { Authorization: 'Bearer {{token}}' } }) });
    expect(moved.json.server).toMatchObject({ title: 'CRM', url: keyed.url, auth: 'personal_key' });

    await call('POST', `${BASE}/${draft.id}/check`, { values: { token: 'igor-key' } });
    await call('PATCH', `${BASE}/${draft.id}`, { actions: [{ name: 'deals_search', enabled: true, readOnly: true, title: null, check: true }], status: 'enabled' });
    const refused = await call<Failure>('PATCH', `${BASE}/${draft.id}`, { definition: server({}) });
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toContain('черновик');
    const keys = await call<Failure>('PATCH', `${BASE}/${draft.id}`, { fields: [{ ...keyField, key: 'api_key' }] });
    expect(keys.json.error.message).toContain('Ключи полей не меняются');
    const labels = await call<{ server: McpServerView }>('PATCH', `${BASE}/${draft.id}`, { fields: [{ ...keyField, label: 'Токен' }] });
    expect(labels.json.server.fields[0]!.label).toBe('Токен');
  });

  it('refuses http to an address on the internet', async () => {
    const res = await call<Failure>('POST', BASE, server({ url: 'http://8.8.8.8/mcp' }));
    expect(res.status).toBe(400);
    expect(res.json.error.message).toContain('https://');
  });

  it('answers «no such connection» to an unknown or malformed id', async () => {
    expect((await call<Failure>('GET', `${BASE}/00000000-0000-4000-8000-000000000000`)).json.error.code).toBe('APP_NOT_FOUND');
    expect((await call<Failure>('GET', `${BASE}/not-an-id`)).json.error.code).toBe('APP_NOT_FOUND');
  });
});

describe('the check with a key', () => {
  it('uses the admin’s own key, asks for it when missing and says when the system refuses it', async () => {
    const draft = await created(server({ url: keyed.url, auth: 'personal_key', fields: [keyField], headers: { Authorization: 'Bearer {{token}}' } }));
    const missing = await call<Failure>('POST', `${BASE}/${draft.id}/check`, { values: {} });
    expect(missing.status).toBe(400);
    expect(missing.json.error.message).toContain('Ключ API');

    const wrong = await call<Failure>('POST', `${BASE}/${draft.id}/check`, { values: { token: 'wrong-key' } });
    expect(wrong.json.error.code).toBe('APP_CONNECTOR_AUTH_FAILED');
    expect(wrong.json.error.message).toContain('не приняла ключ');

    keyed.seen.length = 0;
    const checked = await call<{ server: McpServerView }>('POST', `${BASE}/${draft.id}/check`, { values: { token: 'igor-key' } });
    expect(checked.json.server.actions).toHaveLength(2);
    expect(new Set(keyed.seen.map((h) => h.authorization))).toEqual(new Set(['Bearer igor-key']));
    // The admin's key served the check and is kept nowhere.
    const kept = await t.db.query('SELECT 1 FROM app.connector_credentials WHERE connector_id = $1', [mcpConnectorId(draft.id)]);
    expect(kept.rowCount).toBe(0);
  });

  it('takes the shared key from the sealed secrets and never shows it back', async () => {
    const draft = await created(server({ url: keyed.url, auth: 'shared_key', fields: [keyField], headers: { Authorization: 'Bearer {{token}}' }, sharedValues: { token: 'shared-key' } }));
    keyed.seen.length = 0;
    const checked = await call<{ server: McpServerView }>('POST', `${BASE}/${draft.id}/check`, { values: {} });
    expect(checked.json.server.actions).toHaveLength(2);
    expect(new Set(keyed.seen.map((h) => h.authorization))).toEqual(new Set(['Bearer shared-key']));
    const listed = await t.call('GET', BASE, { cookie: admin });
    expect(await listed.text()).not.toContain('shared-key');
  });
});

describe('deleting a server', () => {
  it('takes away the sign-ins and keys of employees and who turned it on', async () => {
    const draft = await created(server({}));
    const olga = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'olga@example.com'`)).rows[0]!.id;
    const box = createSecretBox(TEST_ENCRYPTION_KEYS);
    await saveCredential(t.db, box, { userId: olga, connectorId: mcpConnectorId(draft.id), credential: { kind: 'static', fields: { token: 'olga-key' } }, status: 'connected' });
    await t.db.query('INSERT INTO app.mcp_server_users (server_id, user_id) VALUES ($1, $2)', [draft.id, olga]);

    expect((await call('DELETE', `${BASE}/${draft.id}`)).status).toBe(200);
    const left = await t.db.query(
      `SELECT (SELECT count(*) FROM app.connector_credentials WHERE connector_id = $1)::int AS credentials,
              (SELECT count(*) FROM app.mcp_server_users WHERE server_id = $2)::int AS users,
              (SELECT count(*) FROM app.mcp_server_agents WHERE server_id = $2)::int AS agents`,
      [mcpConnectorId(draft.id), draft.id],
    );
    expect(left.rows[0]).toEqual({ credentials: 0, users: 0, agents: 0 });
    expect((await call<Failure>('GET', `${BASE}/${draft.id}`)).json.error.code).toBe('APP_NOT_FOUND');
  });
});
