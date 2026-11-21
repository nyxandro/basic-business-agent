// «Настройки → Подключения» (spec, scenario 3) and the OAuth return addresses: of plugins (per connector) and of
// MCP servers the admin added (one address, docs/specs/[20.11.2026]-mcp-connections.md, section 17).
import type { Hono } from 'hono';
import { z } from 'zod';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import { signInNotFinished } from './errors.ts';
import type { ConnectionManager } from './manager.ts';
import { clientDocument, completeMcpSignIn, MCP_CALLBACK_PATH, MCP_CLIENT_DOCUMENT_PATH, startMcpSignIn, type SignInPurpose } from './mcp-auth.ts';
import { mcpConnectorId } from './servers.ts';

const staticBody = z.object({ fields: z.record(z.string(), z.string().min(1)) });
const SETTINGS_PAGE = '/settings/connections';

const ADMIN_PAGE = '/admin/connections';

// Where the browser lands after a sign-in to an MCP server: the admin's check goes back to the admin panel.
function afterSignIn(origin: string, serverId: string | undefined, purpose: SignInPurpose | undefined, errorCode: string | null): string {
  const check = purpose === 'check' && serverId;
  const target = new URL(check ? ADMIN_PAGE : SETTINGS_PAGE, origin);
  if (check) target.searchParams.set('mcp', serverId);
  if (errorCode) {
    target.searchParams.set('error', errorCode);
    if (!check && serverId) target.searchParams.set('connector', mcpConnectorId(serverId));
  } else if (check) {
    target.searchParams.set('signedIn', '1');
  } else if (serverId) {
    target.searchParams.set('connected', mcpConnectorId(serverId));
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

  // «Подключить» a server the admin added and turned on (the owner's decision F2, 21.11).
  app.post('/app/api/me/connections/mcp/:id/sign-in', async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw appError('APP_NOT_FOUND', `mcp server id ${id} is not a uuid`, { userMessage: 'Это подключение сейчас недоступно. Обновите страницу.' });
    return c.json({ url: await startMcpSignIn(deps, { userId: access(c).userId, serverId: id, purpose: 'connect' }) });
  });

  // The browser comes back from the sign-in of an MCP server with the session cookie.
  app.get(MCP_CALLBACK_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const state = c.req.query('state');
    const code = c.req.query('code');
    try {
      // No code: the person cancelled on the system's site, or the system refused.
      if (!state || !code) throw signInNotFinished('систему', {});
      const done = await completeMcpSignIn(deps, { userId: access(c).userId, state, code, iss: c.req.query('iss') });
      return c.redirect(afterSignIn(origin, done.serverId, done.purpose, null), 302);
    } catch (error) {
      const errorCode = isAppError(error) ? error.code : 'APP_CONNECTOR_AUTH_FAILED';
      const details = (isAppError(error) ? error.details : undefined) as { serverId?: string; purpose?: SignInPurpose } | undefined;
      logEvent('warn', 'connector_auth_failed', { serverId: details?.serverId ?? null, code: errorCode, error });
      return c.redirect(afterSignIn(origin, details?.serverId, details?.purpose, errorCode), 302);
    }
  });

  // The client document, read by the system without a session (only on an installation opened by public https).
  app.get(MCP_CLIENT_DOCUMENT_PATH, (c) => {
    const document = clientDocument(deps.publicUrl);
    if (!document) throw appError('APP_NOT_FOUND', 'no client document on an installation without public https');
    return c.json(document);
  });

  // The browser comes back here from the system's sign-in page with the session cookie.
  app.get('/app/api/connections/:id/oauth/callback', async (c) => {
    const id = c.req.param('id');
    const state = c.req.query('state');
    const code = c.req.query('code');
    const target = new URL(SETTINGS_PAGE, new URL(c.req.url).origin);
    try {
      if (!state || !code) throw new Error('APP_VALIDATION_FAILED: the system returned no code or state');
      await connections.oauthComplete(access(c).userId, id, { state, code });
      target.searchParams.set('connected', id);
    } catch (error) {
      logEvent('warn', 'oauth_callback_failed', { connectorId: id, code: isAppError(error) ? error.code : 'APP_CONNECTOR_AUTH_FAILED', error });
      target.searchParams.set('error', isAppError(error) ? error.code : 'APP_CONNECTOR_AUTH_FAILED');
      target.searchParams.set('connector', id);
    }
    return c.redirect(`${target.pathname}${target.search}`, 302);
  });
}
