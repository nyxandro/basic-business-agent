// Helpers for the installation zone: they only give the files their types;
// validation happens at start-up in core/config/validate.ts.
import type { z } from 'zod';
import type { agentPassportSchema, appConfigSchema } from '../schemas.ts';

export type { MaskingKind } from '../schemas.ts';
export type AppConfigInput = z.input<typeof appConfigSchema>;
export type AgentPassportInput = z.input<typeof agentPassportSchema>;

export function defineAppConfig(config: AppConfigInput): AppConfigInput {
  return config;
}

export function definePluginSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return settings;
}

export function defineAgent(passport: AgentPassportInput): AgentPassportInput {
  return passport;
}

// Plugins use definePlugin from core/plugins/public/index.ts.
