import type { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { createMemory, deleteThread, ensureThread, listOwnThreads, titleFrom } from './memory.ts';

let database: TestDatabase;
let db: Db;
let memory: Memory;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  memory = createMemory(new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' }));
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

describe('conversations', () => {
  it('titles a conversation by the first 60 characters of the first message', () => {
    expect(titleFrom('  Покажи мои сделки\nбез движения  ')).toBe('Покажи мои сделки без движения');
    const long = 'а'.repeat(80);
    expect(titleFrom(long)).toHaveLength(60);
    expect(titleFrom(long).endsWith('…')).toBe(true);
  });

  it('lists only the employee’s own conversations of every agent and deletes only their own', async () => {
    await ensureThread(memory, { threadId: 'c1', resourceId: 'anna', agentId: 'sales', kind: 'chat', title: 'Сделки' });
    await ensureThread(memory, { threadId: 'c2', resourceId: 'anna', agentId: 'assistant', kind: 'chat', title: 'Другое' });
    await ensureThread(memory, { threadId: 'c3', resourceId: 'petr', agentId: 'sales', kind: 'chat', title: 'Чужой' });
    expect((await listOwnThreads(memory, 'anna')).map((t) => [t.title, t.agentId])).toEqual([['Другое', 'assistant'], ['Сделки', 'sales']]);
    await expect(ensureThread(memory, { threadId: 'c3', resourceId: 'anna', agentId: 'sales', kind: 'chat', title: 'x' })).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
    await expect(deleteThread(memory, db, 'anna', 'c3')).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
    await deleteThread(memory, db, 'anna', 'c1');
    expect((await listOwnThreads(memory, 'anna')).map((t) => t.title)).toEqual(['Другое']);
  });
});
