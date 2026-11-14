import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadInstallation } from './load.ts';

// Inside the repository, so files of the fake installation can import npm packages such as zod.
const CACHE = fileURLToPath(new URL('../../node_modules/.cache', import.meta.url));
let root: string | undefined;

function installation(files: Record<string, string>): string {
  mkdirSync(CACHE, { recursive: true });
  root = mkdtempSync(join(CACHE, 'bba-install-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const BASE = {
  'config/app.ts': `export default { name: 'Альфа-Строй', timezone: 'Europe/Moscow', masking: { initialKinds: ['passport'] }, limits: { initialOrgMonthlyRub: null, initialUserMonthlyRub: 3000, initialDailySubscriptionTokens: null } };`,
  'config/plugins.ts': `export default { notes: { folder: 'Заметки' } };`,
  'plugins/notes/plugin.ts': `import { z } from 'zod';\nexport default { name: 'notes', title: 'Заметки', settings: z.object({ folder: z.string() }), secrets: [], readOnly: ['list'] };`,
  'agents/assistant/agent.ts': `export default { id: 'assistant', name: 'Помощник', description: 'Общий помощник', plugins: ['notes'], readOnly: [], starters: [] };`,
  'agents/assistant/instructions.md': 'Ты общий помощник.',
};

describe('loadInstallation', () => {
  it('discovers agents and plugins from folders and validates them', async () => {
    const inst = await loadInstallation(installation(BASE), {});
    expect(inst.agents.map((a) => a.passport.id)).toEqual(['assistant']);
    expect(inst.agents[0]?.instructions).toBe('Ты общий помощник.');
    expect(inst.plugins.map((p) => [p.passport.name, p.settings])).toEqual([['notes', { folder: 'Заметки' }]]);
  });

  // A copy of an installation updated from stage 1 still has the file; its models would be silently ignored.
  it('stops on config/models.ts left from stage 1: models are added in «Нейросеть»', async () => {
    await expect(loadInstallation(installation({ ...BASE, 'config/models.ts': 'export default [];' }), {})).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: { problems: [{ file: 'config/models.ts', field: '(file)', message: expect.stringContaining('«Нейросеть»') }] },
    });
  });

  it('reports a missing config file and a file that cannot be loaded', async () => {
    const files: Record<string, string> = { ...BASE, 'agents/assistant/agent.ts': 'export default { id: ' };
    delete files['config/app.ts'];
    await expect(loadInstallation(installation(files), {})).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
      details: {
        problems: [
          { file: 'config/app.ts', field: '(file)', message: 'is missing' },
          { file: 'agents/assistant/agent.ts', field: '(file)', message: expect.stringContaining('cannot be loaded') },
        ],
      },
    });
  });
});
