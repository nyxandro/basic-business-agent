import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { startFakeModel, type FakeModel, type FakeRequest } from '../models/fake-openai.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createMaskingProcessor } from './processor.ts';
import { ensureMaskingSettings } from './settings.ts';

let database: TestDatabase;
let db: Db;
let model: FakeModel;
let storage: PostgresStore;
const sent: { to: string; text: string }[] = [];

const sendEmail = createTool({
  id: 'sendEmail',
  description: 'Отправить письмо',
  inputSchema: z.object({ to: z.string(), text: z.string() }),
  execute: (input) => {
    sent.push(input);
    return Promise.resolve({ sent: true });
  },
});

function placeholderIn(req: FakeRequest, name: string): string {
  return JSON.stringify(req.messages).match(new RegExp(`\\[${name}_\\d+\\]`))?.[0] ?? 'NONE';
}

function agentWith(processorDb: Db): Agent {
  const masking = createMaskingProcessor(processorDb);
  const agent = new Agent({
    id: 'sales',
    name: 'Продажи',
    instructions: 'Ты помощник отдела продаж.',
    model: { providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x' },
    tools: { sendEmail },
    memory: new Memory({ storage }),
    inputProcessors: [masking],
    outputProcessors: [masking],
  });
  new Mastra({ agents: { sales: agent }, storage, logger: false });
  return agent;
}

async function run(agent: Agent, threadId: string, message: string): Promise<string> {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.threadId, threadId);
  rc.set(REQUEST_KEYS.userId, 'u1');
  const stream = await agent.stream(message, { memory: { thread: threadId, resource: 'u1' }, requestContext: rc });
  let text = '';
  for await (const part of stream.fullStream) {
    if (part.type === 'text-delta') text += part.payload.text;
    if (part.type === 'error') throw (part.payload as { error: unknown }).error;
  }
  return text;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await ensureMaskingSettings(db, ['email', 'passport', 'snils', 'card', 'inn']);
  model = await startFakeModel();
  storage = new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' });
});
afterAll(async () => {
  await model.close();
  await db.end();
  await database.drop();
});
beforeEach(() => {
  model.requests.length = 0;
  sent.length = 0;
});

describe('masking processor', () => {
  it('hides data from the model, sends the real address and shows the person real values', async () => {
    const agent = agentWith(db);
    model.script(
      (req) => ({ toolCalls: [{ name: 'sendEmail', args: { to: placeholderIn(req, 'ПОЧТА'), text: 'Встреча в 10' } }] }),
      { text: 'Письмо отправлено на [ПОЧТА_1], паспорт [ПАСПОРТ_1] не нужен.', chunkSize: 5 },
    );
    const shown = await run(agent, 'thread-a', 'Напиши ivan@example.com, мой паспорт 4510 123456');

    const seen = JSON.stringify(model.requests);
    expect(seen).not.toContain('ivan@example.com');
    expect(seen).not.toContain('4510 123456');
    expect(seen).toContain('[ПОЧТА_1]');
    expect(seen).toContain('[ПАСПОРТ_1]');
    expect(sent).toEqual([{ to: 'ivan@example.com', text: 'Встреча в 10' }]);
    expect(shown).toBe('Письмо отправлено на ivan@example.com, паспорт 4510 123456 не нужен.');

    const { messages } = await (await agent.getMemory())!.recall({ threadId: 'thread-a', resourceId: 'u1' });
    const stored = JSON.stringify(messages);
    expect(stored).toContain('ivan@example.com');
    expect(stored).not.toContain('[ПОЧТА_');
  });

  it('keeps the same placeholder for the same value across turns and numbers new ones', async () => {
    const agent = agentWith(db);
    model.script({ text: 'Хорошо.' });
    await run(agent, 'thread-a', 'И ещё petr@example.com, и снова ivan@example.com');
    const last = JSON.stringify(model.requests.at(-1)?.messages);
    expect(last).toContain('[ПОЧТА_2]');
    expect(last).not.toContain('petr@example.com');
    expect(last.match(/\[ПОЧТА_1\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('does not run a tool with a placeholder the model made up', async () => {
    const agent = agentWith(db);
    model.script({ toolCalls: [{ name: 'sendEmail', args: { to: '[ПОЧТА_7]', text: 'x' } }] }, { text: 'Не получилось.' });
    await run(agent, 'thread-b', 'Напиши кому-нибудь');
    expect(sent).toEqual([]);
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toMatch(/unknownPlaceholders|error/i);
  });

  it('sends a kind as is when the admin switched it off', async () => {
    await db.query(`UPDATE app.masking_settings SET kinds = '["passport"]'`);
    try {
      model.script({ text: 'Ок.' });
      await run(agentWith(db), 'thread-c', 'Почта anna@example.com');
      expect(JSON.stringify(model.requests)).toContain('anna@example.com');
    } finally {
      await db.query(`UPDATE app.masking_settings SET kinds = '["email","passport","snils","card","inn"]'`);
    }
  });

  it('stops the request with APP_MASKING_FAILED when masking breaks, and the model is not called', async () => {
    const broken = createPool(database.url);
    await broken.end();
    model.script({ text: 'Не должно дойти.' });
    await expect(run(agentWith(broken), 'thread-d', 'Почта anna@example.com')).rejects.toMatchObject({ code: 'APP_MASKING_FAILED' });
    expect(model.requests).toHaveLength(0);
  });
});
