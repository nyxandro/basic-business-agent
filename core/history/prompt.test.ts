// What the agent knows of past conversations before it asks (spec, section 8.28): the names of the person's
// last conversations in the project, in the project's layer — only for the agent the person talks to in a
// conversation —, and in a long conversation which first messages the model no longer sees.
import { randomUUID } from 'node:crypto';
import type { ProjectDto } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import type { FakeRequest } from '../models/fake-openai.ts';
import { createPromptLayersProcessor } from '../prompts/layers.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let projectId: string;

const HEADING = '## Твои прошлые разговоры в этом проекте';
let clock = Date.parse('2026-10-01T07:00:00Z');

async function conversation(userId: string, title: string, texts: string[], opts: { projectId?: string; agentId?: string; threadId?: string } = {}): Promise<string> {
  const threadId = opts.threadId ?? randomUUID();
  await ensureThread(t.memory, { threadId, resourceId: userId, agentId: opts.agentId ?? 'sales', kind: 'chat', title });
  await t.memory.saveMessages({
    messages: texts.map((value, i) => ({ id: randomUUID(), threadId, resourceId: userId, role: i % 2 ? ('assistant' as const) : ('user' as const), createdAt: new Date((clock += 60_000)), content: { format: 2 as const, parts: [{ type: 'text' as const, text: value }] } })),
  });
  if (opts.projectId) await t.db.query('INSERT INTO app.thread_projects (thread_id, user_id, project_id) VALUES ($1, $2, $3)', [threadId, userId, opts.projectId]);
  return threadId;
}

const systemText = (req: FakeRequest) =>
  req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
const lastUserText = (req: FakeRequest) => {
  const content = req.messages.filter((m) => m.role === 'user').at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
};

async function turn(threadId: string, inProject: string | null, message = 'Привет'): Promise<FakeRequest> {
  if (inProject) await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: inProject } });
  t.model.script({ text: 'Готово.' });
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: message }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  await res.text();
  return t.model.requests.at(-1)!;
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  const department = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  for (const id of [olgaId, petrId]) await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [department, id]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [department]);
  olga = await t.signIn('olga@example.com');
  const res = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер ЖК Северный', access: { mode: 'list', departmentIds: [department], userIds: [] } } });
  projectId = ((await res.json()) as ProjectDto).id;
});
afterAll(async () => {
  await t.close();
});

