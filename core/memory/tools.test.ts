// The agent's memory tools (spec, section 8.26): it writes the project's memory and the person's own, sees
// what it wrote in the next turn, gets what went wrong with what to do, and has the tools only where it may write.
import { randomUUID } from 'node:crypto';
import type { ProjectDto } from '@bba/contracts';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { BASE_RULES } from '../prompts/layers.ts';
import { listEntries } from './entries.ts';
import { PERSONAL_MEMORY_TOOL, PROJECT_MEMORY_TOOL } from './tools.ts';

let t: TestApp;
let olga: string;
let olgaId: string;

const memoryCall = (name: 'project_memory' | 'personal_memory', operations: unknown[]) => ({ toolCalls: [{ name, args: { operations } }] });
const toolOutput = (req: FakeRequest): string => {
  const content = req.messages.filter((m) => m.role === 'tool').at(-1)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
};
const toolNames = (req: FakeRequest) => (req.tools ?? []).map((x) => x.function.name);

async function run(threadId: string, text: string): Promise<void> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
  });
  expect(res.status).toBe(200);
  await res.text();
}

async function projectThread(name: string): Promise<{ projectId: string; threadId: string }> {
  const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name, access: { mode: 'private', departmentIds: [], userIds: [] } } });
  const projectId = ((await created.json()) as ProjectDto).id;
  const threadId = randomUUID();
  expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId } })).status).toBe(200);
  return { projectId, threadId };
}

