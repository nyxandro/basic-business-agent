import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olga: string;
let igor: string;
let olgaId: string;

interface AguiEvent {
  type: string;
  delta?: string;
  message?: string;
  code?: string;
  outcome?: { type: string; interrupts?: { id: string; metadata?: { mastra?: { toolName?: string; args?: unknown } } }[] };
}

async function run(cookie: string, agentId: string, threadId: string, text: string | null, resume?: unknown): Promise<{ status: number; events: AguiEvent[]; body: string }> {
  const res = await t.call('POST', `/app/api/copilotkit/agent/${agentId}/run`, {
    cookie,
    body: {
      threadId,
      runId: randomUUID(),
      messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...(resume ? { resume } : {}),
    },
  });
  const body = await res.text();
  const events = body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
  return { status: res.status, events, body };
}

const textOf = (events: AguiEvent[]) => events.filter((e) => e.type === 'TEXT_MESSAGE_CHUNK' || e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta ?? '').join('');
const interruptOf = (events: AguiEvent[]) => events.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  t.sentMail.length = 0;
});

describe('chat', () => {
  it('lists only the agents of the employee’s departments', async () => {
    const res = await t.call('GET', '/app/api/agents', { cookie: olga });
    expect(((await res.json()) as { agents: { id: string }[] }).agents.map((a) => a.id)).toEqual(['sales']);
  });

  it('refuses an agent outside the employee’s departments with 403', async () => {
    const res = await run(igor, 'sales', randomUUID(), 'Привет');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'APP_AGENT_ACCESS_DENIED' } });
  });

  it('answers in a new conversation titled by the first message', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Здравствуйте, Ольга!' });
    const res = await run(olga, 'sales', threadId, 'Покажи мои сделки без движения больше двух недель');
    expect(res.status).toBe(200);
    expect(textOf(res.events)).toBe('Здравствуйте, Ольга!');
    const threads = (await (await t.call('GET', '/app/api/agents/sales/threads', { cookie: olga })).json()) as { threads: { id: string; title: string }[] };
    expect(threads.threads.find((x) => x.id === threadId)?.title).toBe('Покажи мои сделки без движения больше двух недель');
    const history = (await (await t.call('GET', `/app/api/threads/${threadId}/messages`, { cookie: olga })).json()) as { messages: { role: string; text: string }[] };
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('refuses a second run of the same conversation while the first is still answering', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Долгий ответ', delayMs: 1500 });
    const first = run(olga, 'sales', threadId, 'Первый вопрос');
    await new Promise((r) => setTimeout(r, 300));
    const second = await run(olga, 'sales', threadId, 'Второй вопрос');
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({ error: { code: 'APP_CHAT_THREAD_BUSY' } });
    expect((await first).status).toBe(200);
  });

  it('does not let another employee continue someone’s conversation', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Ок.' });
    await run(olga, 'sales', threadId, 'Мой разговор');
    await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) SELECT id, 'sales' FROM app.departments ON CONFLICT DO NOTHING`);
    const res = await t.call('GET', `/app/api/threads/${threadId}/messages`, { cookie: igor });
    expect(res.status).toBe(404);
  });
});

describe('confirmation in the chat', () => {
  it('waits for "Да", then sends the letter and writes the journal', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Добрый день' } }] }, { text: 'Письмо отправлено.' });
    const first = await run(olga, 'sales', threadId, 'Напиши клиенту');
    const interrupt = interruptOf(first.events);
    expect(interrupt?.metadata?.mastra?.toolName).toBe('mail_send');
    expect(t.sentMail).toEqual([]);

    const second = await run(olga, 'sales', threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    expect(second.status).toBe(200);
    expect(t.sentMail).toEqual([{ to: 'client@example.com', text: 'Добрый день' }]);
    const journal = await t.db.query<{ tool: string; result: string }>(`SELECT tool, result FROM app.action_journal WHERE tool = 'mail_send' ORDER BY id DESC LIMIT 1`);
    expect(journal.rows[0]).toEqual({ tool: 'mail_send', result: 'ok' });
  });

  it('cancels the waiting action when the employee writes a new message instead', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'x@example.com', text: 'x' } }] });
    const first = await run(olga, 'sales', threadId, 'Напиши письмо');
    expect(interruptOf(first.events)).toBeTruthy();
    t.model.script({ text: 'Хорошо, не отправляю.' }, { text: 'Вот ответ на новый вопрос.' });
    const next = await run(olga, 'sales', threadId, 'Нет, лучше расскажи про сделки');
    expect(next.status).toBe(200);
    expect(t.sentMail).toEqual([]);
    const row = await t.db.query<{ status: string; error_code: string }>('SELECT status, error_code FROM app.approval_requests WHERE thread_id = $1', [threadId]);
    expect(row.rows[0]).toEqual({ status: 'declined', error_code: 'APP_CHAT_SUPERSEDED' });
  });

  it('does not run an approved action when the monthly limit ran out meanwhile', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'y@example.com', text: 'y' } }] });
    const first = await run(olga, 'sales', threadId, 'Отправь письмо');
    const interrupt = interruptOf(first.events)!;
    await t.db.query('INSERT INTO app.user_limits (user_id, monthly_rub) VALUES ($1, 1) ON CONFLICT (user_id) DO UPDATE SET monthly_rub = 1', [olgaId]);
    await t.db.query(`INSERT INTO app.usage_events (at, user_id, model, cost_rub, litellm_call_id) VALUES (now(), $1, 'test-paid', 5, 'spent-' || $1)`, [olgaId]);
    try {
      const second = await run(olga, 'sales', threadId, null, [{ interruptId: interrupt.id, status: 'resolved', payload: { approved: true } }]);
      expect(second.status).toBe(402);
      expect(JSON.parse(second.body)).toMatchObject({ error: { code: 'APP_USAGE_LIMIT_EXCEEDED' } });
      expect(t.sentMail).toEqual([]);
    } finally {
      await t.db.query('DELETE FROM app.user_limits WHERE user_id = $1', [olgaId]);
      await t.db.query(`DELETE FROM app.usage_events WHERE litellm_call_id = 'spent-' || $1`, [olgaId]);
    }
  });

  it('turns a model failure into our code and text', async () => {
    // The AI SDK retries a 429 twice on its own (native, bounded); all three attempts fail here.
    const limited = { status: 429, error: 'Rate limit reached for requests' };
    t.model.script(limited, limited, limited);
    const res = await run(olga, 'sales', randomUUID(), 'Привет');
    const error = res.events.find((e) => e.type === 'RUN_ERROR');
    expect(error).toMatchObject({ code: 'APP_MODEL_RATE_LIMITED', message: 'Слишком много запросов к модели. Подождите минуту и отправьте сообщение снова.' });
  });
});

describe('memory and attachments', () => {
  it('shows, edits and forgets the employee’s memory', async () => {
    expect((await t.call('PUT', '/app/api/me/memory', { cookie: olga, body: { text: '# О сотруднике\n- ведёт юрлиц' } })).status).toBe(200);
    expect(((await (await t.call('GET', '/app/api/me/memory', { cookie: olga })).json()) as { text: string }).text).toContain('ведёт юрлиц');
    await t.call('DELETE', '/app/api/me/memory', { cookie: olga });
    expect(((await (await t.call('GET', '/app/api/me/memory', { cookie: olga })).json()) as { text: string }).text).not.toContain('ведёт юрлиц');
  });

  it('stores an attachment of a conversation', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'Счёт.pdf', { type: 'application/pdf' }));
    const res = await t.app.request(`/app/api/threads/${randomUUID()}/uploads`, { method: 'POST', body: form, headers: { cookie: olga, origin: 'http://localhost:8080' } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { path: string }).path).toMatch(/^uploads\/.+\/Счёт\.pdf$/);
  });
});
