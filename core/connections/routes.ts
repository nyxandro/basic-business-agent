// «Настройки → Подключения» (spec, scenario 3) and the OAuth return address.
import type { Hono } from 'hono';
import { z } from 'zod';
import { isAppError } from '../errors/app-error.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import type { ConnectionManager } from './manager.ts';

const staticBody = z.object({ fields: z.record(z.string(), z.string().min(1)) });
const SETTINGS_PAGE = '/settings/connections';

export function registerConnectionRoutes(app: Hono<AppEnv>, deps: { connections: ConnectionManager }): void {
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
