import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { PostgresStore } from '@mastra/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentPassport } from '../config/schemas.ts';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import type { AgentRuntime, Registry } from '../loader/registry.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import { startFakeModel, type FakeModel } from '../models/fake-openai.ts';
import { createMemory } from '../memory/memory.ts';
import { createMastraRuntime } from '../runtime/mastra.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { contextRoot, saveFile } from '../workspace/layout.ts';
import { getPromptState, publishDraft, resolveAgent, revertToFile, saveDraft, type EditorDeps } from './prompts.ts';

let database: TestDatabase;
let db: Db;
let model: FakeModel;
let mastra: Mastra;
let deps: EditorDeps;
let workspaceRoot: string;
const PROJECT = '0b8e2a9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

function runtime(passport: Partial<AgentPassport> & { id: string }, instructions: string): AgentRuntime {
  return {
    passport: { name: passport.id, description: 'x', plugins: [], readOnly: [], starters: [], ...passport },
    dir: `/agents/${passport.id}`,
    instructions,
    tools: {},
    readOnly: new Set(),
    subagents: [],
    connectorIds: [],
    toolSystems: {},
  };
}

const sales = runtime({ id: 'sales' }, 'Ты агент отдела продаж.');
const raw = runtime({ id: 'raw', baseRules: false }, 'Ты агент без правил ядра.');
const registry: Registry = {
  agents: [sales, raw],
  get: (id) => [sales, raw].find((a) => a.passport.id === id),
  ids: () => new Set(['sales', 'raw']),
  pluginMigrations: [],
  connectors: [],
  triggers: [],
};

