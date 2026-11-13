import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadInstallation } from '../config/load.ts';
import type { Db } from '../db/pool.ts';
import { startFakeModel, type FakeModel } from '../models/fake-openai.ts';
import { createMastraAgent } from '../runtime/agent-factory.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { buildRegistry } from './registry.ts';

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
    'config/app.ts': `export default { name: 'Альфа-Строй', timezone: 'Europe/Moscow', masking: { initialKinds: [] }, limits: { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null } };`,
    'config/models.ts': `export default [{ id: 'main', label: 'Основная', subscription: false, prices: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, reasoning: 2, image: 0.5 }, deployments: [{ id: 'd1', litellm: { model: 'openai/x' } }] }];`,
    'config/plugins.ts': `export default {};`,
    'plugins/notes/plugin.ts': `import { createTool } from '@mastra/core/tools';\nimport { z } from 'zod';\nexport default { name: 'notes', title: 'Заметки', settings: z.object({}), secrets: [], readOnly: ['notes_list'], tools: () => ({ notes_list: ${TOOL('notes_list')}, notes_add: ${TOOL('notes_add')} }) };`,
    'plugins/notes/skills/note-taking/SKILL.md': SKILL('note-taking'),
    'agents/sales/agent.ts': `export default { id: 'sales', name: 'Продажи', description: 'Отдел продаж', model: 'main', plugins: ['notes'], readOnly: [], starters: [] };`,
    'agents/sales/instructions.md': 'Ты агент отдела продаж.',
    'agents/sales/tools/report.ts': `import { createTool } from '@mastra/core/tools';\nimport { z } from 'zod';\nexport default ${TOOL('sales_report')};`,
    'agents/sales/skills/sales-playbook/SKILL.md': SKILL('sales-playbook'),
    'agents/sales/subagents/researcher/agent.ts': `export default { id: 'researcher', name: 'Исследователь', description: 'Ищет сведения о клиенте', model: 'main', plugins: [], readOnly: [], starters: [] };`,
    'agents/sales/subagents/researcher/instructions.md': 'Ты ищешь сведения о клиенте.',
    'agents/helper/agent.ts': `export default { id: 'helper', name: 'Помощник', description: 'Общий помощник', model: 'main', plugins: [], readOnly: [], starters: [] };`,
    'agents/helper/instructions.md': 'Ты общий помощник.',
    'core-skills/read-documents/SKILL.md': SKILL('read-documents'),
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
  return buildRegistry({ root: dir, installation: inst, env: {}, db: {} as Db, coreSkillsDir: join(dir, 'core-skills') });
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
  });

  it('lets the agent passport mark its own tool as read-only', async () => {
    const reg = await registryOf(
      installation({
        'agents/sales/agent.ts': `export default { id: 'sales', name: 'Продажи', description: 'Отдел продаж', model: 'main', plugins: ['notes'], readOnly: ['sales_report'], starters: [] };`,
      }),
    );
    expect(reg.get('sales')!.tools.sales_report!.requireApproval).toBe(false);
  });

  it('collects core, plugin and agent skills, and sub-agents from the agent folder', async () => {
    const dir = installation();
    const sales = (await registryOf(dir)).get('sales')!;
    expect(sales.skillDirs).toEqual([join(dir, 'core-skills'), join(dir, 'plugins/notes/skills'), join(dir, 'agents/sales/skills')]);
    expect(sales.subagents.map((s) => s.passport.id)).toEqual(['researcher']);
  });

  it('reports read-only entries that name no tool', async () => {
    const dir = installation({
      'agents/sales/agent.ts': `export default { id: 'sales', name: 'Продажи', description: 'Отдел продаж', model: 'main', plugins: ['notes'], readOnly: ['ghost'], starters: [] };`,
    });
    await expect(registryOf(dir)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: { problems: [{ file: 'agents/sales/agent.ts', field: 'readOnly', message: 'the agent has no tool "ghost"' }] },
    });
  });

  it('builds a Mastra agent that offers those tools and skills to the model', async () => {
    const reg = await registryOf(installation());
    const gateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
    const agent = createMastraAgent(reg.get('sales')!, { gateway, processorsFor: () => ({ input: [], output: [] }) });
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, 'u1');
    model.script({ text: 'Привет!' });
    await agent.generate('привет', { requestContext: rc, maxSteps: 1 });
    const req = model.requests.at(-1)!;
    const tools = (req.tools ?? []).map((t) => t.function.name);
    expect(tools).toEqual(expect.arrayContaining(['notes_list', 'notes_add', 'sales_report', 'skill', 'skill_read', 'skill_search']));
    expect(tools.some((t) => t.includes('researcher'))).toBe(true);
    const system = JSON.stringify(req.messages.filter((m) => m.role === 'system'));
    for (const skill of ['note-taking', 'sales-playbook', 'read-documents']) expect(system).toContain(skill);
    expect(system).toContain('Ты агент отдела продаж.');
  });
});
