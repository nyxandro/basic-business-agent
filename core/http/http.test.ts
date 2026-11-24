// What a person gets when the database cannot serve a request: a code and a plain text, never a hang or «что-то пошло не так».
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { handleError } from './http.ts';

function appThrowing(error: unknown): Hono {
  const app = new Hono();
  app.onError(handleError);
  app.get('/app/api/x', () => {
    throw error;
  });
  return app;
}

const body = async (res: Response) => (await res.json()) as { error: { code: string; message: string } };

describe('handleError', () => {
  it('answers «сервер перегружен» when every connection to the database stayed taken', async () => {
    const res = await appThrowing(new Error('timeout exceeded when trying to connect')).request('/app/api/x');
    expect(res.status).toBe(503);
    expect((await body(res)).error.code).toBe('APP_SERVER_BUSY');
  });

  it('answers «связь с базой прервалась» when the database dropped the connection of the request', async () => {
    for (const lost of [new Error('Connection terminated unexpectedly'), Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })]) {
      const res = await appThrowing(lost).request('/app/api/x');
      expect(res.status).toBe(503);
      expect((await body(res)).error.code).toBe('APP_DB_CONNECTION_LOST');
    }
  });

  // Better Auth checks the session first in every request and wraps any failure of the database in its own error.
  it('looks through the errors that wrap a failure of the database', async () => {
    const wrapped = (cause: Error) => Object.assign(new Error('Failed to get session'), { cause });
    const busy = await appThrowing(wrapped(new Error('timeout exceeded when trying to connect'))).request('/app/api/x');
    expect((await body(busy)).error.code).toBe('APP_SERVER_BUSY');
    const tooMany = await appThrowing(wrapped(Object.assign(new Error('sorry, too many clients already'), { code: '53300' }))).request('/app/api/x');
    expect((await body(tooMany)).error.code).toBe('APP_SERVER_BUSY');
    for (const lost of [Object.assign(new Error('the database system is starting up'), { code: '57P03' }), new Error('Connection terminated due to connection timeout')]) {
      const res = await appThrowing(wrapped(lost)).request('/app/api/x');
      expect((await body(res)).error.code).toBe('APP_DB_CONNECTION_LOST');
    }
  });

  it('keeps an unknown failure an internal error', async () => {
    const res = await appThrowing(new Error('boom')).request('/app/api/x');
    expect(res.status).toBe(500);
    expect((await body(res)).error.code).toBe('APP_INTERNAL');
  });
});
