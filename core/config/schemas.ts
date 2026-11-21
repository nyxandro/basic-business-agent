// Declarative configuration of an installation (spec, sections 17.2–17.3):
// config/app.ts, config/plugins.ts, agents/<id>/agent.ts, plugins/<name>/plugin.ts. Models are
// not configured in files: the admin adds them in «Нейросеть» (core/models/catalog.ts).
import { APPROVAL_TTL_HOURS_MAX, APPROVAL_TTL_HOURS_MIN } from '@bba/contracts';
import { z } from 'zod';

export const MASKING_KINDS = ['passport', 'snils', 'card', 'inn', 'phone', 'email'] as const;
export type MaskingKind = (typeof MASKING_KINDS)[number];

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const rub = z.number().min(0);
const optionalRub = rub.nullable();
const tokens = z.number().int().positive().nullable();
const ttlHours = z.number().int().min(APPROVAL_TTL_HOURS_MIN).max(APPROVAL_TTL_HOURS_MAX);

export const appConfigSchema = z.strictObject({
  name: z.string().min(1),
  timezone: z.string().refine(isTimeZone, 'is not an IANA time zone such as Europe/Moscow'),
  masking: z.strictObject({
    initialKinds: z.array(z.enum(MASKING_KINDS)),
  }),
  limits: z.strictObject({
    initialOrgMonthlyRub: optionalRub,
    initialUserMonthlyRub: optionalRub,
    initialDailySubscriptionTokens: tokens,
  }),
  // How long a question «Да» waits before it burns, in hours (docs/specs/[20.11.2026]-notifications.md, F4): a
  // question of a conversation and one of a background task. Admins change them in «Режимы работы».
  approvals: z.strictObject({
    initialChatTtlHours: ttlHours,
    initialBackgroundTtlHours: ttlHours,
  }),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export const agentPassportSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'use 2–41 lowercase letters, digits and dashes, starting with a letter'),
  name: z.string().min(1),
  description: z.string().min(1),
  plugins: z.array(z.string()),
  readOnly: z.array(z.string()),
  starters: z.array(z.string().min(1)).max(3),
  editable: z.strictObject({ instructions: z.boolean() }).optional(),
  // Spec 8.3: core rules are switched off only explicitly.
  baseRules: z.boolean().optional(),
});
export type AgentPassport = z.infer<typeof agentPassportSchema>;

export const pluginPassportSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
  title: z.string().min(1),
  settings: z.custom<z.ZodType>((v) => typeof (v as { safeParse?: unknown } | null)?.safeParse === 'function', 'must be a zod schema'),
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable name')),
  readOnly: z.array(z.string()),
  checkTool: z.string().optional(),
  connection: z
    .strictObject({ mode: z.enum(['personal', 'shared']), auth: z.enum(['oauth', 'static', 'identity']) })
    .optional(),
  // Other plugins whose public/ part this one imports (checked by tooling/architecture too).
  dependsOn: z.array(z.string()).optional(),
  // Builds the plugin's tools from its settings and secrets; called once at start-up.
  tools: z.custom<(ctx: never) => Record<string, unknown>>((v) => typeof v === 'function', 'must be a function').optional(),
  // Describes the plugin's MCP server and how employees connect to it (core/plugins/public: McpDefinition).
  mcp: z.custom<(ctx: never) => unknown>((v) => typeof v === 'function', 'must be a function').optional(),
  // Event sources of the plugin; each gets start()/stop() (core/plugins/public: PluginTrigger).
  triggers: z.custom<(ctx: never) => unknown>((v) => typeof v === 'function', 'must be a function').optional(),
});
export type PluginPassport = z.infer<typeof pluginPassportSchema>;
