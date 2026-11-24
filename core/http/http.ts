// Shared HTTP helpers: one error format for every /app/api response (spec, section 17.5).
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AccessContext } from '../auth/access.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { isConnectionLost, isPoolExhausted } from '../db/pool.ts';
import { logEvent } from '../log/log.ts';

export interface AppEnv {
  Variables: { access: AccessContext };
}

export function errorJson(c: Context, error: AppError): Response {
  const body = { error: { code: error.code, message: error.userMessage, ...(error.nextStep ? { nextStep: error.nextStep } : {}) } };
  return c.json(body, error.status as ContentfulStatusCode);
}

// The address of a webhook task carries its secret (core/background/hooks.ts): it never reaches the journal.
const loggedPath = (path: string) => (path.startsWith('/app/api/hooks/') ? '/app/api/hooks/[secret]' : path);

// A failure of the database itself is told as such: the person tries again, the journal has its code.
function databaseFailure(error: unknown): AppError | null {
  if (isPoolExhausted(error)) return appError('APP_SERVER_BUSY', 'no free connection to the database in time', { cause: error });
  if (isConnectionLost(error)) return appError('APP_DB_CONNECTION_LOST', 'the database dropped the connection of the request', { cause: error });
  return null;
}

export function handleError(error: unknown, c: Context): Response {
  const known = isAppError(error) ? error : databaseFailure(error);
  if (known) {
    if (known.status >= 500) logEvent('error', 'request_failed', { code: known.code, path: loggedPath(c.req.path), error: known });
    return errorJson(c, known);
  }
  logEvent('error', 'request_failed', { code: 'APP_INTERNAL', path: loggedPath(c.req.path), error });
  return errorJson(c, appError('APP_INTERNAL', 'unexpected error', { cause: error }));
}

export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (error) {
    throw appError('APP_VALIDATION_FAILED', 'request body is not JSON', { cause: error });
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map((i) => i.path.join('.'));
  if (fields.includes('password')) throw appError('APP_PASSWORD_TOO_SHORT', 'password is too short');
  throw appError('APP_VALIDATION_FAILED', `invalid request body: ${fields.join(', ')}`, { details: { fields } });
}

export function access(c: Context<AppEnv>): AccessContext {
  return c.get('access');
}
