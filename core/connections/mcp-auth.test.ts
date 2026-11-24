// The sign-in on the system's site for MCP servers (docs/specs/[20.11.2026]-mcp-connections.md, step 4): by the MCP
// standard, the app registered once per server, tokens of each employee their own, refreshed ahead under a lock,
// and no sign-in started in the middle of an agent's turn.
import type { McpServerInput, McpServerView } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { POOL_MAX } from '../db/pool.ts';
import { createTestApp, TEST_ENCRYPTION_KEYS, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { loadCredential, saveCredential } from './credentials.ts';
import { assertSignInPossible, clientDocument, clientDocumentUrl, MCP_CALLBACK_PATH, MCP_CLIENT_DOCUMENT_PATH, mcpAccessToken, startMcpSignIn } from './mcp-auth.ts';
import { mcpConnectorId } from './servers.ts';
import { startTestMcpServer, startTestOAuthServer, type TestMcpServer, type TestOAuthServer } from './test/servers.ts';

const BASE = '/app/api/admin/mcp-servers';
const box = createSecretBox(TEST_ENCRYPTION_KEYS);
let t: TestApp;
let idp: TestOAuthServer;
let crm: TestMcpServer;
let admin: string;
const people: Record<string, { id: string; cookie: string }> = {};

beforeAll(async () => {
  idp = await startTestOAuthServer({ dynamicRegistration: true });
  crm = await startTestMcpServer({ signIn: { where: 'challenge', authorizationServer: idp.issuer } });
  // The system takes every token its sign-in issued.
  crm.acceptedTokens = idp.accessTokens;
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
  // «Подключить» is offered for the servers of one's own agents: the employees are in the department of «Продажи».
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  for (const name of ['olga', 'petr', 'anna']) {
    const id = await t.createUser({ email: `${name}@example.com`, departmentIds: [sales] });
    people[name] = { id, cookie: await t.signIn(`${name}@example.com`) };
  }
});
afterAll(async () => {
  await t.close();
  await Promise.all([idp.close(), crm.close()]);
});

const deps = () => ({ db: t.db, box, publicUrl: TEST_PUBLIC_URL });
const oauthServer = (url: string, over: Partial<McpServerInput> = {}): McpServerInput => ({
  title: 'Битрикс24',
  transport: 'http',
  url,
  program: null,
  auth: 'oauth',
  fields: [],
  headers: {},
  env: {},
  sharedValues: null,
  client: null,
  ...over,
});

async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T; location: string | null }> {
  const res = await t.call(method, path, { cookie, ...(body === undefined ? {} : { body }) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T, location: res.headers.get('location') };
}

async function created(input: McpServerInput): Promise<McpServerView> {
  return (await call<{ server: McpServerView }>('POST', BASE, admin, input)).json.server;
}

// The person on the system's site: the authorization page answers at once, the browser comes back with the code.
async function signInOnSite(url: string, cookie: string): Promise<string | null> {
  const authorize = await fetch(url, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  expect(back.pathname).toBe(MCP_CALLBACK_PATH);
  return (await call('GET', `${back.pathname}${back.search}`, cookie)).location;
}

async function enabledServer(): Promise<McpServerView> {
  const server = await created(oauthServer(crm.url));
  const started = await call<{ url: string }>('POST', `${BASE}/${server.id}/sign-in`, admin);
  expect(await signInOnSite(started.json.url, admin)).toBe(`/admin/connections?mcp=${server.id}&signedIn=1`);
  await call('POST', `${BASE}/${server.id}/check`, admin, { values: {} });
  const enabled = await call<{ server: McpServerView }>('PATCH', `${BASE}/${server.id}`, admin, {
    actions: [{ name: 'deals_search', enabled: true, readOnly: true, title: null, check: false }],
    status: 'enabled',
  });
  expect(enabled.json.server.status).toBe('enabled');
  return enabled.json.server;
}

describe('the admin checks a server with a sign-in', () => {
  it('signs in with their own account first, then gets the actions', async () => {
    const server = await created(oauthServer(crm.url));
    const before = await call<{ error: { code: string; message: string } }>('POST', `${BASE}/${server.id}/check`, admin, { values: {} });
    expect(before.json.error.code).toBe('APP_CONNECTOR_NOT_CONNECTED');
    expect(before.json.error.message).toContain('Войдите');

    const started = await call<{ url: string }>('POST', `${BASE}/${server.id}/sign-in`, admin);
    expect(await signInOnSite(started.json.url, admin)).toBe(`/admin/connections?mcp=${server.id}&signedIn=1`);
    const checked = await call<{ server: McpServerView }>('POST', `${BASE}/${server.id}/check`, admin, { values: {} });
    expect(checked.json.server.actions.map((a) => a.name)).toEqual(['deals_search', 'deal_create']);
  });
});

describe('employees sign in', () => {
  it('registers the app once per server, even when two start at once', async () => {
    const server = await created(oauthServer(crm.url));
    const before = idp.registrations.length;
    const [a, b] = await Promise.all([
      startMcpSignIn(deps(), { userId: people.olga!.id, serverId: server.id, purpose: 'check' }),
      startMcpSignIn(deps(), { userId: people.petr!.id, serverId: server.id, purpose: 'check' }),
    ]);
    expect(new URL(a).searchParams.get('client_id')).toBe(new URL(b).searchParams.get('client_id'));
    expect(idp.registrations.length - before).toBe(1);
  });

  it('keeps each employee’s tokens apart and turns the server on for whoever connected', async () => {
    const server = await enabledServer();
    for (const name of ['olga', 'petr']) {
      const started = await call<{ url: string }>('POST', `/app/api/me/connections/mcp/${server.id}/sign-in`, people[name]!.cookie);
      expect(await signInOnSite(started.json.url, people[name]!.cookie)).toBe(`/settings/connections?connected=${encodeURIComponent(mcpConnectorId(server.id))}`);
    }
    const olga = await mcpAccessToken(deps(), { userId: people.olga!.id, serverId: server.id });
    const petr = await mcpAccessToken(deps(), { userId: people.petr!.id, serverId: server.id });
    expect(olga).not.toBe(petr);
    expect(idp.accessTokens.has(olga) && idp.accessTokens.has(petr)).toBe(true);
    const using = await t.db.query<{ user_id: string }>('SELECT user_id FROM app.mcp_server_users WHERE server_id = $1 ORDER BY user_id', [server.id]);
    expect(using.rows.map((r) => r.user_id).sort()).toEqual([people.olga!.id, people.petr!.id].sort());
  });

  it('refuses an answer from another sign-in server (iss) and keeps nothing', async () => {
    const server = await enabledServer();
    const anna = people.anna!;
    const started = await call<{ url: string }>('POST', `/app/api/me/connections/mcp/${server.id}/sign-in`, anna.cookie);
    idp.issInAnswer = 'https://evil.example.com';
    try {
      const back = await signInOnSite(started.json.url, anna.cookie);
      expect(back).toBe(`/settings/connections?error=APP_CONNECTOR_AUTH_FAILED&connector=${encodeURIComponent(mcpConnectorId(server.id))}`);
    } finally {
      idp.issInAnswer = null;
    }
    expect(await loadCredential(t.db, box, anna.id, mcpConnectorId(server.id), 'x')).toBeNull();
  });

  it('cannot connect a server the admin has not turned on', async () => {
    const draft = await created(oauthServer(crm.url));
    const refused = await call<{ error: { code: string } }>('POST', `/app/api/me/connections/mcp/${draft.id}/sign-in`, people.olga!.cookie);
    expect(refused.json.error.code).toBe('APP_NOT_FOUND');
  });
});

describe('the token of an employee', () => {
  let serverId: string;
  const olgaToken = () => mcpAccessToken(deps(), { userId: people.olga!.id, serverId });
  const refreshes = () => idp.tokenRequests.filter((grant) => grant === 'refresh_token').length;
  async function expiresIn(ms: number, refreshToken?: string) {
    const record = await loadCredential(t.db, box, people.olga!.id, mcpConnectorId(serverId), 'x');
    if (record?.credential.kind !== 'oauth') throw new Error('olga has no sign-in to the server');
    const credential = { ...record.credential, expiresAt: new Date(Date.now() + ms).toISOString(), ...(refreshToken ? { refreshToken } : {}) };
    await saveCredential(t.db, box, { userId: people.olga!.id, connectorId: mcpConnectorId(serverId), credential, status: 'connected' });
  }

  beforeAll(async () => {
    const server = await enabledServer();
    serverId = server.id;
    const started = await call<{ url: string }>('POST', `/app/api/me/connections/mcp/${serverId}/sign-in`, people.olga!.cookie);
    await signInOnSite(started.json.url, people.olga!.cookie);
  });

  it('is used as is while far from expiry, and refreshed ahead of it', async () => {
    const before = refreshes();
    const token = await olgaToken();
    expect(await olgaToken()).toBe(token);
    expect(refreshes()).toBe(before);

    await expiresIn(60_000);
    const fresh = await olgaToken();
    expect(fresh).not.toBe(token);
    expect(refreshes()).toBe(before + 1);
  });

  it('is refreshed once when two requests need it at the same time', async () => {
    await expiresIn(60_000);
    const before = refreshes();
    const [a, b] = await Promise.all([olgaToken(), olgaToken()]);
    expect(a).toBe(b);
    expect(refreshes()).toBe(before + 1);
  });

  // Each waiting request used to hold a connection of the pool while the one refreshing asked the pool for another: with
  // more requests than connections nobody got one, and the whole server hung (review 24.11).
  it('is refreshed once, and nobody hangs, when more requests than the pool has connections need it at once', async () => {
    await expiresIn(60_000);
    const before = refreshes();
    const all = Promise.all(Array.from({ length: POOL_MAX + 5 }, () => olgaToken()));
    const tokens = await Promise.race([all, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the pool hung')), 10_000))]);
    expect(new Set(tokens).size).toBe(1);
    expect(refreshes()).toBe(before + 1);
  });

  it('is not lost when the system cannot refresh it right now: the system is unavailable, the access stays', async () => {
    await expiresIn(1_000);
    try {
      for (const status of [503, 502]) {
        idp.refreshDown = status;
        await expect(olgaToken()).rejects.toMatchObject({ code: 'APP_CONNECTOR_UNAVAILABLE' });
      }
    } finally {
      idp.refreshDown = null;
    }
    expect((await loadCredential(t.db, box, people.olga!.id, mcpConnectorId(serverId), 'x'))!.status).toBe('connected');
    await expect(olgaToken()).resolves.toBeTruthy();
  });

  it('that no longer refreshes asks to connect again, without starting a sign-in in the middle of a turn', async () => {
    await expiresIn(1_000, 'rt-revoked');
    const states = async () => Number((await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.oauth_states WHERE user_id = $1', [people.olga!.id])).rows[0]!.n);
    const statesBefore = await states();
    await expect(olgaToken()).rejects.toMatchObject({ code: 'APP_CONNECTOR_AUTH_FAILED' });
    expect((await loadCredential(t.db, box, people.olga!.id, mcpConnectorId(serverId), 'x'))!.status).toBe('auth_error');
    expect(await states()).toBe(statesBefore);
  });
});

describe('the app of the system', () => {
  it('is the one the admin registered when the system does not register apps itself', async () => {
    const closed = await startTestOAuthServer();
    const system = await startTestMcpServer({ signIn: { where: 'well-known', authorizationServer: closed.issuer } });
    system.acceptedTokens = closed.accessTokens;
    try {
      const server = await created(oauthServer(system.url, { client: { clientId: closed.clientId, clientSecret: closed.clientSecret } }));
      const started = await call<{ url: string }>('POST', `${BASE}/${server.id}/sign-in`, admin);
      expect(new URL(started.json.url).searchParams.get('client_id')).toBe(closed.clientId);
      expect(await signInOnSite(started.json.url, admin)).toBe(`/admin/connections?mcp=${server.id}&signedIn=1`);
      expect(closed.registrations).toEqual([]);

      const without = await created(oauthServer(system.url));
      const refused = await call<{ error: { code: string; message: string } }>('POST', `${BASE}/${without.id}/sign-in`, admin);
      expect(refused.json.error.code).toBe('APP_MCP_OAUTH_REGISTRATION');
      expect(refused.json.error.message).toContain(`${TEST_PUBLIC_URL}${MCP_CALLBACK_PATH}`);
    } finally {
      await Promise.all([closed.close(), system.close()]);
    }
  });

  it('signs in only on an installation opened by https, or on this machine', () => {
    expect(() => assertSignInPossible('http://localhost:8080', 'Битрикс24')).not.toThrow();
    expect(() => assertSignInPossible('http://127.0.0.1:3000', 'Битрикс24')).not.toThrow();
    expect(() => assertSignInPossible('https://agent.example.com', 'Битрикс24')).not.toThrow();
    expect(() => assertSignInPossible('http://agent.example.com', 'Битрикс24')).toThrow(expect.objectContaining({ code: 'APP_MCP_OAUTH_NEEDS_HTTPS' }));
  });

  it('has a client document only where the system can download it: an installation on public https', async () => {
    expect(clientDocumentUrl('https://agent.example.com')).toBe(`https://agent.example.com${MCP_CLIENT_DOCUMENT_PATH}`);
    expect(clientDocument('https://agent.example.com')).toMatchObject({ client_id: `https://agent.example.com${MCP_CLIENT_DOCUMENT_PATH}`, token_endpoint_auth_method: 'none' });
    for (const inner of ['https://localhost', 'https://10.0.0.5', 'http://agent.example.com']) expect(clientDocumentUrl(inner)).toBeUndefined();
    // This test installation is on http://localhost: the address answers without a session, and there is no document.
    const res = await t.call('GET', MCP_CLIENT_DOCUMENT_PATH);
    expect(res.status).toBe(404);
  });
});
