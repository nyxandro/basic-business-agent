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

export const modelCreateSchema = z.discriminatedUnion('connection', [
  z.object({
    connection: z.literal('api_key'),
    kind: z.enum(MODEL_KINDS),
    label: z.string(),
    // "provider/model" as LiteLLM names it, e.g. openai/gpt-4.1-mini.
    providerModel: z.string(),
    apiBase: z.string().nullable(),
    vision: z.boolean(),
    prices: tokenPricesInputSchema.nullable(),
    // Recognition only: roubles per minute of audio instead of token prices.
    pricePerMinute: price,
    key: z.string(),
  }),
  // «Подписка ChatGPT»: a chat model served by the accounts of the pool, without a key or prices.
  z.object({
    connection: z.literal('chatgpt'),
    kind: z.literal('chat'),
    label: z.string(),
    // chatgpt/<model>, e.g. chatgpt/gpt-5.4.
    providerModel: z.string(),
    vision: z.boolean(),
  }),
]);
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

// State of an account of the pool (spec, section 8.1):
// - auth_error: OpenAI refused the login; the account is out of the gateway until «Войти заново»;
// - cooldown: the gateway skips it after a failure until cooldownUntil;
// - works: it answered within 30 days;
// - no_requests: nothing is known yet.
export const CHATGPT_ACCOUNT_STATES = ['works', 'cooldown', 'auth_error', 'no_requests'] as const;
export type ChatGptAccountState = (typeof CHATGPT_ACCOUNT_STATES)[number];

export interface ChatGptAccountDto {
  id: string;
  email: string;
  connectedAt: string;
  state: ChatGptAccountState;
  // HTTP status of the last failure (cooldown and auth_error).
  failureStatus: number | null;
  cooldownUntil: string | null;
  lastSuccessAt: string | null;
  tokensToday: number;
}

// «Войти заново» names the account; a new account — null.
export const chatgptLoginStartSchema = z.object({ accountId: z.string().nullable() });

export interface ChatGptLoginDto {
  id: string;
  // The person enters it on OpenAI's page.
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
  // The countdown runs from the answer, so a wrong clock of the admin's computer does not matter.
  expiresInSeconds: number;
  // Ask about the login no more often than this.
  intervalSeconds: number;
}

export type ChatGptLoginStatus = { status: 'pending'; expiresAt: string } | { status: 'connected'; account: ChatGptAccountDto };

export interface ModelsResponse {
  models: ModelDto[];
  settings: ModelSettings;
  accounts: ChatGptAccountDto[];
  gateway: {
    reachable: boolean;
    checkedAt: string;
    // Enabled models whose deployments in the gateway differ from ours: it is still applying them.
    pendingModelIds: string[];
  };
}
