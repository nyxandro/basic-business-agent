// Our loader (spec, section 15): turns the validated installation into agent runtimes —
// tools of the agent's plugins and of the agent itself, sub-agents. Skills are not in folders of
// the installation: the admin uploads them in «Скиллы» (core/skills-admin).
// Every tool that is not listed as read-only requires the person's confirmation (spec, 8.4).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GENUI_TOOL_IDS, WEB_RESEARCH_TOOL, WIDGET_TOOL_IDS } from '@bba/contracts';
import { agentPassportSchema, type AgentPassport } from '../config/schemas.ts';
import { configError, formatPath, type ConfigProblem, type Installation } from '../config/validate.ts';
import type { MigrationSource } from '../db/migrate.ts';
import type { Db } from '../db/pool.ts';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import type { ConnectorRuntime } from '../connections/manager.ts';
import type { AnyTool, McpDefinition, PluginContext, PluginTrigger } from '../plugins/public/index.ts';

// Names of the core's tools of the internet (core/web): no plugin or agent tool may take them.
const WEB_TOOL_IDS: readonly string[] = [WEB_RESEARCH_TOOL, 'web_search', 'web_fetch'];

export interface AgentRuntime {
  passport: AgentPassport;
  dir: string;
  instructions: string;
  tools: Record<string, AnyTool>;
  readOnly: ReadonlySet<string>;
  subagents: AgentRuntime[];
  // Plugins of this agent that work through an MCP server: their tools are built per employee.
  connectorIds: string[];
  // Title of the system each plugin tool works in, for the chat line «Ищу в …».
  toolSystems: Record<string, string>;
}

export interface Registry {
  agents: AgentRuntime[];
  get(id: string): AgentRuntime | undefined;
  ids(): ReadonlySet<string>;
  pluginMigrations: MigrationSource[];
  connectors: ConnectorRuntime[];
  triggers: { plugin: string; trigger: PluginTrigger }[];
}

// Agent runs started by plugins: bound after the background service exists (it needs the registry).
export interface AgentRunner {
  startAgentRun: PluginContext<unknown>['startAgentRun'];
}

function connectorProblems(file: string, connection: ConnectorRuntime['mode'] | undefined, auth: string | undefined, def: McpDefinition): string[] {
  const problems: string[] = [];
  if (!connection || !auth) return ['a plugin with mcp must declare connection: { mode, auth }'];
  if (!def.url) problems.push('mcp().url is empty');
  if (connection === 'personal' && auth === 'static' && (!def.staticFields?.length || !def.headers)) problems.push('personal static access needs mcp().staticFields and mcp().headers');
  if (connection === 'personal' && auth === 'oauth' && !def.oauth) problems.push('personal oauth access needs mcp().oauth');
  if (connection === 'shared' && auth !== 'identity') problems.push('a shared connection uses auth: identity');
  if (connection === 'shared' && !def.identitySecret) problems.push('a shared connection needs mcp().identitySecret');
  if (connection === 'personal' && auth === 'identity') problems.push('identity auth is for a shared connection');
  return problems.map((p) => `${file}: ${p}`);
}

export interface RegistryDeps {
  root: string;
  installation: Installation;
  env: Record<string, string | undefined>;
  db: Db;
  runner?: AgentRunner;
}

