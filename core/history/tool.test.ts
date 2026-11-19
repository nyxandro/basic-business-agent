// The agent's tool of past conversations (spec, section 8.28), through real runs of the test agent: only the
// person's own conversations, in a project or everywhere, found by words, read as the person saw them — and
// never a colleague's, even in a project open to the whole department.
import { randomUUID } from 'node:crypto';
import type { ProjectDto } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import type { FakeRequest } from '../models/fake-openai.ts';
import { BASE_RULES } from '../prompts/layers.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { CONVERSATIONS_TOOL } from './tool.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;
let department: string;

type Part = Record<string, unknown>;
const text = (value: string): Part => ({ type: 'text', text: value });
const call = (toolName: string, args: unknown, result: unknown, toolCallId = randomUUID()): Part => ({ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId, toolName, args, result } });

let clock = Date.parse('2026-11-01T07:00:00Z');
async function conversation(
  userId: string,
  title: string,
  turns: [role: 'user' | 'assistant', parts: Part[]][],
  opts: { projectId?: string; agentId?: string; kind?: 'chat' | 'background'; threadId?: string } = {},
): Promise<string> {
  const threadId = opts.threadId ?? randomUUID();
  await ensureThread(t.memory, { threadId, resourceId: userId, agentId: opts.agentId ?? 'sales', kind: opts.kind ?? 'chat', title });
  await t.memory.saveMessages({
    messages: turns.map(([role, parts]) => ({ id: randomUUID(), threadId, resourceId: userId, role, createdAt: new Date((clock += 60_000)), content: { format: 2 as const, parts: parts as never } })),
  });
  if (opts.projectId) await t.db.query('INSERT INTO app.thread_projects (thread_id, user_id, project_id) VALUES ($1, $2, $3)', [threadId, userId, opts.projectId]);
  return threadId;
}

async function project(cookie: string, name: string, access: { mode: 'private' | 'list' | 'org'; departmentIds: string[]; userIds: string[] }): Promise<string> {
  const res = await t.call('POST', '/app/api/projects', { cookie, body: { name, access } });
  expect(res.status).toBe(201);
  return ((await res.json()) as ProjectDto).id;
}

const ref = (id: string) => id.slice(0, 8);
const conversationsCall = (args: Record<string, unknown>) => ({ toolCalls: [{ name: CONVERSATIONS_TOOL, args }] });
const toolOutput = (req: FakeRequest): string => {
  const content = req.messages.filter((m) => m.role === 'tool').at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
};
const toolNames = (req: FakeRequest) => (req.tools ?? []).map((x) => x.function.name);

// One turn in a new conversation (in `projectId` when given): the model calls the tool, then answers.
async function ask(cookie: string, args: Record<string, unknown>, projectId?: string, threadId: string = randomUUID()): Promise<string> {
  if (projectId) expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie, body: { projectId } })).status).toBe(200);
  t.model.script(conversationsCall(args), { text: 'Готово.' });
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Что было раньше?' }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  await res.text();
  return toolOutput(t.model.requests.at(-1)!);
}
const parsed = (output: string) => JSON.parse(output) as Record<string, unknown> & { conversations?: Record<string, unknown>[]; transcript?: string; code?: string; message?: string };

let shared: string;
let kp: string;
let advance: string;

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  department = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  for (const id of [olgaId, petrId]) await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [department, id]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [department]);
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');

  shared = await project(olga, 'Тендер ЖК Северный', { mode: 'list', departmentIds: [department], userIds: [] });
  const roofProject = await project(olga, 'Кровля', { mode: 'private', departmentIds: [], userIds: [] });
  kp = await conversation(
    olgaId,
    'КП для ЖК Северный',
    [
      ['user', [text('Сделай КП по смете, скидка 7 %\n\nВложения:\n- Смета.xlsx (файл в рабочей папке: Смета.xlsx)')]],
      ['assistant', [call('show_table', { columns: [{ key: 'p', label: 'Позиция' }, { key: 'v', label: 'Цена' }], rows: [{ p: 'Кровля', v: '2 100 000 ₽' }] }, { shown: true }), call('show_file', { path: 'КП_v2.docx' }, { name: 'КП_v2.docx', path: 'КП_v2.docx', bytes: 10, shown: true }), text('Готово, итог 4,2 млн ₽. Пишите ivan@example.com')]],
    ],
    { projectId: shared },
  );
  advance = await conversation(olgaId, 'Договор, аванс', [['user', [text('Какой аванс?')]], ['assistant', [call('show_card', { title: 'Условия', fields: [{ label: 'Аванс', value: '30 %' }] }, { shown: true }), text('Условия — в карточке.')]]], {
    projectId: shared,
    agentId: 'assistant',
  });
  await conversation(petrId, 'Секрет Петра', [['user', [text('Мой личный вопрос про авансирование и премию')]]], { projectId: shared });
  await conversation(olgaId, 'Отпуск', [['user', [text('Как оформить отпуск?')]]]);
  await conversation(olgaId, 'Кровля школы', [['user', [text('Аванс по кровле — 20 %')]]], { projectId: roofProject });
});
afterAll(async () => {
  await t.close();
});

