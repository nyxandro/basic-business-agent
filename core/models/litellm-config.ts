// LiteLLM configuration generated from config/models.ts (spec, section 8.1).
// Prices go to LiteLLM in roubles per token, so its spend and budgets are in roubles.
// Provider keys appear only as "os.environ/NAME" references: the app never holds them.
import type { ModelConfig, Prices } from '../config/schemas.ts';

export const LEDGER_CALLBACK_NAME = 'bba_ledger';
const TOKENS_PER_PRICE_UNIT = 1_000_000;
const COOLDOWN_SECONDS = 60;
// One retry moves a failed request to another account of the same pool (verified transient:
// a revoked or rate-limited account); LiteLLM logs it, so the retry is observable.
const POOL_RETRIES = 1;
const ALLOWED_FAILS_BEFORE_COOLDOWN = 1;

export interface LiteLLMConfigOptions {
  timezone: string;
  callbackUrl: string;
}

function perToken(rubPerMillion: number): number {
  return rubPerMillion / TOKENS_PER_PRICE_UNIT;
}

export function pricesToLiteLLM(prices: Prices): Record<string, number> {
  return {
    input_cost_per_token: perToken(prices.input),
    output_cost_per_token: perToken(prices.output),
    cache_read_input_token_cost: perToken(prices.cacheRead),
    cache_creation_input_token_cost: perToken(prices.cacheWrite),
    output_cost_per_reasoning_token: perToken(prices.reasoning),
    input_cost_per_image: prices.image,
  };
}

export function buildLiteLLMConfig(models: ModelConfig[], opts: LiteLLMConfigOptions): Record<string, unknown> {
  return {
    model_list: models.flatMap((m) =>
      m.deployments.map((d) => ({
        model_name: m.id,
        litellm_params: { ...d.litellm, ...pricesToLiteLLM(m.prices) },
        model_info: { id: d.id },
      })),
    ),
    litellm_settings: {
      timezone: opts.timezone,
      callbacks: [LEDGER_CALLBACK_NAME],
      always_include_stream_usage: true,
      turn_off_message_logging: true,
    },
    callback_settings: {
      [LEDGER_CALLBACK_NAME]: {
        callback_type: 'generic_api',
        endpoint: opts.callbackUrl,
        log_format: 'single',
        event_types: ['llm_api_success'],
        headers: { Authorization: 'os.environ/LITELLM_CALLBACK_AUTHORIZATION' },
      },
    },
    router_settings: {
      routing_strategy: 'simple-shuffle',
      num_retries: POOL_RETRIES,
      allowed_fails: ALLOWED_FAILS_BEFORE_COOLDOWN,
      cooldown_time: COOLDOWN_SECONDS,
    },
    general_settings: {
      master_key: 'os.environ/LITELLM_MASTER_KEY',
      database_url: 'os.environ/DATABASE_URL',
    },
  };
}
