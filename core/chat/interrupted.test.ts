// An answer of the model that broke (spec, section 9.1), as the chat gets it: the words of a broken
// attempt are taken off the screen when the model is asked again; an answer that stayed broken keeps
// its words and error after a reload and can be answered again.
import { randomUUID } from 'node:crypto';
import { CHAT_EVENTS, withAttachments, type FailedTurns } from '@bba/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayStreamError } from '../models/fake-openai.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { connectResponse } from './connect.ts';

// What LiteLLM sends inside the stream when the provider goes away mid-answer (gateway.test.ts).
const BREAK: GatewayStreamError = { message: 'litellm.APIConnectionError: APIConnectionError: GroqException - Connection closed.', type: 'internal_server_error', param: null, code: '500' };
const ANSWER = 'Привет! Чем помочь?';
// The limit of one model call, short for the test (5 minutes in an installation).
const STEP_MS = 2000;

const UNAVAILABLE = 'Модель сейчас не отвечает. Попробуйте ещё раз через минуту; если повторяется — сообщите администратору код ошибки.';
// A refusal the gateway reports inside the stream: the conversation is too long for the model.
const TOO_LONG: GatewayStreamError = { message: 'litellm.BadRequestError: GroqException - Please reduce the length of the messages or completion.', type: 'invalid_request_error', param: 'messages', code: '400' };
const BROKEN = { code: 'APP_MODEL_UNAVAILABLE', message: UNAVAILABLE, answerAgain: true, actionDone: false };

let t: TestApp;
let olga: string;
let igor: string;

interface AguiEvent {
  type: string;
  messageId?: string;
  delta?: string;
  name?: string;
  value?: unknown;
  code?: string;
  message?: string;
  messages?: { id: string; role: string; content?: string }[];
  outcome?: { interrupts?: { id: string }[] };
}

const eventsOf = (body: string) =>
  body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);

// Mastra stores the answer of a failed run some 60–80 ms after the stream ends; a person reloads or
// clicks later than that, so the tests wait for the stored answer as well.
async function storedCount(threadId: string): Promise<number> {
  const thread = await t.memory.getThreadById({ threadId });
  if (!thread) return 0;
  return (await t.memory.recall({ threadId, resourceId: thread.resourceId, perPage: false })).messages.length;
}

async function turnStored(threadId: string, before: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await storedCount(threadId)) >= before + 2) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`the turn of ${threadId} was not stored`);
}

async function run(threadId: string, text: string, questionId = randomUUID()): Promise<AguiEvent[]> {
  const before = await storedCount(threadId);
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [{ id: questionId, role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  const events = eventsOf(await res.text());
  await turnStored(threadId, before);
  return events;
}

// Opening the conversation again (a reload of the page).
async function reopen(threadId: string): Promise<{ answers: { id: string; content?: string }[]; failed: FailedTurns | undefined }> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie: olga, body: { threadId, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {} } });
  expect(res.status).toBe(200);
  const events = eventsOf(await res.text());
  const snapshot = events.find((e) => e.type === 'MESSAGES_SNAPSHOT')?.messages ?? [];
  const failed = events.find((e) => e.type === 'CUSTOM' && e.name === CHAT_EVENTS.turnsFailed)?.value as FailedTurns | undefined;
  return { answers: snapshot.filter((m) => m.role === 'assistant'), failed };
}

// «Да» to the action the run waits for; the answer goes on and its failure is stored a moment later.
async function approve(threadId: string, events: AguiEvent[]): Promise<AguiEvent[]> {
  const interruptId = events.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0]?.id;
  expect(interruptId).toBeDefined();
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {}, resume: [{ interruptId, status: 'resolved', payload: { approved: true } }] },
  });
  expect(res.status).toBe(200);
  const resumed = eventsOf(await res.text());
  for (let i = 0; i < 100 && !(await reopen(threadId)).failed; i++) await new Promise((r) => setTimeout(r, 20));
  return resumed;
}