describe('conversations tool', () => {
  it('lists the person’s own conversations of the project, newest first, without the current one and without colleagues’', async () => {
    const out = parsed(await ask(olga, { mode: 'list' }, shared));
    const listed = out.conversations!;
    expect(listed.map((c) => c.title)).toEqual(['Договор, аванс', 'КП для ЖК Северный']);
    expect(listed[0]).toMatchObject({ ref: ref(advance), project: 'проект «Тендер ЖК Северный»', agent: 'Помощник', messages: 2 });
    expect(listed[1]).toMatchObject({ ref: ref(kp), agent: 'Продажи' });
    expect(JSON.stringify(out)).not.toContain('Секрет Петра');
    expect(out).toMatchObject({ total: 2, more: false });
  });

  it('lists every own conversation with where it is, when asked for all', async () => {
    const out = parsed(await ask(olga, { mode: 'list', scope: 'all' }, shared));
    const where = Object.fromEntries(out.conversations!.map((c) => [String(c.title), String(c.project)]));
    expect(where).toMatchObject({ 'Отпуск': 'вне проекта', 'Кровля школы': 'проект «Кровля»', 'КП для ЖК Северный': 'проект «Тендер ЖК Северный»' });
    expect(Object.keys(where)).not.toContain('Секрет Петра');
  });

  it('never gives a colleague’s conversation: not in a list, a search or a read, and its number reads as one that is not there', async () => {
    const list = await ask(petr, { mode: 'list' }, shared);
    expect(parsed(list).conversations!.map((c) => c.title)).toEqual(['Секрет Петра']);
    const found = await ask(petr, { mode: 'search', query: 'КП скидка', scope: 'all' }, shared);
    expect(parsed(found).conversations).toEqual([]);
    const theirs = parsed(await ask(petr, { mode: 'read', conversation: ref(kp) }, shared));
    const nothing = parsed(await ask(petr, { mode: 'read', conversation: 'ffffffff' }, shared));
    expect(theirs).toMatchObject({ error: true, code: 'APP_NOT_FOUND' });
    expect(theirs.message!.replace(ref(kp), 'X')).toBe(nothing.message!.replace('ffffffff', 'X'));
  });

  it('finds conversations by words, forms and typos — within the project or everywhere — with numbered pieces', async () => {
    const inProject = parsed(await ask(olga, { mode: 'search', query: 'аванс' }, shared));
    expect(inProject.conversations!.map((c) => c.title)).toEqual(['Договор, аванс']);
    const matches = inProject.conversations![0]!.matches as { number: number; who: string; fragment: string }[];
    expect(matches.map((m) => [m.number, m.who])).toEqual([[1, 'Сотрудник'], [2, 'Агент']]);
    expect(matches[1]!.fragment).toContain('Аванс');
    const everywhere = parsed(await ask(olga, { mode: 'search', query: 'аванс', scope: 'all' }, shared));
    expect(everywhere.conversations!.map((c) => c.title).sort()).toEqual(['Договор, аванс', 'Кровля школы']);
    const typo = parsed(await ask(olga, { mode: 'search', query: 'аванц', scope: 'all' }, shared));
    expect(typo.conversations!.length).toBeGreaterThan(0);
  });

  it('never tells what a typo was corrected to: the dictionary holds words of colleagues too', async () => {
    const out = await ask(olga, { mode: 'search', query: 'авансировани', scope: 'all' }, shared);
    expect(parsed(out).conversations).toEqual([]);
    expect(out).not.toContain('авансирование');
  });

  it('reads a conversation as the person saw it, with its blocks and files, and nothing hidden in the request to the model', async () => {
    await t.db.query(`UPDATE app.masking_settings SET kinds = '["email"]'`);
    let out: ReturnType<typeof parsed>;
    try {
      out = parsed(await ask(olga, { mode: 'read', conversation: ref(kp) }, shared));
      // The person's data reach the model as placeholders, as everything else does (spec, 8.11).
      expect(JSON.stringify(t.model.requests.at(-1)!.messages)).not.toContain('ivan@example.com');
    } finally {
      await t.db.query(`UPDATE app.masking_settings SET kinds = '[]'`);
    }
    expect(out.title).toBe('КП для ЖК Северный');
    expect(out.transcript).toContain('[1] ');
    expect(out.transcript).toContain('Сотрудник: Сделай КП по смете, скидка 7 %');
    expect(out.transcript).toContain('вложения: Смета.xlsx');
    expect(out.transcript).toContain('таблица: Позиция | Цена');
    expect(out.transcript).toContain('файл: КП_v2.docx');
    expect(out.transcript).toContain('Это конец разговора.');
    const [{ text: stored }] = (await t.db.query<{ text: string }>("SELECT text FROM app.message_texts WHERE thread_id = $1 AND role = 'assistant'", [kp])).rows as [{ text: string }];
    expect(stored).toContain('ivan@example.com');
  });

  it('tells what came of an action that waited for «Да», from its request and from the call', async () => {
    const callId = randomUUID();
    const sent = await conversation(olgaId, 'Письмо Ивану', [['user', [text('Отправь Ивану')]], ['assistant', [{ type: 'tool-invocation', toolInvocation: { state: 'output-error', toolCallId: callId, toolName: 'mail_send', args: {}, errorText: 'APP_MAIL_SEND_FAILED: отказ' } }, text('Не получилось.')]]]);
    await t.db.query(
      `INSERT INTO app.approval_requests (user_id, agent_id, thread_id, run_id, tool_call_id, tool, summary, status, expires_at) VALUES ($1, 'sales', $2, 'r1', $3, 'mail_send', 'Отправить письмо клиенту', 'approved', now() + interval '1 day')`,
      [olgaId, sent, callId],
    );
    const late = randomUUID();
    await t.db.query(`UPDATE mastra.mastra_messages SET content = jsonb_set(content::jsonb, '{parts}', (content::jsonb->'parts') || $2::jsonb)::text WHERE thread_id = $1 AND role = 'assistant'`, [
      sent,
      JSON.stringify([{ type: 'tool-invocation', toolInvocation: { state: 'call', toolCallId: late, toolName: 'mail_send', args: {} } }]),
    ]);
    // A question in a chat nobody answered in time stays «pending» in the table: only a press finds it out of date.
    await t.db.query(
      `INSERT INTO app.approval_requests (user_id, agent_id, thread_id, run_id, tool_call_id, tool, summary, status, expires_at) VALUES ($1, 'sales', $2, 'r2', $3, 'mail_send', 'Отправить письмо клиенту', 'pending', now() - interval '1 hour')`,
      [olgaId, sent, late],
    );
    const out = parsed(await ask(olga, { mode: 'read', conversation: ref(sent) }));
    expect(out.transcript).toContain('не выполнено после «Да»: Отправить письмо клиенту (APP_MAIL_SEND_FAILED)');
    expect(out.transcript).toContain('не подтверждено вовремя: Отправить письмо клиенту');
    expect(out.transcript).not.toContain('ждёт «Да»');
  });

  it('reads in portions from a message number or from the end, and reads the current conversation', async () => {
    const turns = Array.from({ length: 8 }, (_, i): [ 'user' | 'assistant', Part[]] => [i % 2 ? 'assistant' : 'user', [text(`${i + 1}: ${'слово '.repeat(250)}`)]]);
    const long = await conversation(olgaId, 'Длинный', turns);
    const first = parsed(await ask(olga, { mode: 'read', conversation: ref(long) }));
    expect(first.transcript).toMatch(/Дальше: read, conversation: "[^"]+", from: \d+/);
    const fromFive = parsed(await ask(olga, { mode: 'read', conversation: ref(long), from: 5 }));
    expect(fromFive.transcript).toContain('[5] ');
    expect(fromFive.transcript).not.toContain('[4] ');
    const end = parsed(await ask(olga, { mode: 'read', conversation: ref(long), from: 'end' }));
    expect(end.transcript).toContain('[8] ');
    const current = parsed(await ask(olga, { mode: 'read', conversation: 'current' }, undefined, long));
    expect(current.title).toBe('Длинный');
  });

  it('gives back what went wrong with what to do, as data, not as a failure of the answer', async () => {
    expect(parsed(await ask(olga, { mode: 'list', scope: 'project' }))).toMatchObject({ error: true, code: 'APP_VALIDATION_FAILED' });
    expect(parsed(await ask(olga, { mode: 'search', query: 'а' }))).toMatchObject({ error: true, code: 'APP_VALIDATION_FAILED' });
    expect(parsed(await ask(olga, { mode: 'read' }))).toMatchObject({ error: true, code: 'APP_VALIDATION_FAILED' });
    expect(parsed(await ask(olga, { mode: 'read', conversation: ref(kp), from: 99 }))).toMatchObject({ error: true, code: 'APP_VALIDATION_FAILED' });
    const twins = ['abcdef01-0000-4000-8000-000000000001', 'abcdef01-0000-4000-8000-000000000002'];
    for (const id of twins) await conversation(olgaId, `Близнец ${id.at(-1)}`, [['user', [text('привет')]]], { threadId: id });
    const ambiguous = parsed(await ask(olga, { mode: 'read', conversation: 'abcdef01' }));
    expect(ambiguous).toMatchObject({ error: true, code: 'APP_VALIDATION_FAILED' });
    expect(ambiguous.message).toContain('Близнец 1');
    expect(parsed(await ask(olga, { mode: 'read', conversation: twins[1] }))).toMatchObject({ title: 'Близнец 2' });
    // A number shorter than the short number is found when it is the whole id of the person's own conversation.
    await conversation(olgaId, 'Короткий номер', [['user', [text('привет')]]], { threadId: 'abc' });
    expect(parsed(await ask(olga, { mode: 'read', conversation: 'abc' }))).toMatchObject({ title: 'Короткий номер' });
    expect(parsed(await ask(olga, { mode: 'read', conversation: 'ab' }))).toMatchObject({ error: true, code: 'APP_NOT_FOUND' });
  });

  it('tells how many there are on a page past the end', async () => {
    const out = parsed(await ask(olga, { mode: 'list', page: 9 }, shared));
    expect(out).toMatchObject({ page: 9, more: false, conversations: [] });
    expect(out.total).toBeGreaterThan(0);
  });

  it('gives a superadministrator only their own conversations too', async () => {
    await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
    const igor = await t.signIn('igor@example.com');
    const out = parsed(await ask(igor, { mode: 'list', scope: 'all' }));
    expect(out.conversations).toEqual([]);
    expect(parsed(await ask(igor, { mode: 'read', conversation: ref(kp) }))).toMatchObject({ error: true, code: 'APP_NOT_FOUND' });
  });

  it('lists a background conversation of the person with its mark, and never a draft check of a prompt', async () => {
    await conversation(olgaId, 'Сводка по тендерам', [['assistant', [text('Нашёл 3 закупки.')]]], { projectId: shared, kind: 'background', threadId: `bg:${randomUUID()}:${olgaId}` });
    const rc = new RequestContext();
    const draftThread = randomUUID();
    for (const [key, value] of [[REQUEST_KEYS.userId, olgaId], [REQUEST_KEYS.threadId, draftThread], [REQUEST_KEYS.agentId, 'sales'], [REQUEST_KEYS.modelId, 'test-paid'], [REQUEST_KEYS.skillPaths, '[]'], [REQUEST_KEYS.abilities, '{"web":true,"commands":true}'], [REQUEST_KEYS.runKind, 'draft']] as const) rc.set(key, value);
    t.model.script({ text: 'Черновик проверен.' });
    await t.mastra.getAgent('sales').generate('Проверка черновика', { requestContext: rc, memory: { thread: draftThread, resource: `draft:${olgaId}` } });
    const listed = parsed(await ask(olga, { mode: 'list', scope: 'all' }));
    const background = listed.conversations!.find((c) => c.title === 'Сводка по тендерам');
    expect(background).toMatchObject({ kind: 'фоновая задача' });
    expect(listed.conversations!.some((c) => c.ref === ref(draftThread))).toBe(false);
  });

  it('is given only to the agent the person talks to in a conversation', async () => {
    for (const runKind of ['background', 'draft'] as const) {
      const rc = new RequestContext();
      const threadId = randomUUID();
      for (const [key, value] of [[REQUEST_KEYS.userId, olgaId], [REQUEST_KEYS.threadId, threadId], [REQUEST_KEYS.agentId, 'sales'], [REQUEST_KEYS.modelId, 'test-paid'], [REQUEST_KEYS.skillPaths, '[]'], [REQUEST_KEYS.abilities, '{"web":true,"commands":true}'], [REQUEST_KEYS.runKind, runKind]] as const) rc.set(key, value);
      t.model.script({ text: 'Готово.' });
      await t.mastra.getAgent('sales').generate('Привет', { requestContext: rc, memory: { thread: threadId, resource: runKind === 'draft' ? `draft:${olgaId}` : olgaId } });
      expect(toolNames(t.model.requests.at(-1)!)).not.toContain(CONVERSATIONS_TOOL);
    }
    await ask(olga, { mode: 'list', scope: 'all' });
    expect(toolNames(t.model.requests.at(-1)!)).toContain(CONVERSATIONS_TOOL);
  });

  it('is named in the core rules by the name it is registered under', () => {
    expect(BASE_RULES).toContain(`\`${CONVERSATIONS_TOOL}\``);
  });
});

