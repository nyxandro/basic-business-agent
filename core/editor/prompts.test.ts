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
import { addEntry } from '../memory/entries.ts';
import { createMemory } from '../memory/memory.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';
import { createFileStorage } from '../storage/engine.ts';
import { createPromptLayersProcessor } from '../prompts/layers.ts';
import { createMastraRuntime } from '../runtime/mastra.ts';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { contextRoot, saveFile } from '../workspace/layout.ts';
import { getPromptState, publishDraft, resolveAgent, revertToFile, saveDraft, type EditorDeps } from './prompts.ts';
import { createChainService } from '../approvals/chains.ts';

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
const lawyer = runtime({ id: 'lawyer', name: 'Юрист', description: 'Проверяет договоры и претензии.' }, 'Ты юрист организации.');
const registry: Registry = {
  agents: [sales, raw, lawyer],
  get: (id) => [sales, raw, lawyer].find((a) => a.passport.id === id),
  ids: () => new Set(['sales', 'raw', 'lawyer']),
  pluginMigrations: [],
  connectors: [],
  triggers: [],
};

async function systemPromptOf(agentId: string, mode: 'published' | 'draft', projectId?: string, threadId = `t-${Date.now()}`, user = 'olga'): Promise<string[]> {
  const agent = await resolveAgent(deps, agentId, mode);
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, user);
  rc.set(REQUEST_KEYS.runKind, mode === 'draft' ? 'draft' : 'chat');
  rc.set(REQUEST_KEYS.modelId, 'test-paid');
  rc.set(REQUEST_KEYS.skillPaths, '[]');
  rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}');
  rc.set(REQUEST_KEYS.threadId, threadId);
  if (projectId) {
    rc.set(REQUEST_KEYS.projectId, projectId);
    rc.set(REQUEST_KEYS.projectOwnerId, 'olga');
  }
  model.script({ text: 'Ок.' });
  await agent.generate('привет', { requestContext: rc, maxSteps: 1, memory: { thread: threadId, resource: user } });
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
  await db.query(`INSERT INTO app.org_profile (name, tone, industry) VALUES ('Альфа-Строй', 'на «вы», без канцелярита', 'строительство')`);
  model = await startFakeModel();
  const storage = new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' });
  const gateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
  workspaceRoot = mkdtempSync(join(tmpdir(), 'bba-prompts-'));
  const files = createFileStorage({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS), workspaceRoot, keepCopyMs: 0 });
  mastra = createMastraRuntime({ chains: createChainService({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS) }), registry, storage, memory: createMemory(storage), gateway, db, app: { timezone: 'Europe/Moscow' }, workspaceRoot, files, docText: { text: () => Promise.resolve(null), full: () => Promise.resolve(null) }, orgFilesDir: join(workspaceRoot, 'org-files') });
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
    await db.query(`INSERT INTO app.projects (id, user_id, name, instructions, access) VALUES ($1, 'olga', 'Тендер ЖК Северный', 'Заказчик тендера — ООО Стройресурс.', 'private')`, [PROJECT]);
    saveFile(contextRoot(workspaceRoot, 'olga', PROJECT), 'договор.pdf', new Uint8Array(2048));
    const thread = `t-${Date.now()}`;
    const first = await systemPromptOf('sales', 'published', PROJECT, thread);
    const all = first.join('\n');
    expect(all.indexOf('# Проект «Тендер ЖК Северный»')).toBeGreaterThan(all.indexOf('# Сотрудник, с которым ты говоришь'));
    expect(all).toContain('Заказчик тендера — ООО Стройресурс.');
    expect(all).toContain('договор.pdf (2 КБ)');
    expect(all).not.toContain('Сейчас:');
    const lastUser = model.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(lastUser.content)).toMatch(/привет.*Сейчас: .+ \(Europe\/Moscow\)/s);
    const second = await systemPromptOf('sales', 'published', PROJECT, thread);
    expect(second).toEqual(first);
    expect((await systemPromptOf('sales', 'published')).join('\n')).not.toContain('# Проект');
  });

  it('keeps the current time out of the stored conversation', async () => {
    const agent = await resolveAgent(deps, 'sales', 'published');
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, 'olga');
    rc.set(REQUEST_KEYS.modelId, 'test-paid');
    rc.set(REQUEST_KEYS.skillPaths, '[]');
    rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}');
    rc.set(REQUEST_KEYS.threadId, 'time-check');
    model.script({ text: 'Ок.' });
    await agent.generate('который час?', { requestContext: rc, maxSteps: 1, memory: { thread: 'time-check', resource: 'olga' } });
    const memory = (await agent.getMemory())!;
    const { messages } = await memory.recall({ threadId: 'time-check', resourceId: 'olga', perPage: false });
    expect(JSON.stringify(messages)).toContain('который час?');
    expect(JSON.stringify(messages)).not.toContain('Сейчас:');
  });

  it('names the other agents open to the employee after the employee, so an agent can send a question outside its role to one of them', async () => {
    const other = '# Другие агенты сотрудника';
    expect((await systemPromptOf('sales', 'published')).join('\n')).not.toContain(other);
    await db.query(`INSERT INTO app.department_agents (department_id, agent_id) SELECT id, unnest(ARRAY['sales', 'lawyer']) FROM app.departments WHERE name = 'Продажи'`);
    try {
      const all = (await systemPromptOf('sales', 'published')).join('\n');
      expect(all.indexOf(other)).toBeGreaterThan(all.indexOf('# Сотрудник, с которым ты говоришь'));
      const layer = all.slice(all.indexOf(other));
      expect(layer).toContain('- «Юрист» — Проверяет договоры и претензии.');
      // Neither the agent itself nor an agent the employee has no access to.
      expect(layer).not.toContain('«sales»');
      expect(layer).not.toContain('«raw»');
      // An agent without the core's rules has no rule that asks for the list.
      expect((await systemPromptOf('raw', 'published')).join('\n')).not.toContain(other);
      // A sub-agent answers the agent that called it, not the person.
      const rc = new RequestContext();
      for (const [key, value] of [[REQUEST_KEYS.userId, 'olga'], [REQUEST_KEYS.threadId, 'sub-check'], [REQUEST_KEYS.runKind, 'chat'], [REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}']] as const) rc.set(key, value);
      const layersOf = (level: 'top' | 'sub') =>
        createPromptLayersProcessor({ db, timezone: 'Europe/Moscow', baseRules: true, workspaceRoot, level, agentId: 'sales', agentName: (id) => id, agents: () => registry.agents.map((a) => a.passport) });
      const systemOfLevel = async (level: 'top' | 'sub') =>
        JSON.stringify((await layersOf(level).processInput({ messages: [], systemMessages: [], requestContext: rc } as never)).systemMessages);
      expect(await systemOfLevel('top')).toContain(other);
      expect(await systemOfLevel('sub')).not.toContain(other);
      // The superadmin has every agent but the one it talks to.
      await db.query(`INSERT INTO app.user_roles (user_id, role_id) SELECT 'igor', id FROM app.roles WHERE builtin = 'superadmin'`);
      const admin = (await systemPromptOf('sales', 'published', undefined, `t-${Date.now()}`, 'igor')).join('\n');
      const adminLayer = admin.slice(admin.indexOf(other));
      expect(adminLayer).toContain('- «raw» — x');
      expect(adminLayer).toContain('- «Юрист»');
      expect(adminLayer).not.toContain('«sales»');
    } finally {
      await db.query(`DELETE FROM app.department_agents`);
      await db.query(`DELETE FROM app.user_roles WHERE user_id = 'igor'`);
    }
  });

  it('leaves the core rules out only when the passport says baseRules: false', async () => {
    const system = await systemPromptOf('raw', 'published');
    expect(system.join('\n')).not.toContain('# Правила ядра');
    expect(system.join('\n')).toContain('Ты агент без правил ядра.');
  });
});

