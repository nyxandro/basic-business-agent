import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPUTER_TOOLS } from '@bba/contracts';
import { MAIL_TOOL_NAMES } from '../mail/tools.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_ACTIONS } from '../memory/tools.ts';
import { SIGN_TOOL } from '../org-docs/prompt.ts';
import { CONVERSATIONS_ACTIONS } from '../history/tool.ts';
import { WORKSPACE_ACTIONS } from '../sandbox/workspace.ts';
import { chatRoot, contextRoot } from '../workspace/layout.ts';
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
  it('keeps the usage telemetry of CopilotKit switched off', () => {
    expect(process.env.COPILOTKIT_TELEMETRY_DISABLED).toBe('true');
  });

  it('lists only the agents of the employee’s departments', async () => {
    const res = await t.call('GET', '/app/api/agents', { cookie: olga });
    const { agents } = (await res.json()) as { agents: { id: string; actions: Record<string, { title: string }> }[] };
    expect(agents[0]!.actions['mastra_workspace_read_file']?.title).toBe('Чтение файла');
    expect(agents[0]!.actions['view_image']?.title).toBe('Просмотр картинки');
    expect(agents).toEqual([
      {
        id: 'sales',
        name: 'Продажи',
        description: 'Тестовый агент Продажи',
        starters: ['Покажи мои сделки'],
        // Its own mark (spec, section 8.17): the spark until an admin sets another.
        mark: { kind: 'icon', icon: 'spark' },
        actions: expect.objectContaining({
          // The workspace's own tools are named in words too, not mastra_workspace_read_file.
          ...WORKSPACE_ACTIONS,
          crm_search: { title: 'Найти сделки', fields: {}, readOnly: true },
          mail_send: { title: 'Отправить письмо клиенту', fields: { to: 'Кому', text: 'Текст письма' }, readOnly: false },
          // The mailbox (8.24) and the folder of the computer (8.25) are named for every agent.
          mailbox_send: expect.objectContaining({ title: 'Отправить письмо из почты сотрудника', readOnly: false }),
          computer_folder_read: { title: 'Чтение файла из папки с компьютера', fields: {}, readOnly: true },
        }),
        systems: { tools: { ...Object.fromEntries(MAIL_TOOL_NAMES.map((n) => [n, 'Почта'])), ...Object.fromEntries(Object.values(COMPUTER_TOOLS).map((n) => [n, 'Компьютер'])) }, prefixes: {} },
      },
    ]);
    // Nothing else: the agent's own, the workspace's, the memory's, past conversations', the mailbox's, the computer folder's
    // and the stamp's (docs/specs/[20.11.2026]-org-letterhead.md) actions.
    expect(Object.keys(agents[0]!.actions).sort()).toEqual([...Object.keys(WORKSPACE_ACTIONS), ...Object.keys(MEMORY_ACTIONS), ...Object.keys(CONVERSATIONS_ACTIONS), 'crm_search', 'mail_send', ...MAIL_TOOL_NAMES, ...Object.values(COMPUTER_TOOLS), SIGN_TOOL].sort());
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

  it('tells the chat window that a declined or superseded action was cancelled', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'z@example.com', text: 'z' } }] });
    const first = await run(olga, 'sales', threadId, 'Напиши письмо Зое');
    const interrupt = interruptOf(first.events)!;
    t.model.script({ text: 'Не отправляю.' });
    const declined = await run(olga, 'sales', threadId, null, [{ interruptId: interrupt.id, status: 'cancelled' }]);
    const result = declined.events.find((e) => e.type === 'TOOL_CALL_RESULT') as AguiEvent & { toolCallId?: string; content?: string };
    expect(declined.events[0]!.type).toBe('RUN_STARTED');
    expect(result.toolCallId).toBe(interrupt.id.split('::').at(-1));
    expect(JSON.parse(result.content!)).toEqual({ declined: true, superseded: false, expiredHours: null });

    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'z@example.com', text: 'z2' } }] });
    const again = await run(olga, 'sales', threadId, 'Попробуй ещё раз');
    t.model.script({ text: 'Хорошо.' }, { text: 'Рассказываю.' });
    const next = await run(olga, 'sales', threadId, 'Нет, расскажи про сделки');
    const superseded = next.events.find((e) => e.type === 'TOOL_CALL_RESULT') as AguiEvent & { toolCallId?: string; content?: string };
    expect(superseded.toolCallId).toBe(interruptOf(again.events)!.id.split('::').at(-1));
    expect(JSON.parse(superseded.content!)).toEqual({ declined: true, superseded: true, expiredHours: null });
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

