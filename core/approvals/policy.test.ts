import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { PostgresStore } from '@mastra/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { summariseArgs } from '../journal/journal.ts';
import { startFakeModel, type FakeModel } from '../models/fake-openai.ts';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { applyApprovalPolicy } from './policy.ts';
import { createChainService } from './chains.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';

let database: TestDatabase;
let db: Db;
let model: FakeModel;
let agent: Agent;
const calls: string[] = [];

const tools = () => ({
  crm_search: createTool({ id: 'crm_search', description: 'Найти сделки', inputSchema: z.object({ q: z.string() }), execute: (i) => (calls.push(`search:${i.q}`), Promise.resolve({ deals: 12 })) }),
  mail_send: createTool({ id: 'mail_send', description: 'Отправить письмо', inputSchema: z.object({ to: z.string(), text: z.string(), apiToken: z.string() }), execute: (i) => (calls.push(`send:${i.to}`), Promise.resolve({ sent: true })) }),
  crm_update: createTool({ id: 'crm_update', description: 'Изменить сделку', inputSchema: z.object({ id: z.string() }), execute: () => Promise.reject(new Error('CRM refused')) }),
});

function context(): RequestContext {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, 'olga');
  rc.set(REQUEST_KEYS.agentId, 'sales');
  rc.set(REQUEST_KEYS.runKind, 'chat');
  return rc;
}

async function journal() {
  const { rows } = await db.query<{ tool: string; result: string; approved_by: string | null; error_code: string | null; args_summary: Record<string, unknown> }>(
    'SELECT tool, result, approved_by, error_code, args_summary FROM app.action_journal ORDER BY id',
  );
  return rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  model = await startFakeModel();
  const t = tools();
  const wrapped = {
    crm_search: applyApprovalPolicy(t.crm_search, { readOnly: true, db, chains: createChainService({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS) }) }),
    mail_send: applyApprovalPolicy(t.mail_send, { readOnly: false, db, chains: createChainService({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS) }) }),
    crm_update: applyApprovalPolicy(t.crm_update, { readOnly: false, db, chains: createChainService({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS) }) }),
  };
  agent = new Agent({ id: 'sales', name: 'sales', instructions: 'x', model: { providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x' }, tools: wrapped });
  new Mastra({ agents: { sales: agent }, storage: new PostgresStore({ id: 't', connectionString: database.url, schemaName: 'mastra' }), logger: false });
});
afterAll(async () => {
  await model.close();
  await db.end();
  await database.drop();
});
beforeEach(async () => {
  calls.length = 0;
  await db.query('TRUNCATE app.action_journal');
});

describe('approval policy', () => {
  it('runs a read-only tool without asking and without a journal entry', async () => {
    model.script({ toolCalls: [{ name: 'crm_search', args: { q: 'зависшие' } }] }, { text: 'Нашёл 12.' });
    const result = await agent.generate('Покажи сделки', { requestContext: context() });
    expect(result.finishReason).not.toBe('suspended');
    expect(calls).toEqual(['search:зависшие']);
    expect(await journal()).toEqual([]);
  });

  it('waits for "Да" before an action, then runs it and writes the journal without secrets or personal data', async () => {
    model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'ivan@example.com', text: 'Паспорт 4510 123456 получили', apiToken: 'sk-secret' } }] }, { text: 'Отправил.' });
    const first = await agent.generate('Напиши Ивану', { requestContext: context() });
    expect(first.finishReason).toBe('suspended');
    expect(calls).toEqual([]);

    await agent.approveToolCallGenerate({ runId: first.runId!, toolCallId: (first.suspendPayload as { toolCallId: string }).toolCallId, requestContext: context() });
    expect(calls).toEqual(['send:ivan@example.com']);
    const [row] = await journal();
    expect(row).toMatchObject({ tool: 'mail_send', result: 'ok', approved_by: 'olga' });
    expect(row!.args_summary).toEqual({ to: '<почта>', text: 'Паспорт <паспорт> получили', apiToken: '<скрыто>' });
  });

  it('does nothing after "Нет"', async () => {
    model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'a@example.com', text: 'x', apiToken: 'y' } }] }, { text: 'Хорошо, не отправляю.' });
    const first = await agent.generate('Напиши', { requestContext: context() });
    await agent.declineToolCallGenerate({ runId: first.runId!, toolCallId: (first.suspendPayload as { toolCallId: string }).toolCallId, requestContext: context() });
    expect(calls).toEqual([]);
    expect(await journal()).toEqual([]);
  });

  it('writes a failed action with its error code', async () => {
    model.script({ toolCalls: [{ name: 'crm_update', args: { id: '42' } }] }, { text: 'Не получилось.' });
    const first = await agent.generate('Обнови сделку', { requestContext: context() });
    await agent.approveToolCallGenerate({ runId: first.runId!, toolCallId: (first.suspendPayload as { toolCallId: string }).toolCallId, requestContext: context() });
    expect(await journal()).toMatchObject([{ tool: 'crm_update', result: 'error', error_code: 'APP_TOOL_FAILED' }]);
  });
});

describe('summariseArgs', () => {
  it('hides secret fields and personal data and shortens long texts', () => {
    expect(summariseArgs({ password: '123', note: 'x'.repeat(300), card: '4111 1111 1111 1111', nested: { phone: '+7 912 345 67 89' } })).toEqual({
      password: '<скрыто>',
      note: `${'x'.repeat(200)}…`,
      card: '<карта>',
      nested: { phone: '<телефон>' },
    });
  });
});
