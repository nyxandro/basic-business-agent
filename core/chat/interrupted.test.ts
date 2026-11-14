// An answer of the model that broke (spec, section 9.1), as the chat gets it: the words of a broken
// attempt are taken off the screen when the model is asked again.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayStreamError } from '../models/fake-openai.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

// What LiteLLM sends inside the stream when the provider goes away mid-answer (gateway.test.ts).
const BREAK: GatewayStreamError = { message: 'litellm.APIConnectionError: APIConnectionError: GroqException - Connection closed.', type: 'internal_server_error', param: null, code: '500' };
const ANSWER = 'Привет! Чем помочь?';
// The limit of one model call, short for the test (5 minutes in an installation).
const STEP_MS = 2000;

let t: TestApp;
let olga: string;

interface AguiEvent {
  type: string;
  messageId?: string;
  delta?: string;
  name?: string;
  value?: unknown;
  code?: string;
  message?: string;
}

async function run(threadId: string, text: string): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}

async function historyTexts(threadId: string): Promise<string[]> {
  const res = await t.call('GET', `/app/api/threads/${threadId}/messages`, { cookie: olga });
  const { messages } = (await res.json()) as { messages: { role: string; text: string }[] };
  return messages.filter((m) => m.role === 'assistant').map((m) => m.text);
}

beforeAll(async () => {
  t = await createTestApp({ stepMs: STEP_MS });
  const olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('an answer that broke mid-way and was asked again', () => {
  it('takes the shown words off the screen right before the new answer, and the history has only the new one', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: ANSWER });
    const events = await run(threadId, 'привет');
    const partial = events.findIndex((e) => e.delta === 'Пр');
    const discard = events.findIndex((e) => e.type === 'CUSTOM' && e.name === 'bba.message_discarded');
    const fresh = events.findIndex((e) => e.delta?.startsWith('Привет'));
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(discard).toBeGreaterThan(partial);
    expect(fresh).toBeGreaterThan(discard);
    expect(events[discard]!.value).toEqual({ messageId: events[partial]!.messageId });
    expect(events[fresh]!.messageId).not.toBe(events[partial]!.messageId);
    expect(events.some((e) => e.type === 'RUN_ERROR')).toBe(false);
    expect(await historyTexts(threadId)).toEqual([ANSWER]);
  });

  it('drops only the broken step: the words and actions of earlier steps stay on the screen', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'crm_search', args: { q: 'сделки' } }] }, { text: 'Сделок 12. Пр', cut: BREAK }, { text: 'Сделок 12.' });
    const events = await run(threadId, 'сколько сделок');
    const discard = events.find((e) => e.type === 'CUSTOM' && e.name === 'bba.message_discarded');
    const partialId = events.find((e) => e.delta?.includes('Пр'))?.messageId;
    const call = events.find((e) => e.type === 'TOOL_CALL_START') as { parentMessageId?: string } | undefined;
    expect(discard?.value).toEqual({ messageId: partialId });
    expect(call?.parentMessageId).toBeDefined();
    expect(call?.parentMessageId).not.toBe(partialId);
  });
});

describe('a model that went silent', () => {
  it('is stopped after the limit of one call, with a code and words for the person', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Пр', cut: 'hang' });
    const started = Date.now();
    const events = await run(threadId, 'привет');
    const failed = events.find((e) => e.type === 'RUN_ERROR');
    expect(failed?.code).toBe('APP_MODEL_TIMEOUT');
    expect(failed?.message).toBe('Модель слишком долго не отвечала, и ответ остановлен. Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.');
    expect(Date.now() - started).toBeLessThan(STEP_MS * 3);
  });
});
