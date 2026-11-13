import { describe, expect, it } from 'vitest';
import { readCoreEnv } from './env.ts';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  APP_PUBLIC_URL: 'http://localhost:8080',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  APP_ENCRYPTION_KEYS: `1:${Buffer.alloc(32).toString('base64')}`,
  LITELLM_URL: 'http://litellm:4000',
  LITELLM_MASTER_KEY: 'sk-master',
  LITELLM_CALLBACK_SECRET: 'y'.repeat(32),
  APP_WORKSPACE_DIR: '/workspace',
};

describe('readCoreEnv', () => {
  it('returns the variables when all are present', () => {
    expect(readCoreEnv(valid)).toEqual(valid);
  });

  it('lists every missing or invalid variable as a field of .env', () => {
    const { DATABASE_URL: _d, ...rest } = valid;
    expect(() => readCoreEnv({ ...rest, APP_PUBLIC_URL: 'not a url', BETTER_AUTH_SECRET: 'short' })).toThrow(
      expect.objectContaining({
        code: 'APP_CONFIG_INVALID',
        details: {
          problems: [
            { file: '.env', field: 'DATABASE_URL', message: 'is not set' },
            { file: '.env', field: 'APP_PUBLIC_URL', message: expect.any(String) },
            { file: '.env', field: 'BETTER_AUTH_SECRET', message: 'must be at least 32 characters' },
          ],
        },
      }),
    );
  });
});
