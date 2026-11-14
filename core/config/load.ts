// Reads the installation zone from disk: config/*.ts, agents/*/ and plugins/*/, then validates it.
// Files are loaded by computed paths, so core/ has no static imports of the installation zone.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configError, validateInstallation, type ConfigProblem, type Installation, type InstallationSources } from './validate.ts';

function listDirs(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

export async function loadInstallation(root: string, env: Record<string, string | undefined>): Promise<Installation> {
  const problems: ConfigProblem[] = [];

  const importDefault = async (rel: string): Promise<unknown> => {
    const full = join(root, rel);
    if (!existsSync(full)) {
      problems.push({ file: rel, field: '(file)', message: 'is missing' });
      return undefined;
    }
    try {
      const mod = (await import(pathToFileURL(full).href)) as { default?: unknown };
      if (mod.default === undefined) problems.push({ file: rel, field: '(file)', message: 'has no default export' });
      return mod.default;
    } catch (error) {
      problems.push({ file: rel, field: '(file)', message: `cannot be loaded: ${error instanceof Error ? error.message : String(error)}` });
      return undefined;
    }
  };

  const app = await importDefault('config/app.ts');
  // Stage 1 kept models in this file; a copy updated since would silently lose them.
  if (existsSync(join(root, 'config/models.ts'))) {
    problems.push({ file: 'config/models.ts', field: '(file)', message: 'is no longer read: models and keys are added in «Нейросеть» of the admin panel; add them there and delete the file' });
  }
  const pluginSettings = await importDefault('config/plugins.ts');

  const agents: InstallationSources['agents'] = [];
  for (const dir of listDirs(root, 'agents')) {
    const passport = await importDefault(`agents/${dir}/agent.ts`);
    const instructionsPath = join(root, 'agents', dir, 'instructions.md');
    agents.push({ dir, passport, instructions: existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf8') : null });
  }

  const plugins: InstallationSources['plugins'] = [];
  for (const dir of listDirs(root, 'plugins')) {
    plugins.push({ dir, passport: await importDefault(`plugins/${dir}/plugin.ts`) });
  }

  if (problems.length > 0) throw configError(problems);
  return validateInstallation({ app, pluginSettings, agents, plugins, env });
}