// Memory of a project and of the employee (spec, section 8.26).
describe('memory in the prompt', () => {
  const ROOF = '5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
  const HOSPITAL = '6a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

  beforeAll(async () => {
    await db.query(`INSERT INTO app.projects (id, user_id, name, instructions, access) VALUES ($1, 'olga', 'Кровля школы', 'Аукцион на капремонт кровли.', 'private'), ($2, 'olga', 'Горбольница', '', 'private')`, [ROOF, HOSPITAL]);
    saveFile(contextRoot(workspaceRoot, 'olga', ROOF), 'документация.pdf', new Uint8Array(1024));
  });

  it('shows an empty memory of the project and of the employee as such', async () => {
    const all = (await systemPromptOf('sales', 'published', ROOF)).join('\n');
    expect(all).toContain('## Память проекта\nПока пусто.');
    expect(all).toContain('# Что ты помнишь о сотруднике');
    expect(all).toContain('Пока ничего.');
  });

  it('puts the memory of the project after its instructions and before its files, the personal memory last', async () => {
    await addEntry(db, { kind: 'project', projectId: ROOF }, { userId: 'olga', byAgent: false }, 'Подача до 28.11.2026 09:00');
    await addEntry(db, { kind: 'project', projectId: ROOF }, { userId: 'anna', byAgent: true }, 'НМЦК 14 862 400 ₽');
    await addEntry(db, { kind: 'project', projectId: HOSPITAL }, { userId: 'olga', byAgent: false }, 'Краска ЛК-0230 — поставка 15 дней');
    await addEntry(db, { kind: 'personal', userId: 'olga' }, { userId: 'olga', byAgent: true }, 'Ведёт только юрлиц');
    const system = await systemPromptOf('sales', 'published', ROOF);
    const all = system.join('\n');
    const at = (needle: string) => all.indexOf(needle);
    expect(at('## Память проекта')).toBeGreaterThan(at('Аукцион на капремонт кровли.'));
    expect(at('## Память проекта')).toBeLessThan(at('документация.pdf'));
    expect(all).toMatch(/- \[1\] Подача до 28\.11\.2026 09:00 — Ольга вручную, \d\d\.\d\d\.\d{4}/);
    expect(all).toMatch(/- \[2\] НМЦК 14 862 400 ₽ — Анна через агента, \d\d\.\d\d\.\d{4}/);
    expect(all).toMatch(/Занято \d+ из 6\s000 знаков\./);
    expect(all).not.toContain('Краска ЛК-0230');
    // The personal memory comes after everything else, the project's files included.
    expect(at('# Что ты помнишь о сотруднике')).toBeGreaterThan(at('документация.pdf'));
    expect(all.slice(at('# Что ты помнишь о сотруднике'))).toMatch(/- \[1\] Ведёт только юрлиц — \d\d\.\d\d\.\d{4}/);
  });

  it('gives a conversation outside projects only the personal memory, and a draft check none', async () => {
    const outside = (await systemPromptOf('sales', 'published')).join('\n');
    expect(outside).not.toContain('## Память проекта');
    expect(outside).not.toContain('Подача до 28.11.2026');
    expect(outside).toContain('Ведёт только юрлиц');
    const draft = (await systemPromptOf('sales', 'draft')).join('\n');
    expect(draft).not.toContain('# Что ты помнишь о сотруднике');
    expect(draft).not.toContain('Ведёт только юрлиц');
  });

  it('sends no working memory of Mastra: neither its instruction nor its tool', async () => {
    await systemPromptOf('sales', 'published', ROOF);
    const request = model.requests.at(-1)!;
    expect(JSON.stringify(request.messages)).not.toContain('WORKING_MEMORY_SYSTEM_INSTRUCTION');
    expect((request.tools ?? []).map((t) => t.function.name)).not.toContain('updateWorkingMemory');
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