describe('past conversations in the prompt', () => {
  it('names the person’s last conversations of the project, without the current one and without colleagues’, with another agent named', async () => {
    const kp = await conversation(olgaId, 'КП для ЖК Северный', ['Сделай КП', 'Готово'], { projectId });
    await conversation(olgaId, 'Договор, аванс', ['Аванс?', '30 %'], { projectId, agentId: 'assistant' });
    await conversation(petrId, 'Секрет Петра', ['Личное'], { projectId });
    await conversation(olgaId, 'Отпуск', ['Как оформить отпуск?']);
    const current = randomUUID();
    const system = systemText(await turn(current, projectId));
    const block = system.slice(system.indexOf(HEADING));
    expect(block).toContain(`- [${kp.slice(0, 8)}] КП для ЖК Северный — `);
    expect(block).toContain('Договор, аванс — ');
    expect(block).toContain('· с агентом «Помощник»');
    expect(block.indexOf('Договор, аванс')).toBeLessThan(block.indexOf('КП для ЖК Северный'));
    expect(system).not.toContain('Секрет Петра');
    expect(system).not.toContain('Отпуск');
    expect(block).not.toContain(current.slice(0, 8));
    // After the memory of the project, before its files.
    expect(system.indexOf('## Память проекта')).toBeLessThan(system.indexOf(HEADING));
  });

  it('shows the last twenty and how many more there are', async () => {
    const res = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Много разговоров', access: { mode: 'private', departmentIds: [], userIds: [] } } });
    const many = ((await res.json()) as ProjectDto).id;
    for (let i = 1; i <= 23; i++) await conversation(olgaId, `Разговор ${i}`, ['текст'], { projectId: many });
    const system = systemText(await turn(randomUUID(), many));
    expect(system).toContain('Разговор 23 — ');
    expect(system).toContain('Разговор 4 — ');
    expect(system).not.toContain('Разговор 3 — ');
    expect(system).toContain('- и ещё 3 — conversations, list');
  });

  it('has no list outside a project, and none in a project without past conversations', async () => {
    expect(systemText(await turn(randomUUID(), null))).not.toContain(HEADING);
    const res = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Пустой', access: { mode: 'private', departmentIds: [], userIds: [] } } });
    const empty = ((await res.json()) as ProjectDto).id;
    expect(systemText(await turn(randomUUID(), empty))).not.toContain(HEADING);
  });

  it('tells which first messages of a long conversation the model does not see, next to the time and outside the system prompt', async () => {
    const long = await conversation(olgaId, 'Длинный', Array.from({ length: 40 }, (_, i) => `[[${i + 1}]]`));
    const first = await turn(long, null, 'Что было в начале?');
    const note = /Сообщения 1–(\d+) этого разговора тебе не видны/.exec(lastUserText(first));
    expect(note).not.toBeNull();
    const hidden = Number(note![1]);
    const history = JSON.stringify(first.messages);
    expect(history).toContain(`[[${hidden + 1}]]`);
    expect(history).not.toContain(`[[${hidden}]]`);
    expect(systemText(first)).not.toContain('тебе не видны');
    // The system prompt stays the same while the number grows.
    const second = await turn(long, null, 'А ещё?');
    expect(systemText(second)).toBe(systemText(first));
    // The note is not kept in the stored history.
    const stored = await t.db.query<{ n: string }>(`SELECT count(*) AS n FROM mastra.mastra_messages WHERE thread_id = $1 AND content LIKE '%тебе не видны%'`, [long]);
    expect(Number(stored.rows[0]!.n)).toBe(0);
  });

  it('has no note in a conversation the model sees whole', async () => {
    const short = await conversation(olgaId, 'Короткий', ['раз', 'два']);
    expect(lastUserText(await turn(short, null))).not.toContain('тебе не видны');
  });

  it('gives neither the list nor the note to a sub-agent, a background task or a draft check', async () => {
    const long = await conversation(olgaId, 'Длинный фоновый', Array.from({ length: 40 }, (_, i) => `[[${i + 1}]]`), { projectId });
    const cases: { level: 'top' | 'sub'; runKind: string }[] = [
      { level: 'sub', runKind: 'chat' },
      { level: 'top', runKind: 'background' },
      { level: 'top', runKind: 'draft' },
    ];
    for (const { level, runKind } of cases) {
      const processor = createPromptLayersProcessor({ db: t.db, timezone: 'Europe/Moscow', baseRules: false, workspaceRoot: t.workspaceRoot, level, agentId: 'sales', agentName: (id) => id, agents: () => [] });
      const rc = new RequestContext();
      for (const [key, value] of [[REQUEST_KEYS.userId, olgaId], [REQUEST_KEYS.threadId, long], [REQUEST_KEYS.agentId, 'sales'], [REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}'], [REQUEST_KEYS.runKind, runKind], [REQUEST_KEYS.projectId, projectId], [REQUEST_KEYS.projectOwnerId, olgaId]] as const) rc.set(key, value);
      const out = await processor.processInput({ messages: [], systemMessages: [], requestContext: rc } as never);
      const system = JSON.stringify(out);
      expect(system, `${level} ${runKind}`).not.toContain(HEADING);
      const request = processor.processLLMRequest({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Привет' }] }], requestContext: rc } as never);
      expect(JSON.stringify(request), `${level} ${runKind}`).not.toContain('тебе не видны');
    }
  });

  it('keeps the note away from a sub-agent that shares the run of the agent the person talks to', async () => {
    const long = await conversation(olgaId, 'Длинный с помощником', Array.from({ length: 40 }, (_, i) => `[[${i + 1}]]`));
    const rc = new RequestContext();
    for (const [key, value] of [[REQUEST_KEYS.userId, olgaId], [REQUEST_KEYS.threadId, long], [REQUEST_KEYS.agentId, 'sales'], [REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}'], [REQUEST_KEYS.runKind, 'chat']] as const) rc.set(key, value);
    const deps = { db: t.db, timezone: 'Europe/Moscow', baseRules: false, workspaceRoot: t.workspaceRoot, agentId: 'sales', agentName: (id: string) => id, agents: () => [] };
    const top = createPromptLayersProcessor({ ...deps, level: 'top' });
    const sub = createPromptLayersProcessor({ ...deps, level: 'sub' });
    await top.processInput({ messages: [], systemMessages: [], requestContext: rc } as never);
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Привет' }] }];
    expect(JSON.stringify(top.processLLMRequest({ prompt, requestContext: rc } as never))).toContain('тебе не видны');
    expect(JSON.stringify(sub.processLLMRequest({ prompt, requestContext: rc } as never))).not.toContain('тебе не видны');
  });
});
