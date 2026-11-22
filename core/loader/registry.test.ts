import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadInstallation } from '../config/load.ts';
import type { Db } from '../db/pool.ts';
import { startFakeModel, type FakeModel } from '../models/fake-openai.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS, MODEL_CALL_MAX_MS } from '../runtime/agent-factory.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { buildRegistry } from './registry.ts';
import { createChainService } from '../approvals/chains.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';

const CACHE = fileURLToPath(new URL('../../node_modules/.cache', import.meta.url));
let root: string | undefined;
let model: FakeModel;

beforeAll(async () => {
  model = await startFakeModel();
});
afterAll(async () => {
  await model.close();
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const TOOL = (id: string) => `createTool({ id: '${id}', description: '${id}', inputSchema: z.object({}), execute: async () => ({ ok: true }) })`;
const SKILL = (name: string) => `---\nname: ${name}\ndescription: Скилл ${name}\n---\n\nМетодика ${name}.\n`;

function installation(overrides: Record<string, string> = {}): string {
  mkdirSync(CACHE, { recursive: true });
  root = mkdtempSync(join(CACHE, 'bba-registry-'));
  const files: Record<string, string> = {
    'config/app.ts': `export default { name: 'Альфа-Строй', timezone: 'Europe/Moscow', masking: { initialKinds: [] }, limits: { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null }, approvals: { initialChatTtlHours: 24, initialBackgroundTtlHours: 72 } };`,
    'config/plugins.ts': `export default {};`,
    'plugins/notes/plugin.ts': `import { createTool } from '@mastra/core/tools';\nimport { z } from 'zod';\nexport default { name: 'notes', title: 'Заметки', settings: z.object({}), secrets: [], readOnly: ['notes_list'], tools: () => ({ notes_list: ${TOOL('notes_list')}, notes_add: ${TOOL('notes_add')} }) };`,
    'agents/sales/agent.ts': `export default { id: 'sales', name: 'Продажи', description: 'Отдел продаж', plugins: ['notes'], readOnly: [], starters: [] };`,
    'agents/sales/instructions.md': 'Ты агент отдела продаж.',
    'agents/sales/tools/report.ts': `import { createTool } from '@mastra/core/tools';\nimport { z } from 'zod';\nexport default ${TOOL('sales_report')};`,
    'agents/sales/subagents/researcher/agent.ts': `export default { id: 'researcher', name: 'Исследователь', description: 'Ищет сведения о клиенте', plugins: [], readOnly: [], starters: [] };`,
    'agents/sales/subagents/researcher/instructions.md': 'Ты ищешь сведения о клиенте.',
    'agents/helper/agent.ts': `export default { id: 'helper', name: 'Помощник', description: 'Общий помощник', plugins: [], readOnly: [], starters: [] };`,
    'agents/helper/instructions.md': 'Ты общий помощник.',
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

async function registryOf(dir: string) {
  const inst = await loadInstallation(dir, {});
  return buildRegistry({ root: dir, installation: inst, env: {}, db: {} as Db, chains: createChainService({ db: {} as Db, box: createSecretBox(TEST_ENCRYPTION_KEYS) }) });
}

describe('buildRegistry', () => {
  it('gives an agent the tools of its plugins and its own, with confirmation for everything not read-only', async () => {
    const reg = await registryOf(installation());
    const sales = reg.get('sales')!;
    expect(Object.keys(sales.tools).sort()).toEqual(['notes_add', 'notes_list', 'sales_report']);
    expect(sales.tools.notes_list!.requireApproval).toBe(false);
    expect(sales.tools.notes_add!.requireApproval).toBe(true);
    expect(sales.tools.sales_report!.requireApproval).toBe(true);
    expect(Object.keys(reg.get('helper')!.tools)).toEqual([]);
    // The chat names the system a tool works in: «Ищу в Заметки…».
    expect(sales.toolSystems).toEqual({ notes_list: 'Заметки', notes_add: 'Заметки' });
  });

  it('refuses a tool with the name of an interface block of the core', async () => {
    const dir = installation({ 'agents/sales/tools/report.ts': `import { createTool } from '@mastra/core/tools';\nimport { z } from 'zod';\nexport default ${TOOL('show_table')};` });
    await expect(registryOf(dir)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: { problems: [{ file: 'agents/sales/agent.ts', field: 'plugins', message: 'tool "show_table" has the name of an interface block of the core' }] },
    });
  });

  it('refuses a tool with the name of a tool of the core’s internet (spec, section 8.30)', async () => {
    const dir = installation({ 'agents/sales/tools/report.ts': `import { createTool } from '@mastra/core/tools';\nimport { z } from 'zod';\nexport default ${TOOL('web_research')};` });
    await expect(registryOf(dir)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: { problems: [{ file: 'agents/sales/agent.ts', field: 'plugins', message: 'tool "web_research" has the name of a tool of the core’s internet' }] },
    });
  });

  it('lets the agent passport mark its own tool as read-only', async () => {
    const reg = await registryOf(
      installation({
        'agents/sales/agent.ts': `export default { id: 'sales', name: 'Продажи', description: 'Отдел продаж', plugins: ['notes'], readOnly: ['sales_report'], starters: [] };`,
      }),
    );
    expect(reg.get('sales')!.tools.sales_report!.requireApproval).toBe(false);
  });

  it('collects sub-agents from the agent folder', async () => {
    const sales = (await registryOf(installation())).get('sales')!;
    expect(sales.subagents.map((s) => s.passport.id)).toEqual(['researcher']);
  });

  // Stage 1 read skills from these folders; skills are uploaded in «Скиллы» now (spec, 8.15).
  it('stops on a skills folder left in a plugin or an agent', async () => {
    const dir = installation({ 'plugins/notes/skills/note-taking/SKILL.md': SKILL('note-taking'), 'agents/sales/skills/sales-playbook/SKILL.md': SKILL('sales-playbook') });
    await expect(registryOf(dir)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: {
        problems: [
          { file: 'plugins/notes/skills/', field: '(folder)', message: expect.stringContaining('«Скиллы»') },
          { file: 'agents/sales/skills/', field: '(folder)', message: expect.stringContaining('pnpm skills:pack') },
        ],
      },
    });
  });

  it('reports read-only entries that name no tool', async () => {
    const dir = installation({
      'agents/sales/agent.ts': `export default { id: 'sales', name: 'Продажи', description: 'Отдел продаж', plugins: ['notes'], readOnly: ['ghost'], starters: [] };`,
    });
    await expect(registryOf(dir)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: { problems: [{ file: 'agents/sales/agent.ts', field: 'readOnly', message: 'the agent has no tool "ghost"' }] },
    });
  });

  it('builds a Mastra agent that offers those tools and the skills of the run to the model', async () => {
    const dir = installation();
    const reg = await registryOf(dir);
    const gateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
    const agent = createMastraAgent(reg.get('sales')!, { gateway, firstChunkMs: FALLBACK_FIRST_CHUNK_MS, stepMs: MODEL_CALL_MAX_MS, processorsFor: () => ({ input: [], output: [] }) });
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, 'u1');
    rc.set(REQUEST_KEYS.modelId, 'test-paid');
    const skill = join(dir, 'uploaded/note-taking');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), SKILL('note-taking'));
    rc.set(REQUEST_KEYS.skillPaths, JSON.stringify([skill]));
    rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true,"widgets":true}');
    model.script({ text: 'Привет!' });
    await agent.generate('привет', { requestContext: rc, maxSteps: 1 });
    const req = model.requests.at(-1)!;
    const tools = (req.tools ?? []).map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(['notes_list', 'notes_add', 'sales_report', 'skill', 'skill_read', 'skill_search']));
    expect(tools.some((t) => t.includes('researcher'))).toBe(true);
    const system = JSON.stringify(req.messages.filter((m) => m.role === 'system'));
    expect(system).toContain('note-taking');
    expect(system).toContain('Ты агент отдела продаж.');
  });
});
