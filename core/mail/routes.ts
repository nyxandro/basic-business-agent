// The mailbox in «Настройки → Подключения» and the sign-in apps in «Подключения» of the admin panel (spec,
// section 8.24). Every person connects and disconnects only their own mail.
import { MAIL_OAUTH_PROVIDERS, mailConnectSchema, mailDiscoverSchema, mailOAuthAppSchema, mailOAuthStartSchema, type MailOAuthProvider } from '@bba/contracts';
import type { Hono } from 'hono';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import type { MailService } from './service.ts';

const SETTINGS_PAGE = '/settings/connections';

function providerOf(raw: string): MailOAuthProvider {
  if (!(MAIL_OAUTH_PROVIDERS as readonly string[]).includes(raw)) throw appError('APP_NOT_FOUND', `no mail sign-in ${raw}`);
  return raw as MailOAuthProvider;
}

export function registerMailRoutes(app: Hono<AppEnv>, deps: { db: Db; mail: MailService }): void {
  const { mail } = deps;

  app.get('/app/api/me/mail', async (c) => c.json(await mail.accounts(access(c).userId)));

  app.post('/app/api/me/mail/discover', async (c) => {
    const { email } = await parseJson(c, mailDiscoverSchema);
    return c.json(await mail.discover(email));
  });

  app.post('/app/api/me/mail', async (c) => c.json(await mail.connectWithPassword(access(c).userId, await parseJson(c, mailConnectSchema))));

  app.post('/app/api/me/mail/oauth/start', async (c) => c.json({ url: await mail.oauthStart(access(c).userId, await parseJson(c, mailOAuthStartSchema)) }));

  app.delete('/app/api/me/mail/:id', async (c) => {
    await mail.disconnect(access(c).userId, c.req.param('id'));
    return c.json(await mail.accounts(access(c).userId));
  });

  // The browser comes back here from the service's sign-in page with the session cookie.
  app.get('/app/api/mail/oauth/callback', async (c) => {
    const target = new URL(SETTINGS_PAGE, new URL(c.req.url).origin);
    try {
      const state = c.req.query('state');
      const code = c.req.query('code');
      // The person refused on the service's page.
      if (c.req.query('error')) throw appError('APP_VALIDATION_FAILED', `service refused: ${c.req.query('error')}`, { userMessage: 'Вход в почту отменён.' });
      if (!state || !code) throw appError('APP_VALIDATION_FAILED', 'the service returned no code or state');
      const { email } = await mail.oauthComplete(access(c).userId, { state, code });
      target.searchParams.set('mail', email);
    } catch (error) {
      const code = isAppError(error) ? error.code : 'APP_MAIL_AUTH_FAILED';
      logEvent('warn', 'mail_oauth_callback_failed', { code, error });
      target.searchParams.set('mailError', code);
    }
    return c.redirect(`${target.pathname}${target.search}`, 302);
  });

  const right = requirePermission('connections');

  app.get('/app/api/admin/mail', right, async (c) => c.json(await mail.adminState()));

  app.put('/app/api/admin/mail/oauth/:provider', right, async (c) => {
    const provider = providerOf(c.req.param('provider'));
    await mail.saveApp(provider, await parseJson(c, mailOAuthAppSchema));
    await writeAudit(deps.db, { actorUserId: access(c).userId, action: 'mail.oauth.save', target: provider });
    return c.json(await mail.adminState());
  });

  app.delete('/app/api/admin/mail/oauth/:provider', right, async (c) => {
    const provider = providerOf(c.req.param('provider'));
    await mail.deleteApp(provider);
    await writeAudit(deps.db, { actorUserId: access(c).userId, action: 'mail.oauth.delete', target: provider });
    return c.json(await mail.adminState());
  });
}