describe('history of a conversation for the chat window', () => {
  async function connect(cookie: string, threadId: string): Promise<{ status: number; events: (AguiEvent & Record<string, unknown>)[] }> {
    const res = await t.call('POST', '/app/api/copilotkit/agent/sales/connect', { cookie, body: { threadId, runId: randomUUID(), messages: [], tools: [], context: [], state: {}, forwardedProps: {} } });
    const body = await res.text();
    return { status: res.status, events: body.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)) as AguiEvent & Record<string, unknown>) };
  }

  it('returns the stored messages with tool calls and the question still waiting for an answer', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'crm_search', args: { q: 'сделки' } }] }, { toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'Добрый день' } }] });
    await run(olga, 'sales', threadId, 'Найди сделки и напиши клиенту');

    const { status, events } = await connect(olga, threadId);
    expect(status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(['RUN_STARTED', 'MESSAGES_SNAPSHOT', 'RUN_FINISHED']);
    const messages = events[1]!.messages as { role: string; content?: string; toolCalls?: { function: { name: string } }[]; toolCallId?: string }[];
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Найди сделки и напиши клиенту' });
    // The call waiting for "Да" is shown by its card, not as a tool line.
    const calls = messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.function.name);
    expect(calls).toEqual(['crm_search']);
    expect(messages.find((m) => m.role === 'tool')).toMatchObject({ content: JSON.stringify({ deals: 12 }) });
    const outcome = events[2]!.outcome as { type: string; interrupts: { id: string; reason: string; metadata: { mastra: { toolName: string } } }[] };
    expect(outcome.type).toBe('interrupt');
    // The card shows the arguments as the model sent them, not the summary kept in the database.
    expect(outcome.interrupts[0]).toMatchObject({ reason: 'mastra:tool_approval', metadata: { mastra: { toolName: 'mail_send', args: { to: 'client@example.com', text: 'Добрый день' } } } });
    expect(outcome.interrupts[0]!.id).toMatch(/^mastra-approval::.+::.+$/);
  });

  it('shows a declined action as cancelled after a reload', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'k@example.com', text: 'k' } }] });
    const first = await run(olga, 'sales', threadId, 'Напиши письмо Ксении');
    t.model.script({ text: 'Не отправляю.' });
    await run(olga, 'sales', threadId, null, [{ interruptId: interruptOf(first.events)!.id, status: 'cancelled' }]);
    const { events } = await connect(olga, threadId);
    const messages = events[1]!.messages as { role: string; content?: string }[];
    expect(JSON.parse(messages.find((m) => m.role === 'tool')!.content!)).toEqual({ declined: true, superseded: false, expiredHours: null });
    expect(events[2]!.outcome).toBeUndefined();
  });

  it('opens the admin’s draft check through a header, apart from their own conversations', async () => {
    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const role = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Агенты', '["agents"]') RETURNING id`)).rows[0]!.id;
    await t.db.query('INSERT INTO app.user_roles (user_id, role_id) VALUES ($1, $2)', [igorId, role]);
    const threadId = randomUUID();
    const res = await t.app.request(`/app/api/copilotkit/agent/sales/run`, {
      method: 'POST',
      headers: { cookie: igor, origin: 'http://localhost:8080', 'content-type': 'application/json', 'x-bba-draft': '1' },
      body: JSON.stringify({ threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Проверка черновика' }], tools: [], context: [], state: {}, forwardedProps: {} }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const thread = await t.mastra.getAgentById('sales').getMemory().then((m) => m!.getThreadById({ threadId }));
    expect(thread?.resourceId).toBe(`draft:${igorId}`);

    // An attachment of the draft check goes into the same conversation.
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1])], 'Прайс.csv', { type: 'text/csv' }));
    const upload = await t.app.request(`/app/api/threads/${threadId}/files`, { method: 'POST', body: form, headers: { cookie: igor, origin: 'http://localhost:8080' } });
    expect(upload.status).toBe(201);
  });

  it('opens a new conversation empty and refuses someone else’s', async () => {
    // A new conversation gets no events at all: an empty snapshot could wipe the first message.
    const empty = await connect(olga, randomUUID());
    expect(empty.status).toBe(200);
    expect(empty.events).toEqual([]);

    const threadId = randomUUID();
    t.model.script({ text: 'Ок.' });
    await run(olga, 'sales', threadId, 'Личное');
    await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) SELECT id, 'sales' FROM app.departments ON CONFLICT DO NOTHING`);
    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const dep = (await t.db.query<{ id: string }>('SELECT id FROM app.departments LIMIT 1')).rows[0]!.id;
    await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dep, igorId]);
    expect((await connect(igor, threadId)).status).toBe(404);
  });
});

describe('addresses of the CopilotKit runtime', () => {
  const runBody = (threadId: string) => ({ threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Чужое' }], tools: [], context: [], state: {}, forwardedProps: {} });

  it('answers only the addresses the chat window uses and keeps conversations to their owner', async () => {
    const threadId = randomUUID();
    t.model.script({ text: 'Секрет Ольги.' });
    await run(olga, 'sales', threadId, 'Мой личный разговор');
    await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) SELECT id, 'sales' FROM app.departments ON CONFLICT DO NOTHING`);
    const igorId = (await t.db.query<{ id: string }>(`SELECT "id" FROM app."user" WHERE "email" = 'igor@example.com'`)).rows[0]!.id;
    const dep = (await t.db.query<{ id: string }>('SELECT id FROM app.departments LIMIT 1')).rows[0]!.id;
    await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dep, igorId]);

    expect((await t.call('GET', '/app/api/copilotkit/info', { cookie: igor })).status).toBe(200);
    for (const path of [`/app/api/copilotkit/threads/${threadId}/messages`, `/app/api/copilotkit/threads/${threadId}/events`, `/app/api/copilotkit/threads/${threadId}/state`]) {
      const res = await t.call('GET', path, { cookie: igor });
      expect(res.status, path).toBe(404);
      expect(await res.text()).not.toContain('Секрет Ольги');
    }
    // A prefix in front of a known address must not slip past the checks of the server.
    expect((await t.call('POST', '/app/api/copilotkit/x/agent/sales/connect', { cookie: igor, body: runBody(threadId) })).status).toBe(404);
    expect((await t.call('POST', '/app/api/copilotkit/x/agent/sales/run', { cookie: igor, body: runBody(threadId) })).status).toBe(404);
    expect((await t.call('POST', '/app/api/copilotkit', { cookie: igor, body: { method: 'agent/connect', params: { agentId: 'sales' }, body: runBody(threadId) } })).status).toBe(404);
    expect((await t.call('POST', `/app/api/copilotkit/agent/sales/stop/${threadId}`, { cookie: igor, body: {} })).status).toBe(404);
    expect((await t.call('POST', `/app/api/copilotkit/agent/sales/stop/${threadId}`, { cookie: olga, body: {} })).status).toBe(200);
  });
});

