// Our loader (spec, section 15): turns the validated installation into agent runtimes —
// tools of the agent's plugins and of the agent itself, skill folders, sub-agents.
// Every tool that is not listed as read-only requires the person's confirmation (spec, 8.4).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentPassportSchema, type AgentPassport, type ModelConfig } from '../config/schemas.ts';
import { configError, formatPath, type ConfigProblem, type Installation } from '../config/validate.ts';
import type { MigrationSource } from '../db/migrate.ts';
import type { Db } from '../db/pool.ts';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import type { AnyTool, PluginContext } from '../plugins/public/index.ts';

export interface AgentRuntime {
  passport: AgentPassport;
  dir: string;
  instructions: string;
  tools: Record<string, AnyTool>;
  readOnly: ReadonlySet<string>;
  skillDirs: string[];
  subagents: AgentRuntime[];
}

export interface Registry {
  agents: AgentRuntime[];
  get(id: string): AgentRuntime | undefined;
  ids(): ReadonlySet<string>;
  pluginMigrations: MigrationSource[];
}

export interface RegistryDeps {
  root: string;
  installation: Installation;
  env: Record<string, string | undefined>;
  db: Db;
  coreSkillsDir: string;
}

function dirIfExists(path: string): string[] {
  return existsSync(path) ? [path] : [];
}

function isTool(value: unknown): value is AnyTool {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string' && 'execute' in value;
}

async function loadAgentTools(dir: string, file: string, problems: ConfigProblem[]): Promise<Record<string, AnyTool>> {
  const toolsDir = join(dir, 'tools');
  const out: Record<string, AnyTool> = {};
  if (!existsSync(toolsDir)) return out;
  for (const name of readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort()) {
    const mod = (await import(pathToFileURL(join(toolsDir, name)).href)) as { default?: unknown };
    const exported = mod.default;
    const tools = isTool(exported) ? [exported] : exported && typeof exported === 'object' ? Object.values(exported) : [];
    if (tools.length === 0 || !tools.every(isTool)) {
      problems.push({ file: `${file}/tools/${name}`, field: '(file)', message: 'must default-export a Mastra tool or an object of tools' });
      continue;
    }
    for (const tool of tools) out[String(tool.id)] = tool;
  }
  return out;
}

export async function buildRegistry(deps: RegistryDeps): Promise<Registry> {
  const { root, installation, env, db } = deps;
  const problems: ConfigProblem[] = [];
  const modelIds = new Set(installation.models.map((m: ModelConfig) => m.id));

  const pluginTools = new Map<string, Record<string, AnyTool>>();
  const pluginReadOnly = new Map<string, string[]>();
  const pluginSkills = new Map<string, string[]>();
  const pluginMigrations: MigrationSource[] = [];
  for (const plugin of installation.plugins) {
    const { passport } = plugin;
    const pluginDir = join(root, 'plugins', plugin.dir);
    const secrets = Object.fromEntries(passport.secrets.map((s) => [s, env[s] ?? '']));
    const ctx: PluginContext<unknown> = { name: passport.name, settings: plugin.settings, secrets, db };
    const tools = (passport.tools as ((c: PluginContext<unknown>) => Record<string, AnyTool>) | undefined)?.(ctx) ?? {};
    for (const id of passport.readOnly) {
      if (!tools[id]) problems.push({ file: `plugins/${plugin.dir}/plugin.ts`, field: 'readOnly', message: `there is no tool "${id}"` });
    }
    pluginTools.set(passport.name, tools);
    pluginReadOnly.set(passport.name, passport.readOnly);
    pluginSkills.set(passport.name, dirIfExists(join(pluginDir, 'skills')));
    if (existsSync(join(pluginDir, 'migrations'))) pluginMigrations.push({ prefix: `plugin:${passport.name}`, dir: join(pluginDir, 'migrations') });
  }

  async function buildAgent(passport: AgentPassport, dir: string, file: string, instructions: string): Promise<AgentRuntime> {
    const tools: Record<string, AnyTool> = {};
    const readOnly = new Set<string>(passport.readOnly);
    for (const name of passport.plugins) {
      for (const [id, tool] of Object.entries(pluginTools.get(name) ?? {})) {
        if (tools[id]) problems.push({ file, field: 'plugins', message: `tool "${id}" comes from two plugins` });
        tools[id] = tool;
      }
      for (const id of pluginReadOnly.get(name) ?? []) readOnly.add(id);
    }
    Object.assign(tools, await loadAgentTools(dir, file, problems));
    for (const id of passport.readOnly) {
      if (!tools[id]) problems.push({ file, field: 'readOnly', message: `the agent has no tool "${id}"` });
    }
    const wrapped = Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, applyApprovalPolicy(tool, { readOnly: readOnly.has(id), db })]));
    const skillDirs = [
      ...dirIfExists(deps.coreSkillsDir),
      ...passport.plugins.flatMap((p) => pluginSkills.get(p) ?? []),
      ...dirIfExists(join(dir, 'skills')),
    ];
    return { passport, dir, instructions, tools: wrapped, readOnly, skillDirs, subagents: await loadSubagents(dir, file) };
  }

  async function loadSubagents(agentDir: string, agentFile: string): Promise<AgentRuntime[]> {
    const subDir = join(agentDir, 'subagents');
    if (!existsSync(subDir)) return [];
    const out: AgentRuntime[] = [];
    for (const name of readdirSync(subDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const dir = join(subDir, name);
      const file = `${agentFile.replace(/\/agent\.ts$/, '')}/subagents/${name}/agent.ts`;
      const mod = (await import(pathToFileURL(join(dir, 'agent.ts')).href)) as { default?: unknown };
      const parsed = agentPassportSchema.safeParse(mod.default);
      if (!parsed.success) {
        problems.push(...parsed.error.issues.map((i) => ({ file, field: formatPath(i.path) || '(file)', message: i.message })));
        continue;
      }
      if (!modelIds.has(parsed.data.model)) problems.push({ file, field: 'model', message: `"${parsed.data.model}" is not in config/models.ts` });
      const instructionsPath = join(dir, 'instructions.md');
      const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf8') : '';
      if (!instructions.trim()) problems.push({ file: file.replace(/agent\.ts$/, 'instructions.md'), field: '(file)', message: 'is missing or empty' });
      out.push(await buildAgent(parsed.data, dir, file, instructions));
    }
    return out;
  }

  const agents: AgentRuntime[] = [];
  for (const agent of installation.agents) {
    const file = `agents/${agent.dir}/agent.ts`;
    agents.push(await buildAgent(agent.passport, join(root, 'agents', agent.dir), file, agent.instructions));
  }
  if (problems.length > 0) throw configError(problems);

  const byId = new Map(agents.map((a) => [a.passport.id, a]));
  return { agents, get: (id) => byId.get(id), ids: () => new Set(byId.keys()), pluginMigrations };
}
