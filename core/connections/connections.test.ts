import { randomBytes } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createTestApp, TEST_ENCRYPTION_KEYS, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { loadCredential, saveCredential } from './credentials.ts';
import { IDENTITY_HEADER, verifyIdentity } from './identity.ts';
import type { ConnectorRuntime } from './manager.ts';
import { accessToken, MCP_CALLBACK_PATH, pluginTarget } from './mcp-auth.ts';
import { startTestMcpServer, startTestOAuthServer, type TestMcpServer, type TestOAuthServer } from './test/servers.ts';

// A read-only tool waits for «Да» only while an approval rule is on it (docs/specs/[20.11.2026]-multi-step-approvals.md):
// its `requireApproval` asks the rules; without a rule it does not ask.
const asksYes = async (tool: { requireApproval?: unknown }): Promise<unknown> => (typeof tool.requireApproval === 'function' ? await (tool.requireApproval as () => Promise<boolean>)() : tool.requireApproval);

let t: TestApp;
let crm: TestMcpServer;
let shared: TestMcpServer;
let oauthCrm: TestMcpServer;
let idp: TestOAuthServer;
const IDENTITY_SECRET = randomBytes(32).toString('hex');

function ctx(userId: string) {
  const requestContext = new RequestContext();
  requestContext.set(REQUEST_KEYS.userId, userId);
  requestContext.set(REQUEST_KEYS.agentId, 'sales');
  return { requestContext } as never;
}

beforeAll(async () => {
  crm = await startTestMcpServer();
  shared = await startTestMcpServer();
  oauthCrm = await startTestMcpServer();
  idp = await startTestOAuthServer();
  const connectors: ConnectorRuntime[] = [
    {
      id: 'crm',
      title: 'Тестовая CRM',
      mode: 'personal',
      auth: 'static',
      readOnly: new Set(['deals_search']),
      checkTool: 'deals_search',
      definition: { url: crm.url, staticFields: [{ name: 'token', label: 'Ключ', secret: true }], headers: (c) => ({ Authorization: `Bearer ${c.kind === 'static' ? c.fields.token : ''}` }) },
    },
    { id: 'company-mcp', title: 'Наш сервер', mode: 'shared', auth: 'identity', readOnly: new Set(['deals_search']), definition: { url: shared.url, identitySecret: IDENTITY_SECRET } },
    {
      id: 'oauth-crm',
      title: 'CRM с входом через сайт',
      mode: 'personal',
      auth: 'oauth',
      readOnly: new Set(['deals_search']),
      definition: { url: oauthCrm.url, oauth: { authorizeUrl: idp.authorizeUrl, tokenUrl: idp.tokenUrl, clientId: idp.clientId, clientSecret: idp.clientSecret, scopes: ['crm'] } },
    },
  ];
  t = await createTestApp({ connectors });
});
afterAll(async () => {
  await t.close();
  await Promise.all([crm.close(), shared.close(), oauthCrm.close(), idp.close()]);
});

describe('personal access with a key', () => {
  it('sends each employee’s own key with their calls', async () => {
    const olga = await t.createUser({ email: 'olga@example.com' });
    const igor = await t.createUser({ email: 'igor@example.com' });
    crm.acceptedTokens = new Set(['olga-key', 'igor-key']);
    expect(await t.connections.saveStatic(olga, 'crm', { token: 'olga-key' })).toBe('connected');
    expect(await t.connections.saveStatic(igor, 'crm', { token: 'igor-key' })).toBe('connected');

    for (const [user, key] of [[olga, 'olga-key'], [igor, 'igor-key']] as const) {
      crm.seen.length = 0;
      const tools = await t.connections.toolsFor(user, { agentId: 'sales', connectorIds: ['crm'] });
      await tools.crm_deals_search!.execute!({}, ctx(user));
      expect(new Set(crm.seen.map((h) => h.authorization))).toEqual(new Set([`Bearer ${key}`]));
    }
  });

  it('asks for "Да" on server tools that are not read-only', async () => {
    const olga = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'olga@example.com'`)).rows[0]!.id;
    const tools = await t.connections.toolsFor(olga, { agentId: 'sales', connectorIds: ['crm'] });
    expect(await asksYes(tools.crm_deals_search!)).toBe(false);
    expect(await asksYes(tools.crm_deal_create!)).toBe(true);
  });

  it('tells an employee without a connection to connect, with a link to the settings', async () => {
    const petr = await t.createUser({ email: 'petr@example.com' });
    const tools = await t.connections.toolsFor(petr, { agentId: 'sales', connectorIds: ['crm'] });
    expect(Object.keys(tools)).toEqual(['crm_connection']);
    await expect(tools.crm_connection!.execute!({}, ctx(petr))).rejects.toMatchObject({
      code: 'APP_CONNECTOR_NOT_CONNECTED',
      userMessage: 'Чтобы агент работал с Тестовая CRM от вашего имени, подключите её в настройках → «Подключения».',
    });
  });

  it('keeps the connection when the system refuses one record (403) — only a 401 breaks it', async () => {
    const olga = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'olga@example.com'`)).rows[0]!.id;
    const tools = await t.connections.toolsFor(olga, { agentId: 'sales', connectorIds: ['crm'] });
    crm.forbiddenTokens.add('olga-key');
    try {
      await expect(tools.crm_deals_search!.execute!({}, ctx(olga))).rejects.toBeTruthy();
    } finally {
      crm.forbiddenTokens.delete('olga-key');
    }
    expect((await t.connections.statusFor(olga, new Set(['crm', 'oauth-crm']))).find((c) => c.id === 'crm')?.status).toBe('connected');
  });

  it('refuses a wrong key at save time and marks the connection as failed', async () => {
    const anna = await t.createUser({ email: 'anna@example.com' });
    await expect(t.connections.saveStatic(anna, 'crm', { token: 'wrong' })).rejects.toMatchObject({ code: 'APP_CONNECTOR_AUTH_FAILED' });
    expect((await t.connections.statusFor(anna, new Set(['crm', 'oauth-crm']))).find((c) => c.id === 'crm')?.status).toBe('auth_error');
  });

  it('cannot read a stored key after the encryption key is gone', async () => {
    const user = await t.createUser({ email: 'rotated@example.com' });
    const oldBox = createSecretBox(`7:${randomBytes(32).toString('base64')}`);
    await saveCredential(t.db, oldBox, { userId: user, connectorId: 'crm', credential: { kind: 'static', fields: { token: 'x' } }, status: 'connected' });
    await expect(loadCredential(t.db, createSecretBox(TEST_ENCRYPTION_KEYS), user, 'crm', 'Тестовая CRM')).rejects.toMatchObject({ code: 'APP_CONNECTOR_DECRYPT_FAILED' });
  });
});