describe('attachments', () => {
  it('stores an attachment of a conversation in its own folder (spec, section 8.33)', async () => {
    const threadId = randomUUID();
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'Счёт.pdf', { type: 'application/pdf' }));
    const res = await t.app.request(`/app/api/threads/${threadId}/files`, { method: 'POST', body: form, headers: { cookie: olga, origin: 'http://localhost:8080' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: 'Счёт.pdf', path: 'Счёт.pdf', bytes: 3 });
    expect(existsSync(join(chatRoot(t.workspaceRoot, olgaId, threadId), 'Счёт.pdf'))).toBe(true);
  });

  it('two conversations keep a file of the same name each in its own folder (spec, section 8.33)', async () => {
    const upload = async (threadId: string, bytes: number[]) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(bytes)], 'Договор.docx'));
      const res = await t.app.request(`/app/api/threads/${threadId}/files`, { method: 'POST', body: form, headers: { cookie: olga, origin: 'http://localhost:8080' } });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ path: 'Договор.docx' });
    };
    const [first, second] = [randomUUID(), randomUUID()];
    await upload(first, [1]);
    await upload(second, [2, 2]);
    const download = async (threadId: string) => new Uint8Array(await (await t.call('GET', `/app/api/threads/${threadId}/file?path=${encodeURIComponent('Договор.docx')}`, { cookie: olga })).arrayBuffer());
    expect([...(await download(first))]).toEqual([1]);
    expect([...(await download(second))]).toEqual([2, 2]);
  });

  it('takes presentations and old Word, Excel and PowerPoint files as attachments (spec, section 8.18)', async () => {
    for (const name of ['Отчёт.pptx', 'Старый договор.doc', 'Цены 2009.xls', 'Итоги.ppt']) {
      const form = new FormData();
      form.append('file', new File([new Uint8Array([1])], name));
      const res = await t.app.request(`/app/api/threads/${randomUUID()}/files`, { method: 'POST', body: form, headers: { cookie: olga, origin: 'http://localhost:8080' } });
      expect(res.status, name).toBe(201);
    }
  });

  // The block of a file the agent made (spec, section 8.18): «Скачать» takes it from the folder of
  // the conversation — the person's own, or the project's.
  it('gives the person a file of the conversation folder to download, and nobody else', async () => {
    const threadId = randomUUID();
    const now = new Date();
    await t.memory.saveThread({ thread: { id: threadId, resourceId: olgaId, title: 'КП', metadata: { agentId: 'sales', kind: 'chat' }, createdAt: now, updatedAt: now } });
    const folder = chatRoot(t.workspaceRoot, olgaId, threadId);
    mkdirSync(join(folder, 'итоги'), { recursive: true });
    writeFileSync(join(folder, 'итоги', 'КП «Ёлка».docx'), 'DOCX-BYTES');
    const url = (path: string) => `/app/api/threads/${threadId}/file?path=${encodeURIComponent(path)}`;

    const res = await t.call('GET', url('итоги/КП «Ёлка».docx'), { cookie: olga });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('DOCX-BYTES');
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('КП «Ёлка».docx')}`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await t.call('GET', url(join(folder, 'итоги', 'КП «Ёлка».docx')), { cookie: olga })).status).toBe(200);

    const foreign = await t.call('GET', url('итоги/КП «Ёлка».docx'), { cookie: igor });
    expect(foreign.status).toBe(404);
    expect((await t.call('GET', url('../../x'), { cookie: olga })).status).toBe(400);
    // A link the agent made in the folder to a file of the server is not followed.
    symlinkSync('/etc/hostname', join(folder, 'leak.docx'));
    const leak = await t.call('GET', url('leak.docx'), { cookie: olga });
    expect(leak.status).toBe(400);
    expect(await leak.text()).not.toContain(readFileSync('/etc/hostname', 'utf8').trim());
    const missing = await t.call('GET', url('нет.docx'), { cookie: olga });
    expect(missing.status).toBe(404);
    // A file the person's own folder no longer has (spec, section 8.20): the chat says it was removed.
    expect(await missing.json()).toEqual({ error: { code: 'APP_FILE_DELETED', message: 'Файл «нет.docx» удалён из рабочей папки — скачать его нельзя.' } });

    const project = (await (await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Ёлка', access: { mode: 'private', departmentIds: [], userIds: [] } } })).json()) as { id: string };
    expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } })).status).toBe(200);
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, project.id), 'смета.xlsx'), 'XLSX');
    const fromProject = await t.call('GET', url('смета.xlsx'), { cookie: olga });
    expect(await fromProject.text()).toBe('XLSX');
    expect((await t.call('GET', url('итоги/КП «Ёлка».docx'), { cookie: olga })).status).toBe(404);
  });
});

// The agent works until it answers (decision of the owner 15.11): Mastra's own cap of 5 calls of the
// model in one answer cut work short in silence. Spending limits and «Стоп» stay what stops it.
describe('the loop of the agent', () => {
  it('goes on however many steps the work takes and ends with its answer', async () => {
    const threadId = randomUUID();
    const before = t.model.requests.length;
    t.model.script(...Array.from({ length: 7 }, (_, i) => ({ toolCalls: [{ name: 'crm_search', args: { q: `шаг ${i + 1}` } }] })), { text: 'Нашёл 12 сделок без движения.' });
    const { events } = await run(olga, 'sales', threadId, 'Найди сделки без движения, проверь всё по шагам');
    expect(textOf(events)).toBe('Нашёл 12 сделок без движения.');
    expect(t.model.requests.length - before).toBe(8);
  });
});
