import { z } from 'zod';

// «Нейросеть» (spec, scenario 9, section 8.1): models, provider keys and the organisation's choice.
export const MODEL_KINDS = ['chat', 'transcription'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];
export const MODEL_CONNECTIONS = ['api_key', 'chatgpt'] as const;
export type ModelConnection = (typeof MODEL_CONNECTIONS)[number];

// Roubles per 1 million tokens of each kind; an image — roubles each. Every kind is filled in:
// an empty one would let LiteLLM fall back to its own dollar price.
const price = z.number().min(0).max(1_000_000).nullable();
export const tokenPricesInputSchema = z.object({ input: price, output: price, cacheRead: price, cacheWrite: price, reasoning: price, image: price });
export type TokenPricesInput = z.infer<typeof tokenPricesInputSchema>;

export const modelCreateSchema = z.object({
  kind: z.enum(MODEL_KINDS),
  label: z.string(),
  connection: z.literal('api_key'),
  // "provider/model" as LiteLLM names it, e.g. openai/gpt-4.1-mini.
  providerModel: z.string(),
  apiBase: z.string().nullable(),
  vision: z.boolean(),
  prices: tokenPricesInputSchema.nullable(),
  // Recognition only: roubles per minute of audio instead of token prices.
  pricePerMinute: price,
  key: z.string(),
});
export type ModelCreate = z.infer<typeof modelCreateSchema>;

export const modelUpdateSchema = z.object({
  label: z.string().optional(),
  vision: z.boolean().optional(),
  enabled: z.boolean().optional(),
  prices: tokenPricesInputSchema.nullable().optional(),
  pricePerMinute: price.optional(),
});
export type ModelUpdate = z.infer<typeof modelUpdateSchema>;

export const modelKeyCreateSchema = z.object({ key: z.string() });

export const modelSettingsSchema = z.object({
  primaryModelId: z.string().nullable(),
  fallbackModelId: z.string().nullable(),
  transcriptionModelId: z.string().nullable(),
  agentsChooseModel: z.boolean(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  image: number;
}

// A provider key is never sent back: only its last 4 characters.
export interface ModelKeyDto {
  id: string;
  last4: string;
  createdAt: string;
}

export interface ModelDto {
  id: string;
  kind: ModelKind;
  label: string;
  connection: ModelConnection;
  providerModel: string;
  apiBase: string | null;
  vision: boolean;
  enabled: boolean;
  prices: TokenPrices | null;
  pricePerMinute: number | null;
  keys: ModelKeyDto[];
  // Agents whose own model it is (admin's choice in «Агенты и промпты»).
  agentIds: string[];
}

export interface ModelsResponse {
  models: ModelDto[];
  settings: ModelSettings;
  gateway: {
    reachable: boolean;
    checkedAt: string;
    // Enabled models whose deployments in the gateway differ from ours: it is still applying them.
    pendingModelIds: string[];
  };
}
