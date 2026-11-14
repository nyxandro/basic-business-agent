// Validates the whole installation at start-up and reports every problem at once,
// each as "<file>: <field>: <what is wrong>" (spec, scenario 1 and section 9: APP_CONFIG_INVALID).
import type { z } from 'zod';
import { AppError } from '../errors/app-error.ts';
import { agentPassportSchema, appConfigSchema, pluginPassportSchema, type AgentPassport, type AppConfig, type PluginPassport } from './schemas.ts';

export interface ConfigProblem {
  file: string;
  field: string;
  message: string;
}

export interface InstallationSources {
  app: unknown;
  pluginSettings: unknown;
  agents: { dir: string; passport: unknown; instructions: string | null }[];
  plugins: { dir: string; passport: unknown }[];
  env: Record<string, string | undefined>;
}

export interface LoadedAgent {
  dir: string;
  passport: AgentPassport;
  instructions: string;
}

export interface LoadedPlugin {
  dir: string;
  passport: PluginPassport;
  settings: unknown;
}

export interface Installation {
  app: AppConfig;
  agents: LoadedAgent[];
  plugins: LoadedPlugin[];
}

export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, key) => {
    if (typeof key === 'number') return `${acc}[${key}]`;
    return acc === '' ? String(key) : `${acc}.${String(key)}`;
  }, '');
}

function issuesToProblems(file: string, error: z.ZodError, prefix = ''): ConfigProblem[] {
  return error.issues.map((issue) => {
    const path = formatPath(issue.path);
    return { file, field: prefix && path ? `${prefix}.${path}` : prefix || path || '(file)', message: issue.message };
  });
}

export function configError(problems: ConfigProblem[]): AppError {
  const lines = problems.map((p) => `  ${p.file}: ${p.field}: ${p.message}`).join('\n');
  return new AppError({
    code: 'APP_CONFIG_INVALID',
    message: `invalid installation configuration:\n${lines}`,
    userMessage: 'Приложение не запущено: в настройках установки ошибка.',
    nextStep: 'Исправьте файлы и поля, перечисленные в журнале запуска, и запустите приложение снова.',
    details: { problems },
  });
}

function duplicates(values: string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

export function validateInstallation(src: InstallationSources): Installation {
  const problems: ConfigProblem[] = [];

  const app = appConfigSchema.safeParse(src.app);
  if (!app.success) problems.push(...issuesToProblems('config/app.ts', app.error));

  const plugins: LoadedPlugin[] = [];
  const settingsSource = src.pluginSettings;
  if (typeof settingsSource !== 'object' || settingsSource === null || Array.isArray(settingsSource)) {
    problems.push({ file: 'config/plugins.ts', field: '(file)', message: 'must export an object: { <plugin name>: settings }' });
  }
  const allSettings = (typeof settingsSource === 'object' && settingsSource !== null ? settingsSource : {}) as Record<string, unknown>;

  for (const { dir, passport } of src.plugins) {
    const file = `plugins/${dir}/plugin.ts`;
    const parsed = pluginPassportSchema.safeParse(passport);
    if (!parsed.success) {
      problems.push(...issuesToProblems(file, parsed.error));
      continue;
    }
    if (parsed.data.name !== dir) {
      problems.push({ file, field: 'name', message: `must match the folder name "${dir}"` });
    }
    for (const secret of parsed.data.secrets) {
      if (!src.env[secret]) problems.push({ file: '.env', field: secret, message: `is required by plugin "${parsed.data.name}"` });
    }
    // A missing section means "no settings given"; the plugin's schema decides whether that is enough.
    const settings = parsed.data.settings.safeParse(allSettings[parsed.data.name] ?? {});
    if (!settings.success) {
      problems.push(...issuesToProblems('config/plugins.ts', settings.error, parsed.data.name));
      continue;
    }
    plugins.push({ dir, passport: parsed.data, settings: settings.data });
  }
  const pluginNames = new Set(src.plugins.map((p) => p.dir));
  for (const plugin of plugins) {
    for (const dep of plugin.passport.dependsOn ?? []) {
      if (!pluginNames.has(dep)) problems.push({ file: `plugins/${plugin.dir}/plugin.ts`, field: 'dependsOn', message: `plugin "${dep}" is not in plugins/` });
    }
  }
  for (const key of Object.keys(allSettings)) {
    if (!pluginNames.has(key)) problems.push({ file: 'config/plugins.ts', field: key, message: 'there is no such plugin in plugins/' });
  }

  const agents: LoadedAgent[] = [];
  for (const { dir, passport, instructions } of src.agents) {
    const file = `agents/${dir}/agent.ts`;
    const parsed = agentPassportSchema.safeParse(passport);
    if (!parsed.success) {
      problems.push(...issuesToProblems(file, parsed.error));
      continue;
    }
    const agent = parsed.data;
    for (const p of agent.plugins) {
      if (!pluginNames.has(p)) problems.push({ file, field: 'plugins', message: `plugin "${p}" is not in plugins/` });
    }
    if (!instructions || instructions.trim() === '') {
      problems.push({ file: `agents/${dir}/instructions.md`, field: '(file)', message: 'is missing or empty' });
      continue;
    }
    agents.push({ dir, passport: agent, instructions });
  }
  for (const id of duplicates(agents.map((a) => a.passport.id))) {
    problems.push({ file: 'agents/', field: 'id', message: `agent id "${id}" is used by more than one folder` });
  }

  if (problems.length > 0 || !app.success) throw configError(problems);
  return { app: app.data, agents, plugins };
}