// A run of the agent straight through Mastra, as a background task or a draft check starts it.
async function generateAs(runKind: 'background' | 'draft'): Promise<FakeRequest> {
  const rc = new RequestContext();
  const threadId = randomUUID();
  rc.set(REQUEST_KEYS.userId, olgaId);
  rc.set(REQUEST_KEYS.threadId, threadId);
  rc.set(REQUEST_KEYS.agentId, 'sales');
  rc.set(REQUEST_KEYS.modelId, 'test-paid');
  rc.set(REQUEST_KEYS.skillPaths, '[]');
  rc.set(REQUEST_KEYS.runKind, runKind);
  t.model.script({ text: 'Готово.' });
  await t.mastra.getAgent('sales').generate('Привет', { requestContext: rc, memory: { thread: threadId, resource: runKind === 'draft' ? `draft:${olgaId}` : olgaId } });
  return t.model.requests.at(-1)!;
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the memory tools of the agent', () => {
  it('remember in the project with the person as the author, and the next turn sees it', async () => {
    const { projectId, threadId } = await projectThread('Кровля школы');
    t.model.script(memoryCall('project_memory', [{ action: 'add', text: 'Подача до 28.11.2026 09:00' }, { action: 'add', text: 'Аванс не предусмотрен' }]), (req) => ({ text: toolOutput(req) }));
    await run(threadId, 'Разбери документацию');
    const output = toolOutput(t.model.requests.at(-1)!);
    expect(JSON.parse(output)).toMatchObject({ results: [{ action: 'add', number: 1 }, { action: 'add', number: 2 }], maxChars: 6000 });
    const entries = (await listEntries(t.db, { kind: 'project', projectId })).entries;
    expect(entries.map((e) => [e.number, e.author.id, e.author.byAgent])).toEqual([
      [2, olgaId, true],
      [1, olgaId, true],
    ]);

    t.model.script({ text: 'По памяти проекта — 28.11.' });
    await run(threadId, 'Какой срок подачи?');
    expect(JSON.stringify(t.model.requests.at(-1)!.messages)).toContain('- [1] Подача до 28.11.2026 09:00 — Ольга Смирнова через агента');
  });

  it('change an entry in the version the agent saw, and again in the same answer', async () => {
    const { projectId, threadId } = await projectThread('Горбольница');
    const added = await t.call('POST', `/app/api/projects/${projectId}/memory`, { cookie: olga, body: { text: 'Срок поставки 10 дней' } });
    expect(added.status).toBe(200);
    t.model.script(
      memoryCall('project_memory', [{ action: 'change', number: 1, text: 'Срок поставки 12 дней' }]),
      memoryCall('project_memory', [{ action: 'change', number: 1, text: 'Срок поставки 15 дней' }]),
      (req) => ({ text: toolOutput(req) }),
    );
    await run(threadId, 'Срок поставки сдвинули');
    expect(JSON.parse(toolOutput(t.model.requests.at(-1)!))).toMatchObject({ results: [{ action: 'change', number: 1, text: 'Срок поставки 15 дней', previousText: 'Срок поставки 12 дней' }] });
    const entry = (await listEntries(t.db, { kind: 'project', projectId })).entries[0]!;
    expect(entry).toMatchObject({ text: 'Срок поставки 15 дней', author: { id: olgaId, byAgent: true } });
  });

  it('tell the model what went wrong and what to do; nothing of the failed call is saved', async () => {
    const { projectId, threadId } = await projectThread('Полная память');
    for (let i = 0; i < 14; i++) await t.call('POST', `/app/api/projects/${projectId}/memory`, { cookie: olga, body: { text: `${i} ${'ф'.repeat(396)}` } });
    await t.call('POST', `/app/api/projects/${projectId}/memory`, { cookie: olga, body: { text: 'х'.repeat(300) } });
    t.model.script(memoryCall('project_memory', [{ action: 'add', text: 'Новый срок '.padEnd(200, 'ы') }]), memoryCall('project_memory', [{ action: 'remove', number: 99 }]), { text: 'Понял.' });
    await run(threadId, 'Запомни новый срок');
    const outputs = t.model.requests.slice(-2).map(toolOutput);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ error: true, code: 'APP_MEMORY_FULL' });
    expect(outputs[0]).toMatch(/объедини близкие записи/i);
    expect(JSON.parse(outputs[1]!)).toMatchObject({ error: true, code: 'APP_MEMORY_ENTRY_NOT_FOUND' });
    expect((await listEntries(t.db, { kind: 'project', projectId })).entries).toHaveLength(15);
  });

  it('keep the real value behind a masked one', async () => {
    await t.db.query(`UPDATE app.masking_settings SET kinds = '["email"]'`);
    try {
      const { projectId, threadId } = await projectThread('Контакты');
      t.model.script((req) => {
        const placeholder = /\[ПОЧТА_\d+\]/.exec(JSON.stringify(req.messages))?.[0] ?? 'нет заглушки';
        return memoryCall('project_memory', [{ action: 'add', text: `Контакт заказчика ${placeholder}` }]);
      }, { text: 'Запомнил.' });
      await run(threadId, 'Запомни контакт заказчика zakaz@example.org');
      expect((await listEntries(t.db, { kind: 'project', projectId })).entries.map((e) => e.text)).toEqual(['Контакт заказчика zakaz@example.org']);
    } finally {
      await t.db.query(`UPDATE app.masking_settings SET kinds = '[]'`);
    }
  });

  it('write the personal memory in any conversation of the chat', async () => {
    t.model.script(memoryCall('personal_memory', [{ action: 'add', text: 'Ведёт только юрлиц' }]), { text: 'Запомнил.' });
    await run(randomUUID(), 'Я веду только юрлиц');
    expect((await listEntries(t.db, { kind: 'personal', userId: olgaId })).entries.map((e) => e.text)).toContain('Ведёт только юрлиц');
  });

  it('are given only where the agent may write: the project’s in its conversations, none to a background task or a draft check', async () => {
    t.model.script({ text: 'Привет.' });
    await run(randomUUID(), 'Привет');
    expect(toolNames(t.model.requests.at(-1)!)).toEqual(expect.arrayContaining(['personal_memory']));
    expect(toolNames(t.model.requests.at(-1)!)).not.toContain('project_memory');

    const { threadId } = await projectThread('Инструменты');
    t.model.script({ text: 'Привет.' });
    await run(threadId, 'Привет');
    expect(toolNames(t.model.requests.at(-1)!)).toEqual(expect.arrayContaining(['personal_memory', 'project_memory']));

    for (const runKind of ['background', 'draft'] as const) {
      const names = toolNames(await generateAs(runKind));
      expect(names).not.toContain('personal_memory');
      expect(names).not.toContain('project_memory');
    }
  });
});

describe('the core rules', () => {
  it('name the memory tools the agent has, and not the working memory of Mastra', () => {
    expect(BASE_RULES).toContain(`\`${PROJECT_MEMORY_TOOL}\``);
    expect(BASE_RULES).toContain(`\`${PERSONAL_MEMORY_TOOL}\``);
    expect(BASE_RULES).not.toContain('updateWorkingMemory');
  });
});
