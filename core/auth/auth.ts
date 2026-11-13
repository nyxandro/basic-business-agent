// Better Auth: e-mail and password, sessions in cookies (spec, section 17.6).
// Self sign-up is off: accounts appear only through invites (core/auth/users.ts).
import { MIN_PASSWORD_LENGTH } from '@bba/contracts';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { Db } from '../db/pool.ts';

export const AUTH_BASE_PATH = '/app/api/auth';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
const SIGN_IN_WINDOW_SECONDS = 60;
const SIGN_IN_MAX_ATTEMPTS = 5;
const GENERAL_WINDOW_SECONDS = 60;
const GENERAL_MAX_REQUESTS = 300;

export interface AuthDeps {
  db: Db;
  authPool: Db;
  secret: string;
  publicUrl: string;
}

async function isBlocked(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ blocked: boolean }>(
    'SELECT (blocked_at IS NOT NULL OR deletion_started_at IS NOT NULL) AS blocked FROM app.user_profiles WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.blocked === true;
}

export function createAuth({ db, authPool, secret, publicUrl }: AuthDeps) {
  return betterAuth({
    basePath: AUTH_BASE_PATH,
    baseURL: publicUrl,
    secret,
    database: authPool,
    trustedOrigins: [new URL(publicUrl).origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD_LENGTH },
    session: { expiresIn: SESSION_TTL_SECONDS, updateAge: SESSION_REFRESH_SECONDS },
    rateLimit: {
      enabled: true,
      window: GENERAL_WINDOW_SECONDS,
      max: GENERAL_MAX_REQUESTS,
      customRules: { '/sign-in/email': { window: SIGN_IN_WINDOW_SECONDS, max: SIGN_IN_MAX_ATTEMPTS } },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (await isBlocked(db, session.userId)) {
              throw new APIError('FORBIDDEN', { code: 'APP_AUTH_BANNED', message: 'user is blocked' });
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
