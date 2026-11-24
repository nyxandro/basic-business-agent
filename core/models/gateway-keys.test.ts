// The first message of many employees at once (review 24.11): each gets a personal key of the gateway made once, and the
// server's pool never hangs — ten at once used to take every connection and wait for one more, forever.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { migrate } from '../db/migrate.ts';
import { createPool, POOL_MAX, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';
import { createModelGateway } from './gateway.ts';
import type { LiteLLMClient } from './litellm-client.ts';
import { ensureLimitSettings } from './limits.ts';

const KEY_MS = 200;
// More employees than connections: any request that holds one connection and asks the pool for another hangs.
const EMPLOYEES = POOL_MAX + 10;
const DEADLINE_MS = 10_000;

let database: TestDatabase;
let db: Db;
const made: string[] = [];

const client = {
  baseUrl: 'http://127.0.0.1:1',
  async generateKey(userId: string) {
    made.push(userId);
    await new Promise((r) => setTimeout(r, KEY_MS));
    return `sk-${userId}`;
  },
} as unknown as LiteLLMClient;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await ensureLimitSettings(db, { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null });
  for (let i = 0; i < EMPLOYEES; i++) {
    await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ($1, $1, $1 || '@example.com', true, now(), now())`, [`e${i}`]);
  }
});

afterAll(async () => {
  await db.end();
  await database.drop();
});

const inTime = <T>(work: Promise<T>) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${DEADLINE_MS} ms: the pool hung`)), DEADLINE_MS))]);

describe('personal keys of the gateway', () => {
  it('makes the keys of more employees at once than the pool has connections, without hanging', async () => {
    const gateway = createModelGateway({ db, client, box: createSecretBox(TEST_ENCRYPTION_KEYS), timezone: 'Europe/Moscow' });
    const configs = await inTime(Promise.all(Array.from({ length: EMPLOYEES }, (_, i) => gateway.modelConfig('m', `e${i}`, 'assistant'))));
    expect(new Set(configs.map((c) => c.apiKey)).size).toBe(EMPLOYEES);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app.model_keys')).rows[0]!.n).toBe(EMPLOYEES);
  });

  it('makes one key for one employee whose first requests come at once', async () => {
    await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('solo', 'solo', 'solo@example.com', true, now(), now())`);
    made.length = 0;
    const gateway = createModelGateway({ db, client, box: createSecretBox(TEST_ENCRYPTION_KEYS), timezone: 'Europe/Moscow' });
    const configs = await inTime(Promise.all(Array.from({ length: POOL_MAX + 5 }, () => gateway.modelConfig('m', 'solo', 'assistant'))));
    expect(new Set(configs.map((c) => c.apiKey))).toEqual(new Set(['sk-solo']));
    expect(made).toEqual(['solo']);
  });
});
