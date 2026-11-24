// What the person reads under a broken answer: a failure of the database is not «модель не отвечает».
import { describe, expect, it } from 'vitest';
import { appError } from '../errors/catalog.ts';
import { translateRunFailure } from './run-failure.ts';

const gateway = { translateError: () => Promise.resolve(appError('APP_MODEL_UNAVAILABLE', 'model failed')) };

describe('translateRunFailure', () => {
  it('tells a database that had no free connection or dropped it, as text or as an error', async () => {
    expect((await translateRunFailure(gateway, 'u', 'timeout exceeded when trying to connect')).code).toBe('APP_SERVER_BUSY');
    expect((await translateRunFailure(gateway, 'u', new Error('Connection terminated unexpectedly'))).code).toBe('APP_DB_CONNECTION_LOST');
  });

  it('keeps our own codes and gives the rest to the gateway', async () => {
    expect((await translateRunFailure(gateway, 'u', 'APP_SANDBOX_BUSY: queue')).code).toBe('APP_SANDBOX_BUSY');
    expect((await translateRunFailure(gateway, 'u', 'upstream 503')).code).toBe('APP_MODEL_UNAVAILABLE');
  });
});
