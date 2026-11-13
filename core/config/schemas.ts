// Declarative configuration of an installation (spec, sections 17.2–17.3):
// config/app.ts, config/models.ts, config/plugins.ts, agents/<id>/agent.ts, plugins/<name>/plugin.ts.
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
});
export type AppConfig = z.infer<typeof appConfigSchema>;

// Prices in roubles: per 1 million tokens of each kind, and per image. LiteLLM silently falls back
// to its own dollar prices for any kind left empty, so every kind is required.
export const pricesSchema = z.strictObject({
  input: rub,
  output: rub,
  cacheRead: rub,
  cacheWrite: rub,
  reasoning: rub,
  image: rub,
});
export type Prices = z.infer<typeof pricesSchema>;

const litellmParam = z.union([z.string(), z.number(), z.boolean()]);

export const deploymentSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
  // Passed to LiteLLM as litellm_params; secrets only as "os.environ/NAME" references.
  litellm: z.record(z.string(), litellmParam).refine((p) => typeof p.model === 'string', 'must contain "model"'),
});

export const modelSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'use lowercase letters, digits, dots and dashes'),
    label: z.string().min(1),
    subscription: z.boolean(),
    prices: pricesSchema,
    deployments: z.array(deploymentSchema).min(1),
  })
  .superRefine((model, ctx) => {
    if (!model.subscription) return;
    for (const [kind, price] of Object.entries(model.prices)) {
      if (price !== 0) ctx.addIssue({ code: 'custom', path: ['prices', kind], message: 'must be 0 for a subscription model' });
    }
  });
export type ModelConfig = z.infer<typeof modelSchema>;

export const modelsConfigSchema = z.array(modelSchema).min(1);

export const agentPassportSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'use 2–41 lowercase letters, digits and dashes, starting with a letter'),
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  plugins: z.array(z.string()),
  readOnly: z.array(z.string()),
  starters: z.array(z.string().min(1)).max(3),
  editable: z.strictObject({ instructions: z.boolean(), models: z.array(z.string()) }).optional(),
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
});
export type PluginPassport = z.infer<typeof pluginPassportSchema>;
