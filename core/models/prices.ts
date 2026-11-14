// Prices of models in roubles as LiteLLM takes them (spec, section 8.1): the admin enters roubles
// per 1 million tokens of each kind, per image and per minute of audio; LiteLLM counts spend and
// budgets in whatever currency its prices are in, so its spend is in roubles too.
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  image: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const SECONDS_PER_MINUTE = 60;

function perToken(rubPerMillion: number): number {
  return rubPerMillion / TOKENS_PER_PRICE_UNIT;
}

export function pricesToLiteLLM(prices: TokenPrices): Record<string, number> {
  return {
    input_cost_per_token: perToken(prices.input),
    output_cost_per_token: perToken(prices.output),
    cache_read_input_token_cost: perToken(prices.cacheRead),
    cache_creation_input_token_cost: perToken(prices.cacheWrite),
    output_cost_per_reasoning_token: perToken(prices.reasoning),
    input_cost_per_image: prices.image,
  };
}

// Whisper-like recognition reports the length of the audio, not tokens.
export function perMinuteToLiteLLM(rubPerMinute: number): Record<string, number> {
  return { input_cost_per_second: rubPerMinute / SECONDS_PER_MINUTE };
}

export const ZERO_PRICES: TokenPrices = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, image: 0 };