const answerAgain = (threadId: string, questionId: string, cookie = olga) => t.call('POST', `/app/api/threads/${threadId}/retry`, { cookie, body: { questionId } });

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
  await t.createUser({ email: 'igor@example.com', name: 'Игорь' });
  igor = await t.signIn('igor@example.com');
});
beforeEach(() => {
  t.model.clear();
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

describe('an answer that stayed broken', () => {
  it('keeps its words and its error after a reload', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK });
    const live = await run(threadId, 'привет');
    expect(live.find((e) => e.type === 'RUN_ERROR')?.code).toBe('APP_MODEL_UNAVAILABLE');
    const { answers, failed } = await reopen(threadId);
    expect(answers.map((m) => m.content)).toEqual(['При']);
    expect(failed).toEqual({ interruptedMessageIds: [answers[0]!.id], last: BROKEN });
  });

  it('is known after a reload when it broke before the first words', async () => {
    const threadId = randomUUID();
    t.model.script(...Array.from({ length: 6 }, () => ({ status: 500, error: 'boom' })));
    await run(threadId, 'привет');
    const { answers, failed } = await reopen(threadId);
    expect(answers).toEqual([]);
    expect(failed).toEqual({ interruptedMessageIds: [], last: BROKEN });
  });

  it('opens even when what happened cannot be explained now: the gateway is said to be down', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK });
    await run(threadId, 'привет');
    const olgaId = (await t.memory.getThreadById({ threadId }))!.resourceId;
    const res = await connectResponse({ db: t.db, memory: t.memory, translate: () => Promise.reject(new Error('fetch failed')) }, { userId: olgaId, resourceId: olgaId, agentId: 'sales', threadId });
    const failed = eventsOf(await res.text()).find((e) => e.name === CHAT_EVENTS.turnsFailed)?.value as FailedTurns;
    expect(failed.last).toMatchObject({ code: 'APP_MODEL_GATEWAY_UNAVAILABLE', answerAgain: true, actionDone: false });
  });

  it('is not offered to answer again when a repeat would not help', async () => {
    const threadId = randomUUID();
    const questionId = randomUUID();
    t.model.script({ text: 'Пр', cut: TOO_LONG });
    await run(threadId, 'привет', questionId);
    const { failed } = await reopen(threadId);
    expect(failed?.last).toMatchObject({ code: 'APP_MODEL_CONTEXT_EXCEEDED', answerAgain: false, actionDone: false });
    const res = await answerAgain(threadId, questionId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_CHAT_ANSWER_AGAIN_USELESS' } });
    expect(await historyTexts(threadId)).toEqual(['Пр']);
  });

  it('is not offered to answer again once an action ran after «Да»: the record of the action stays', async () => {
    const threadId = randomUUID();
    const questionId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Добрый день' } }] }, { text: 'Пис', cut: BREAK }, { text: 'Пись', cut: BREAK });
    const asked = await run(threadId, 'Напиши клиенту', questionId);
    await approve(threadId, asked);
    expect(t.sentMail).toEqual([{ to: 'client@example.com', text: 'Добрый день' }]);
    const { failed } = await reopen(threadId);
    expect(failed?.last).toMatchObject({ code: 'APP_MODEL_UNAVAILABLE', answerAgain: false, actionDone: true });
    const res = await answerAgain(threadId, questionId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_CHAT_ACTION_DONE' } });
    t.sentMail.length = 0;
  });

  it('is only marked once the conversation went on', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK }, { text: 'Готово.' });
    await run(threadId, 'привет');
    await run(threadId, 'ещё раз');
    const { answers, failed } = await reopen(threadId);
    expect(answers.map((m) => m.content)).toEqual(['При', 'Готово.']);
    expect(failed).toEqual({ interruptedMessageIds: [answers[0]!.id], last: null });
  });

  it('sends nothing about failures when every answer is whole', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Готово.' });
    await run(threadId, 'привет');
    expect((await reopen(threadId)).failed).toBeUndefined();
  });
});

describe('«Ответить заново»', () => {
  it('takes the question and its broken answer out and gives the question back as it was sent', async () => {
    const threadId = randomUUID();
    const question = withAttachments('Прочитай счёт', [{ name: 'Счёт.pdf', path: 'Счёт.pdf' }]);
    const questionId = randomUUID();
    t.model.script({ text: 'Готово.' }, { text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK });
    await run(threadId, 'привет');
    await run(threadId, question, questionId);
    const res = await answerAgain(threadId, questionId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: question });
    const { messages } = (await (await t.call('GET', `/app/api/threads/${threadId}/messages`, { cookie: olga })).json()) as { messages: { role: string; text: string }[] };
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'привет'],
      ['assistant', 'Готово.'],
    ]);
    expect((await reopen(threadId)).failed).toBeUndefined();
  });

  it('is refused when the last answer is not broken', async () => {
    const threadId = randomUUID();
    const questionId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK }, { text: 'Готово.' });
    await run(threadId, 'привет');
    await run(threadId, 'ещё раз', questionId);
    const res = await answerAgain(threadId, questionId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_CHAT_NOT_INTERRUPTED' } });
  });

  it('does not touch a conversation of another employee', async () => {
    const threadId = randomUUID();
    const questionId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK });
    await run(threadId, 'привет', questionId);
    expect((await answerAgain(threadId, questionId, igor)).status).toBe(404);
    expect((await reopen(threadId)).failed?.last?.code).toBe('APP_MODEL_UNAVAILABLE');
  });

  it('takes out only the turn the person sees: a second click does not reach an earlier broken question', async () => {
    const threadId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK }, { text: 'Сд', cut: BREAK }, { text: 'Сде', cut: BREAK });
    await run(threadId, 'привет', first);
    await run(threadId, 'покажи сделки', second);
    expect((await answerAgain(threadId, second)).status).toBe(200);
    const again = await answerAgain(threadId, second);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'APP_CHAT_NOT_INTERRUPTED' } });
    expect(await historyTexts(threadId)).toEqual(['При']);
  });

  it('takes nothing out when the question would be refused anyway', async () => {
    const threadId = randomUUID();
    const questionId = randomUUID();
    t.model.script({ text: 'Пр', cut: BREAK }, { text: 'При', cut: BREAK });
    await run(threadId, 'привет', questionId);
    await t.db.query('UPDATE app.limit_settings SET org_monthly_rub = 0');
    try {
      const res = await answerAgain(threadId, questionId);
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: { code: 'APP_USAGE_ORG_LIMIT_EXCEEDED' } });
    } finally {
      await t.db.query('UPDATE app.limit_settings SET org_monthly_rub = NULL');
    }
    expect(await historyTexts(threadId)).toEqual(['При']);
  });
});
