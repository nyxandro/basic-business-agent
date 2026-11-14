// Routes of sign-in and of the invite and reset links, plus GET /me.
import { passwordBodySchema, type MeResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { access, errorJson, parseJson, type AppEnv } from '../server/http.ts';
import { AUTH_BASE_PATH, type Auth } from './auth.ts';
import { acceptInvite, acceptPasswordReset, findInvite, findPasswordReset } from './users.ts';
import { recognitionModel } from '../voice/transcribe.ts';
import { orgName } from '../admin/org-profile.ts';
import { modelsConfigured } from '../models/resolve.ts';

const SIGN_IN_PATH = `${AUTH_BASE_PATH}/sign-in/email`;
const HTTP_TOO_MANY_REQUESTS = 429;

// Better Auth answers sign-in errors in its own format; translate them to ours.
async function translateSignInError(res: Response): Promise<ReturnType<typeof appError> | null> {
  if (res.status < 400) return null;
  if (res.status === HTTP_TOO_MANY_REQUESTS) return appError('APP_AUTH_RATE_LIMITED', 'sign-in rate limit');
  const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
  if (body.code === 'APP_AUTH_BANNED') return appError('APP_AUTH_BANNED', 'blocked user tried to sign in');
  if (body.code === 'INVALID_EMAIL_OR_PASSWORD') return appError('APP_AUTH_INVALID_CREDENTIALS', 'wrong e-mail or password');
  return null;
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: { db: Db; auth: Auth }): void {
  const { db, auth } = deps;

  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, async (c) => {
    const res = await auth.handler(c.req.raw);
    if (c.req.path !== SIGN_IN_PATH) return res;
    const translated = await translateSignInError(res);
    return translated ? errorJson(c, translated) : res;
  });

  app.get('/app/api/invites/:token', async (c) => c.json(await findInvite(db, c.req.param('token'))));
  app.post('/app/api/invites/:token/accept', async (c) => {
    const { password } = await parseJson(c, passwordBodySchema);
    return c.json(await acceptInvite(db, auth, c.req.param('token'), password));
  });

  app.get('/app/api/password-resets/:token', async (c) => c.json(await findPasswordReset(db, c.req.param('token'))));
  app.post('/app/api/password-resets/:token/accept', async (c) => {
    const { password } = await parseJson(c, passwordBodySchema);
    return c.json(await acceptPasswordReset(db, auth, c.req.param('token'), password));
  });

  app.get('/app/api/me', async (c) => {
    const a = access(c);
    const body: MeResponse = {
      user: { id: a.userId, email: a.email, name: a.name },
      permissions: [...a.permissions],
      isSuperadmin: a.isSuperadmin,
      departmentIds: a.departmentIds,
      voiceAvailable: (await recognitionModel(deps.db)) !== null,
      organisation: { name: await orgName(deps.db) },
      departmentNames: (await deps.db.query<{ name: string }>('SELECT d.name FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = $1 ORDER BY d.name', [a.userId])).rows.map((r) => r.name),
      modelsConfigured: await modelsConfigured(deps.db),
    };
    return c.json(body);
  });
}
