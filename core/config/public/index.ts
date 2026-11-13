// Helpers for the installation zone: they only give the files their types;
// validation happens at start-up in core/config/validate.ts.
import type { z } from 'zod';
import type { agentPassportSchema, appConfigSchema, modelSchema, pluginPassportSchema } from '../schemas.ts';

export type { MaskingKind } from '../schemas.ts';
export type AppConfigInput = z.input<typeof appConfigSchema>;
export type ModelConfigInput = z.input<typeof modelSchema>;
export type AgentPassportInput = z.input<typeof agentPassportSchema>;
export type PluginPassportInput = z.input<typeof pluginPassportSchema>;

export function defineAppConfig(config: AppConfigInput): AppConfigInput {
  return config;
}

export function defineModels(models: ModelConfigInput[]): ModelConfigInput[] {
  return models;
}

export function definePluginSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return settings;
}

export function defineAgent(passport: AgentPassportInput): AgentPassportInput {
  return passport;
}

export function definePlugin(passport: PluginPassportInput): PluginPassportInput {
  return passport;
}