async function systemPromptOf(agentId: string, mode: 'published' | 'draft', projectId?: string): Promise<string[]> {
  const agent = await resolveAgent(deps, agentId, mode);
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, 'olga');
  rc.set(REQUEST_KEYS.modelId, 'test-paid');
  rc.set(REQUEST_KEYS.skillPaths, '[]');
  const threadId = `t-${Date.now()}`;
  rc.set(REQUEST_KEYS.threadId, threadId);
  if (projectId) rc.set(REQUEST_KEYS.projectId, projectId);
  model.script({ text: 'Ок.' });
  await agent.generate('привет', { requestContext: rc, maxSteps: 1, memory: { thread: threadId, resource: 'olga' } });
  return model.requests.at(-1)!.messages.filter((m) => m.role === 'system').map((m) => String(m.content));
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  await ensureMaskingSettings(db, []);
  await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES
    ('igor', 'Игорь', 'igor@example.com', true), ('anna', 'Анна', 'anna@example.com', true), ('olga', 'Ольга', 'olga@example.com', true)`);
  await db.query(`INSERT INTO app.user_profiles (user_id, position) VALUES ('olga', 'менеджер по продажам')`);
  await db.query(`WITH d AS (INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id) INSERT INTO app.department_members (department_id, user_id) SELECT id, 'olga' FROM d`);
  await db.query(`INSERT INTO app.org_profile (tone, industry) VALUES ('на «вы», без канцелярита', 'строительство')`);
  model = await startFakeModel();
  const storage = new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' });
  const gateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
  workspaceRoot = mkdtempSync(join(tmpdir(), 'bba-prompts-'));
  mastra = createMastraRuntime({ registry, storage, memory: createMemory(storage), gateway, db, app: { name: 'Альфа-Строй', timezone: 'Europe/Moscow' }, workspaceRoot });
  deps = { db, mastra, registry };
});
afterAll(async () => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  await model.close();
  await db.end();
  await database.drop();
});

describe('prompt layers', () => {
  it('puts core rules first, then the agent prompt, the organisation and the employee', async () => {
    const system = await systemPromptOf('sales', 'published');
    const all = system.join('\n');
    const position = (needle: string) => all.indexOf(needle);
    expect(position('# Правила ядра')).toBe(0);
    expect(position('Ты агент отдела продаж.')).toBeGreaterThan(position('# Правила ядра'));
    expect(position('# Профиль организации')).toBeGreaterThan(position('Ты агент отдела продаж.'));
    expect(position('# Сотрудник, с которым ты говоришь')).toBeGreaterThan(position('# Профиль организации'));
    const joined = system.join('\n');
    for (const fact of ['Альфа-Строй', 'строительство', 'на «вы», без канцелярита', 'Ольга', 'менеджер по продажам', 'Продажи']) expect(joined).toContain(fact);
  });

  it('puts the project after the employee and the current time only into the outgoing last message, so the prompt and the history do not change between requests', async () => {
    await db.query(`INSERT INTO app.projects (id, user_id, name, instructions) VALUES ($1, 'olga', 'Тендер ЖК Северный', 'Заказчик тендера — ООО Стройресурс.')`, [PROJECT]);
    saveFile(contextRoot(workspaceRoot, 'olga', PROJECT), 'договор.pdf', new Uint8Array(2048));
    const first = await systemPromptOf('sales', 'published', PROJECT);
    const all = first.join('\n');
    expect(all.indexOf('# Проект «Тендер ЖК Северный»')).toBeGreaterThan(all.indexOf('# Сотрудник, с которым ты говоришь'));
    expect(all).toContain('Заказчик тендера — ООО Стройресурс.');
    expect(all).toContain('договор.pdf (2 КБ)');
    expect(all).not.toContain('Сейчас:');
    const lastUser = model.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(lastUser.content)).toMatch(/привет.*Сейчас: .+ \(Europe\/Moscow\)/s);
    const second = await systemPromptOf('sales', 'published', PROJECT);
    expect(second).toEqual(first);
    expect((await systemPromptOf('sales', 'published')).join('\n')).not.toContain('# Проект');
  });

  it('keeps the current time out of the stored conversation', async () => {
    const agent = await resolveAgent(deps, 'sales', 'published');
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, 'olga');
    rc.set(REQUEST_KEYS.modelId, 'test-paid');
    rc.set(REQUEST_KEYS.skillPaths, '[]');
    rc.set(REQUEST_KEYS.threadId, 'time-check');
    model.script({ text: 'Ок.' });
    await agent.generate('который час?', { requestContext: rc, maxSteps: 1, memory: { thread: 'time-check', resource: 'olga' } });
    const memory = (await agent.getMemory())!;
    const { messages } = await memory.recall({ threadId: 'time-check', resourceId: 'olga', perPage: false });
    expect(JSON.stringify(messages)).toContain('который час?');
    expect(JSON.stringify(messages)).not.toContain('Сейчас:');
  });

  it('leaves the core rules out only when the passport says baseRules: false', async () => {
    const system = await systemPromptOf('raw', 'published');
    expect(system.join('\n')).not.toContain('# Правила ядра');
    expect(system.join('\n')).toContain('Ты агент без правил ядра.');
  });
});

describe('prompt edits over the file', () => {
  it('keeps a draft away from employees, publishes it, and returns to the file', async () => {
    const versionId = await saveDraft(deps, 'igor', 'sales', { text: 'Ты агент продаж, отвечай очень кратко.', baseDraftVersionId: null });
    expect((await systemPromptOf('sales', 'published')).join('\n')).toContain('Ты агент отдела продаж.');
    expect((await systemPromptOf('sales', 'draft')).join('\n')).toContain('отвечай очень кратко');
    expect(await getPromptState(deps, 'sales')).toMatchObject({ draftVersionId: versionId, draftBy: 'Игорь', publishedInstructions: null });

    await publishDraft(deps, 'igor', 'sales');
    const published = (await systemPromptOf('sales', 'published')).join('\n');
    expect(published).toContain('отвечай очень кратко');
    expect(published).not.toContain('Ты агент отдела продаж.');
    expect(published).toContain('# Правила ядра');
    expect(await getPromptState(deps, 'sales')).toMatchObject({ draftVersionId: null, fileChangedSincePublish: false });

    await revertToFile(deps, 'igor', 'sales');
    expect((await systemPromptOf('sales', 'published')).join('\n')).toContain('Ты агент отдела продаж.');
  });

  it('refuses a draft saved over someone else’s newer draft and names who changed it', async () => {
    const base = (await getPromptState(deps, 'sales')).draftVersionId;
    await saveDraft(deps, 'anna', 'sales', { text: 'Версия Анны.', baseDraftVersionId: base });
    await expect(saveDraft(deps, 'igor', 'sales', { text: 'Версия Игоря.', baseDraftVersionId: base })).rejects.toMatchObject({
      code: 'APP_AGENT_DRAFT_CONFLICT',
      userMessage: expect.stringContaining('Анна'),
    });
  });

  it('refuses an empty prompt', async () => {
    const base = (await getPromptState(deps, 'sales')).draftVersionId;
    await expect(saveDraft(deps, 'igor', 'sales', { text: '   ', baseDraftVersionId: base })).rejects.toMatchObject({ code: 'APP_AGENT_INSTRUCTIONS_EMPTY' });
  });

  it('marks a published edit when the file changed after it', async () => {
    const base = (await getPromptState(deps, 'sales')).draftVersionId;
    await saveDraft(deps, 'igor', 'sales', { text: 'Опубликованная правка.', baseDraftVersionId: base });
    await publishDraft(deps, 'igor', 'sales');
    const original = sales.instructions;
    sales.instructions = 'Файл поменяли в репозитории.';
    try {
      expect((await getPromptState(deps, 'sales')).fileChangedSincePublish).toBe(true);
    } finally {
      sales.instructions = original;
    }
  });
});