describe('shared server with a signed identity', () => {
  it('signs who is asking into every call', async () => {
    const olga = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'olga@example.com'`)).rows[0]!.id;
    const tools = await t.connections.toolsFor(olga, { agentId: 'sales', connectorIds: ['company-mcp'] });
    shared.seen.length = 0;
    await tools.company_mcp_deals_search!.execute!({}, ctx(olga));
    const identities = shared.seen.map((h) => verifyIdentity(h[IDENTITY_HEADER] as string | undefined, IDENTITY_SECRET)).filter(Boolean);
    expect(identities.length).toBeGreaterThan(0);
    expect(identities.every((i) => i!.userId === olga && i!.email === 'olga@example.com')).toBe(true);
  });
});

describe('personal access through OAuth (the plugin names its sign-in addresses; one sign-in for all, F4)', () => {
  const authDeps = () => ({ db: t.db, box: createSecretBox(TEST_ENCRYPTION_KEYS), publicUrl: TEST_PUBLIC_URL });
  const plugin = () =>
    pluginTarget({ id: 'oauth-crm', title: 'CRM', url: oauthCrm.url, oauth: { authorizeUrl: idp.authorizeUrl, tokenUrl: idp.tokenUrl, clientId: idp.clientId, clientSecret: idp.clientSecret, scopes: ['crm'] } });

  it('signs in on the system’s site, calls with the token and refreshes it ahead of expiry under a lock', async () => {
    const userId = await t.createUser({ email: 'oauth@example.com' });
    const cookie = await t.signIn('oauth@example.com');
    const started = (await (await t.call('POST', '/app/api/me/connections/oauth-crm/oauth/start', { cookie })).json()) as { url: string };
    const authorize = await fetch(started.url, { redirect: 'manual' });
    const callback = new URL(authorize.headers.get('location')!);
    expect(callback.pathname).toBe(MCP_CALLBACK_PATH);
    expect(new URL(started.url).searchParams.get('scope')).toBe('crm');
    const back = await t.call('GET', `${callback.pathname}${callback.search}`, { cookie });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/settings/connections?connected=oauth-crm');

    oauthCrm.acceptedTokens = idp.accessTokens;
    const tools = await t.connections.toolsFor(userId, { agentId: 'sales', connectorIds: ['oauth-crm'] });
    await expect(tools.oauth_crm_deals_search!.execute!({}, ctx(userId))).resolves.toBeTruthy();

    // Make the token look almost expired: two parallel requests must refresh once, not burn the single-use refresh token twice.
    await t.db.query(`UPDATE app.connector_credentials SET expires_at = now() WHERE user_id = $1`, [userId]);
    const box = createSecretBox(TEST_ENCRYPTION_KEYS);
    const record = await loadCredential(t.db, box, userId, 'oauth-crm', 'x');
    await saveCredential(t.db, box, { userId, connectorId: 'oauth-crm', credential: { ...(record!.credential as object), expiresAt: new Date(Date.now() + 1000).toISOString() } as never, status: 'connected' });
    idp.refreshUses.length = 0;
    const [a, b] = await Promise.all([accessToken(authDeps(), plugin(), userId), accessToken(authDeps(), plugin(), userId)]);
    expect(a).toBe(b);
    expect(idp.refreshUses).toHaveLength(1);
    expect((await t.connections.statusFor(userId, new Set(['crm', 'oauth-crm']))).find((c) => c.id === 'oauth-crm')?.status).toBe('connected');
  });

  it('marks the connection for reconnecting when the refresh token no longer works', async () => {
    const userId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'oauth@example.com'`)).rows[0]!.id;
    const box = createSecretBox(TEST_ENCRYPTION_KEYS);
    await saveCredential(t.db, box, { userId, connectorId: 'oauth-crm', credential: { kind: 'oauth', accessToken: 'old', refreshToken: 'rt-revoked', expiresAt: new Date().toISOString() }, status: 'connected' });
    await expect(accessToken(authDeps(), plugin(), userId)).rejects.toMatchObject({ code: 'APP_CONNECTOR_AUTH_FAILED' });
    expect((await t.connections.statusFor(userId, new Set(['crm', 'oauth-crm']))).find((c) => c.id === 'oauth-crm')?.status).toBe('auth_error');
  });
});
