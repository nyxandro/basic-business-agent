// «Настройки → Подключения» (spec, scenario 3) and the one return address of the sign-in on a system's site, for MCP
// servers the admin added and for plugins alike (docs/specs/[20.11.2026]-mcp-connections.md, section 17, F4).
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { mcpFieldValueSchema } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import { signInNotFinished } from './errors.ts';
import type { ConnectionManager } from './manager.ts';
import { clientDocument, completeSignIn, MCP_CALLBACK_PATH, MCP_CLIENT_DOCUMENT_PATH, mcpTarget, startMcpSignIn, type SignInPurpose } from './mcp-auth.ts';
import { disconnectServer, savePersonalKey, useServer, type EmployeeAgents } from './employee-servers.ts';
import { loadOAuthServer, mcpConnectorId, serverForEmployee } from './servers.ts';

const staticBody = z.object({ fields: z.record(z.string(), z.string().min(1)) });
const useBody = z.object({ on: z.boolean() });
const keyBody = z.object({ fields: z.record(z.string(), mcpFieldValueSchema) });
const SETTINGS_PAGE = '/settings/connections';

const ADMIN_PAGE = '/admin/connections';

const MCP_PREFIX = mcpConnectorId('');

// Where the browser lands after a sign-in: the admin's check of an MCP server goes back to the admin panel.
function afterSignIn(origin: string, connectorId: string | undefined, purpose: SignInPurpose | undefined, errorCode: string | null): string {
  const serverId = connectorId?.startsWith(MCP_PREFIX) ? connectorId.slice(MCP_PREFIX.length) : undefined;
  const check = purpose === 'check' && serverId;
  const target = new URL(check ? ADMIN_PAGE : SETTINGS_PAGE, origin);
  if (check) target.searchParams.set('mcp', serverId);
  if (errorCode) {
    target.searchParams.set('error', errorCode);
    if (!check && connectorId) target.searchParams.set('connector', connectorId);
  } else if (check) {
    target.searchParams.set('signedIn', '1');
  } else if (connectorId) {
    target.searchParams.set('connected', connectorId);
  }
  return `${target.pathname}${target.search}`;
}

export interface ConnectionRouteDeps {
  connections: ConnectionManager;
  db: Db;
  box: SecretBox;
  publicUrl: string;
}

export function registerConnectionRoutes(app: Hono<AppEnv>, deps: ConnectionRouteDeps): void {
  const { connections } = deps;

  app.get('/app/api/me/connections', async (c) => c.json({ connections: await connections.statusFor(access(c).userId) }));

  app.put('/app/api/me/connections/:id', async (c) => {
    const { fields } = await parseJson(c, staticBody);
    return c.json({ status: await connections.saveStatic(access(c).userId, c.req.param('id'), fields) });
  });

  app.delete('/app/api/me/connections/:id', async (c) => {
    await connections.disconnect(access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/app/api/me/connections/:id/oauth/start', async (c) => c.json({ url: await connections.oauthStart(access(c).userId, c.req.param('id')) }));

  // The MCP servers the admin added and allowed for the employee's agents (the owner's decision F2, 21.11).
  const employee = { db: deps.db, box: deps.box, mcp: connections.mcp };
  const agentsOf = (c: Context<AppEnv>): EmployeeAgents => (access(c).isSuperadmin ? 'all' : access(c).agentIds);
  const mcpServerId = (c: Context<AppEnv>) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw appError('APP_NOT_FOUND', `mcp server id ${id} is not a uuid`, { userMessage: 'Это подключение сейчас недоступно. Обновите страницу.' });
    return id!;
  };

  // «Подключить» through the system's site.
  app.post('/app/api/me/connections/mcp/:id/sign-in', async (c) => {
    const id = mcpServerId(c);
    await serverForEmployee(deps.db, deps.box, id, agentsOf(c));
    return c.json({ url: await startMcpSignIn(deps, { userId: access(c).userId, serverId: id, purpose: 'connect' }) });
  });

  // «Использовать» a server without a sign-in or with the shared key.
  app.post('/app/api/me/connections/mcp/:id/use', async (c) => {
    const { on } = await parseJson(c, useBody);
    await useServer(employee, { userId: access(c).userId, agents: agentsOf(c), serverId: mcpServerId(c), on });
    return c.json({ ok: true });
  });

  // «Подключить» with the employee's own key.
  app.put('/app/api/me/connections/mcp/:id', async (c) => {
    const { fields } = await parseJson(c, keyBody);
    return c.json({ status: await savePersonalKey(employee, { userId: access(c).userId, agents: agentsOf(c), serverId: mcpServerId(c), fields }) });
  });

  app.delete('/app/api/me/connections/mcp/:id', async (c) => {
    await disconnectServer(employee, { userId: access(c).userId, serverId: mcpServerId(c) });
    return c.json({ ok: true });
  });

  // Whom a sign-in was for: an MCP server of the admin, or a plugin's system.
  const targetOf = async (connectorId: string) =>
    connectorId.startsWith(MCP_PREFIX) ? mcpTarget(deps, await loadOAuthServer(deps.db, deps.box, connectorId.slice(MCP_PREFIX.length))) : connections.signInTarget(connectorId);

  // The browser comes back here from the system's sign-in page with the session cookie.
  app.get(MCP_CALLBACK_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const state = c.req.query('state');
    const code = c.req.query('code');
    try {
      // No code: the person cancelled on the system's site, or the system refused.
      if (!state || !code) throw signInNotFinished('систему', {});
      const done = await completeSignIn(deps, { userId: access(c).userId, state, code, iss: c.req.query('iss') }, targetOf);
      return c.redirect(afterSignIn(origin, done.connectorId, done.purpose, null), 302);
    } catch (error) {
      const errorCode = isAppError(error) ? error.code : 'APP_CONNECTOR_AUTH_FAILED';
      const details = (isAppError(error) ? error.details : undefined) as { connectorId?: string; purpose?: SignInPurpose } | undefined;
      logEvent('warn', 'connector_auth_failed', { connectorId: details?.connectorId ?? null, code: errorCode, error });
      return c.redirect(afterSignIn(origin, details?.connectorId, details?.purpose, errorCode), 302);
    }
  });

  // The client document, read by the system without a session (only on an installation opened by public https).
  app.get(MCP_CLIENT_DOCUMENT_PATH, (c) => {
    const document = clientDocument(deps.publicUrl);
    if (!document) throw appError('APP_NOT_FOUND', 'no client document on an installation without public https');
    return c.json(document);
  });
}