// Stage 1 read skills from these folders; a copy updated since would silently lose them.
function leftoverSkills(dir: string, file: string): ConfigProblem[] {
  return existsSync(join(dir, 'skills'))
    ? [{ file: `${file.replace(/[^/]+$/, '')}skills/`, field: '(folder)', message: 'is no longer read: pack each skill with `pnpm skills:pack <folder>`, upload it in «Скиллы» of the admin panel and delete the folder' }]
    : [];
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

  const pluginTools = new Map<string, Record<string, AnyTool>>();
  const pluginTitles = new Map<string, string>();
  const pluginReadOnly = new Map<string, string[]>();
  const pluginMigrations: MigrationSource[] = [];
  const connectors: ConnectorRuntime[] = [];
  const triggers: Registry['triggers'] = [];
  const startAgentRun: PluginContext<unknown>['startAgentRun'] = (input) => {
    if (!deps.runner) throw new Error('startAgentRun called before the background service started');
    return deps.runner.startAgentRun(input);
  };
  for (const plugin of installation.plugins) {
    const { passport } = plugin;
    const pluginDir = join(root, 'plugins', plugin.dir);
    const secrets = Object.fromEntries(passport.secrets.map((s) => [s, env[s] ?? '']));
    const ctx: PluginContext<unknown> = { name: passport.name, settings: plugin.settings, secrets, db, startAgentRun };
    const tools = (passport.tools as ((c: PluginContext<unknown>) => Record<string, AnyTool>) | undefined)?.(ctx) ?? {};
    const mcp = (passport.mcp as ((c: PluginContext<unknown>) => McpDefinition) | undefined)?.(ctx);
    if (mcp) {
      for (const message of connectorProblems(`plugins/${plugin.dir}/plugin.ts`, passport.connection?.mode, passport.connection?.auth, mcp)) {
        problems.push({ file: `plugins/${plugin.dir}/plugin.ts`, field: 'mcp', message: message.split(': ').slice(1).join(': ') });
      }
      connectors.push({
        id: passport.name,
        title: passport.title,
        mode: passport.connection?.mode ?? 'personal',
        auth: passport.connection?.auth ?? 'static',
        definition: mcp,
        readOnly: new Set(passport.readOnly),
        ...(passport.checkTool ? { checkTool: passport.checkTool } : {}),
      });
    }
    // With an MCP server the tools come from the server, so readOnly names cannot be checked here.
    for (const id of mcp ? [] : passport.readOnly) {
      if (!tools[id]) problems.push({ file: `plugins/${plugin.dir}/plugin.ts`, field: 'readOnly', message: `there is no tool "${id}"` });
    }
    for (const trigger of (passport.triggers as ((c: PluginContext<unknown>) => PluginTrigger[]) | undefined)?.(ctx) ?? []) triggers.push({ plugin: passport.name, trigger });
    pluginTools.set(passport.name, tools);
    pluginTitles.set(passport.name, passport.title);
    pluginReadOnly.set(passport.name, passport.readOnly);
    problems.push(...leftoverSkills(pluginDir, `plugins/${plugin.dir}/plugin.ts`));
    if (existsSync(join(pluginDir, 'migrations'))) pluginMigrations.push({ prefix: `plugin:${passport.name}`, dir: join(pluginDir, 'migrations') });
  }

  async function buildAgent(passport: AgentPassport, dir: string, file: string, instructions: string): Promise<AgentRuntime> {
    const tools: Record<string, AnyTool> = {};
    const toolSystems: Record<string, string> = {};
    const readOnly = new Set<string>(passport.readOnly);
    for (const name of passport.plugins) {
      const isConnector = connectors.some((c) => c.id === name);
      for (const [id, tool] of Object.entries(pluginTools.get(name) ?? {})) {
        if (tools[id]) problems.push({ file, field: 'plugins', message: `tool "${id}" comes from two plugins` });
        tools[id] = tool;
        toolSystems[id] = pluginTitles.get(name)!;
      }
      if (!isConnector) for (const id of pluginReadOnly.get(name) ?? []) readOnly.add(id);
    }
    Object.assign(tools, await loadAgentTools(dir, file, problems));
    for (const id of Object.keys(tools)) {
      if (GENUI_TOOL_IDS.includes(id) || WIDGET_TOOL_IDS.includes(id)) problems.push({ file, field: 'plugins', message: `tool "${id}" has the name of an interface block of the core` });
      // The internet of the core (spec, section 8.30): a plugin's tool of that name would shadow it.
      if (WEB_TOOL_IDS.includes(id)) problems.push({ file, field: 'plugins', message: `tool "${id}" has the name of a tool of the core’s internet` });
    }
    for (const id of passport.readOnly) {
      if (!tools[id]) problems.push({ file, field: 'readOnly', message: `the agent has no tool "${id}"` });
    }
    const wrapped = Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, applyApprovalPolicy(tool, { readOnly: readOnly.has(id), db })]));
    problems.push(...leftoverSkills(dir, file));
    const connectorIds = passport.plugins.filter((p) => connectors.some((c) => c.id === p));
    return { passport, dir, instructions, tools: wrapped, readOnly, subagents: await loadSubagents(dir, file), connectorIds, toolSystems };
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
  return { agents, get: (id) => byId.get(id), ids: () => new Set(byId.keys()), pluginMigrations, connectors, triggers };
}
