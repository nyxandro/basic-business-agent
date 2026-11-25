// How full a conversation is (spec, section 8.34): after every call of the model of the agent the person talks to,
// the tokens the provider counted — in and out — are kept for the conversation and told to the chat at once; the
// chat asks for them when a conversation opens. The model here is the fake one: it says what each call took.
import { randomUUID } from 'node:crypto';
import type { ThreadContextResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAST_MESSAGES } from '../memory/memory.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;
let olgaId: string;
let petr: string;
let primary: string;

async function chat(threadId: string, text: string): Promise<string> {
  const body = { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} };
  const res = await t.app.request('/app/api/copilotkit/agent/sales/run', { method: 'POST', headers: { cookie: olga, origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return res.text();
}

// The events of the chat stream, as the browser gets them.
const eventsOf = (stream: string) =>
  stream
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()) as { type: string; name?: string; value?: unknown });

const isFill = (e: { type: string; name?: string }) => e.type === 'CUSTOM' && e.name === 'bba.context_fill';

async function fillOf(cookie: string, threadId: string): Promise<ThreadContextResponse['context']> {
  const res = await t.call('GET', `/app/api/threads/${threadId}/context`, { cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as ThreadContextResponse).context;
}

const setSize = (size: number | null) => t.db.query('UPDATE app.models SET max_input_tokens = $2 WHERE id = $1', [primary, size]);

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  for (const id of [olgaId, petrId]) await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [sales, id]);
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  primary = (await t.db.query<{ primary_model_id: string }>('SELECT primary_model_id FROM app.model_settings')).rows[0]!.primary_model_id;
  await setSize(1000);
});
afterAll(async () => {
  await t.close();
});

describe('how full a conversation is (spec, section 8.34)', () => {
  it('keeps the last call of the model — not the sum of the answer — and tells the chat after every call', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'conversations', args: { mode: 'list', scope: 'all' } }], usage: { prompt: 200, completion: 10 } }, { text: 'Пока разговоров нет.', usage: { prompt: 400, completion: 30 } });
    const events = eventsOf(await chat(threadId, 'О чём мы говорили?'));

    expect(events.filter(isFill).map((e) => e.value)).toEqual([
      { threadId, context: { tokens: 210, limit: 1000, hidden: false } },
      { threadId, context: { tokens: 430, limit: 1000, hidden: false } },
    ]);
    // The ring grows while the agent answers: the first call is told before the words of the answer.
    expect(events.findIndex(isFill)).toBeLessThan(events.findIndex((e) => e.type === 'TEXT_MESSAGE_CONTENT'));
    expect(await fillOf(olga, threadId)).toEqual({ tokens: 430, limit: 1000, hidden: false });
    const { rows } = await t.db.query<{ model_id: string; user_id: string }>('SELECT model_id, user_id FROM app.thread_context WHERE thread_id = $1', [threadId]);
    expect(rows).toEqual([{ model_id: primary, user_id: olgaId }]);
  });

  it('a call that failed writes nothing: the last good one stays', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Здравствуйте.', usage: { prompt: 300, completion: 20 } });
    await chat(threadId, 'Привет');
    t.model.script({ status: 400, error: 'This request is invalid' });
    const events = eventsOf(await chat(threadId, 'Ещё раз'));
    expect(events.filter(isFill)).toEqual([]);
    expect(await fillOf(olga, threadId)).toEqual({ tokens: 320, limit: 1000, hidden: false });
  });

  it('shows nothing for a new conversation, for another person’s, and for a model without a size of the context', async () => {
    expect(await fillOf(olga, randomUUID())).toBeNull();
    const threadId = randomUUID();
    t.model.script({ text: 'Готово.', usage: { prompt: 100, completion: 5 } });
    await chat(threadId, 'Сделай');
    expect(await fillOf(petr, threadId)).toBeNull();

    await setSize(null);
    try {
      expect(await fillOf(olga, threadId)).toBeNull();
      t.model.script({ text: 'Готово снова.', usage: { prompt: 150, completion: 5 } });
      expect(eventsOf(await chat(threadId, 'Ещё')).filter(isFill).map((e) => e.value)).toEqual([{ threadId, context: null }]);
    } finally {
      await setSize(1000);
    }
    // The size is read when the chat asks: given later, it turns the indicator on for this conversation too.
    expect(await fillOf(olga, threadId)).toEqual({ tokens: 155, limit: 1000, hidden: false });
  });

  it(`tells that the agent no longer sees the beginning once the conversation is longer than ${LAST_MESSAGES} messages`, async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Начали.' });
    await chat(threadId, 'Начнём');
    const start = Date.now();
    await t.memory.saveMessages({
      messages: Array.from({ length: LAST_MESSAGES - 1 }, (_, i) => ({ id: randomUUID(), threadId, resourceId: olgaId, role: 'user' as const, createdAt: new Date(start + i), content: { format: 2 as const, parts: [{ type: 'text' as const, text: `Сообщение ${i}` }] } })),
    });
    expect(await fillOf(olga, threadId)).toMatchObject({ hidden: true });
  });

  it('goes away with the conversation', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Готово.' });
    await chat(threadId, 'Сделай');
    expect(await fillOf(olga, threadId)).not.toBeNull();
    expect((await t.call('DELETE', `/app/api/threads/${threadId}`, { cookie: olga })).status).toBe(200);
    const { rowCount } = await t.db.query('SELECT 1 FROM app.thread_context WHERE thread_id = $1', [threadId]);
    expect(rowCount).toBe(0);
  });
});
