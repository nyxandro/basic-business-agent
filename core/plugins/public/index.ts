// Public API for plugins (plugins/<name>/plugin.ts). Plugins import core only from public/ folders.
import type { Tool } from '@mastra/core/tools';
import type { z } from 'zod';
import type { Db } from '../../db/pool.ts';
import { REQUEST_KEYS } from '../../runtime/request-keys.ts';

export interface PluginContext<TSettings> {
  name: string;
  settings: TSettings;
  // Values of the environment variables listed in `secrets`, checked at start-up.
  secrets: Record<string, string>;
  // Plugins keep their own tables in schema plugin_<name>, created by plugins/<name>/migrations/*.sql.
  db: Db;
}

// Mastra tools of any shape; the loader adds approval and journaling around them.
export type AnyTool = Tool<any, any, any, any, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type PersonalCredential = { kind: 'static'; fields: Record<string, string> } | { kind: 'oauth'; accessToken: string };

// An MCP server the plugin connects to (spec, section 8.8):
// - personal + static: each employee enters their own key (staticFields), headers() turns it into HTTP headers;
// - personal + oauth: each employee signs in on the system's site, the access token goes as Bearer by default;
// - shared + identity: one connection for everyone, the core signs "who is asking" with identitySecret.
export interface McpDefinition {
  url: string;
  staticFields?: { name: string; label: string; secret: boolean }[];
  headers?: (credential: PersonalCredential) => Record<string, string>;
  oauth?: { authorizeUrl: string; tokenUrl: string; clientId: string; clientSecret: string; scopes: string[] };
  identitySecret?: string;
}

export interface PluginDefinition<S extends z.ZodType> {
  name: string;
  title: string;
  settings: S;
  secrets: string[];
  // Tool ids that only read: they run without the person's confirmation.
  readOnly: string[];
  checkTool?: string;
  connection?: { mode: 'personal' | 'shared'; auth: 'oauth' | 'static' | 'identity' };
  dependsOn?: string[];
  tools?: (ctx: PluginContext<z.infer<S>>) => Record<string, AnyTool>;
  mcp?: (ctx: PluginContext<z.infer<S>>) => McpDefinition;
}

export function definePlugin<S extends z.ZodType>(definition: PluginDefinition<S>): PluginDefinition<S> {
  return definition;
}

// The employee on whose behalf a tool runs, as set by the core entry point of the run.
export function requireUserId(context: { requestContext?: { get(key: string): unknown } | undefined } | undefined): string {
  const userId = context?.requestContext?.get(REQUEST_KEYS.userId);
  if (typeof userId !== 'string' || !userId) throw new Error('APP_TOOL_FAILED: the tool ran without an employee in the request context');
  return userId;
}

export function pluginSchemaName(pluginName: string): string {
  return `plugin_${pluginName.replace(/-/g, '_')}`;
}
