// Shared HTTP helpers: one error format for every /app/api response (spec, section 17.5).
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AccessContext } from '../auth/access.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from './log.ts';

export interface AppEnv {
  Variables: { access: AccessContext };
}

export function errorJson(c: Context, error: AppError): Response {
  const body = { error: { code: error.code, message: error.userMessage, ...(error.nextStep ? { nextStep: error.nextStep } : {}) } };
  return c.json(body, error.status as ContentfulStatusCode);
}

// The address of a webhook task carries its secret (core/background/hooks.ts): it never reaches the journal.
const loggedPath = (path: string) => (path.startsWith('/app/api/hooks/') ? '/app/api/hooks/[secret]' : path);

export function handleError(error: unknown, c: Context): Response {
  if (isAppError(error)) {
    if (error.status >= 500) logEvent('error', 'request_failed', { code: error.code, path: loggedPath(c.req.path), error });
    return errorJson(c, error);
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
