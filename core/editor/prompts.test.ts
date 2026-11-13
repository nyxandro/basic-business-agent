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
import { createMastraRuntime } from '../runtime/mastra.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { getPromptState, publishDraft, resolveAgent, revertToFile, saveDraft, type EditorDeps } from './prompts.ts';

let database: TestDatabase;
let db: Db;
let model: FakeModel;
let mastra: Mastra;
let deps: EditorDeps;

function runtime(passport: Partial<AgentPassport> & { id: string }, instructions: string): AgentRuntime {
  return {
    passport: { name: passport.id, description: 'x', model: 'main', plugins: [], readOnly: [], starters: [], ...passport },
    dir: `/agents/${passport.id}`,
    instructions,
    tools: {},
    readOnly: new Set(),
    skillDirs: [],
    subagents: [],
  };
}

const sales = runtime({ id: 'sales' }, 'Ты агент отдела продаж.');
const raw = runtime({ id: 'raw', baseRules: false }, 'Ты агент без правил ядра.');
const registry: Registry = {
  agents: [sales, raw],
  get: (id) => [sales, raw].find((a) => a.passport.id === id),
  ids: () => new Set(['sales', 'raw']),
  pluginMigrations: [],
};

async function systemPromptOf(agentId: string, mode: 'published' | 'draft'): Promise<string[]> {
  const { agent } = await resolveAgent(deps, agentId, mode);
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, 'olga');
  rc.set(REQUEST_KEYS.threadId, `t-${Date.now()}`);
  model.script({ text: 'Ок.' });
  await agent.generate('привет', { requestContext: rc, maxSteps: 1 });
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
  mastra = createMastraRuntime({ registry, storage, gateway, db, app: { name: 'Альфа-Строй', timezone: 'Europe/Moscow' } });
  deps = { db, mastra, registry };
});
afterAll(async () => {
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
