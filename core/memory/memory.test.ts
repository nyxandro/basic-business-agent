import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { startFakeModel, type FakeModel } from '../models/fake-openai.ts';
import { createMemory, deleteThread, ensureThread, forgetAll, listOwnThreads, readMemory, titleFrom, WORKING_MEMORY_TEMPLATE, writeMemory } from './memory.ts';

let database: TestDatabase;
let db: Db;
let memory: Memory;
let model: FakeModel;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  memory = createMemory(new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' }));
  model = await startFakeModel();
});
afterAll(async () => {
  await model.close();
  await db.end();
  await database.drop();
});

describe('personal memory', () => {
  it('is shared by all agents of one employee and visible to nobody else', async () => {
    const make = (id: string) => new Agent({ id, name: id, instructions: 'x', model: { providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x' }, memory });
    model.script({ toolCalls: [{ name: 'updateWorkingMemory', args: { memory: '# О сотруднике\n- Чем занимается: ведёт только юрлиц\n' } }] }, { text: 'Запомнил.' });
    await make('sales').generate('Я веду только юрлиц', { memory: { thread: 't-olga-1', resource: 'olga' }, requestContext: new RequestContext() });
    expect(await readMemory(memory, 'olga')).toContain('ведёт только юрлиц');

    model.script({ text: 'Здравствуйте.' });
    await make('assistant').generate('Привет', { memory: { thread: 't-olga-2', resource: 'olga' }, requestContext: new RequestContext() });
    expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('ведёт только юрлиц');
    expect(await readMemory(memory, 'igor')).not.toContain('ведёт только юрлиц');
  });

  it('lets the employee edit it and “forget everything” clears only their own memory', async () => {
    await writeMemory(memory, 'igor', '# О сотруднике\n- Чем занимается: бухгалтерия\n');
    await writeMemory(memory, 'olga', '# О сотруднике\n- Чем занимается: продажи\n');
    await forgetAll(memory, 'olga');
    expect(await readMemory(memory, 'olga')).toBe(WORKING_MEMORY_TEMPLATE);
    expect(await readMemory(memory, 'igor')).toContain('бухгалтерия');
  });
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
