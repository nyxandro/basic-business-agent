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
