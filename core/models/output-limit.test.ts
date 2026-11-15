import { describe, expect, it } from 'vitest';
import { outputLimitIn } from './output-limit.ts';

// Entries as LiteLLM's model map keeps them (/public/litellm_model_cost_map).
const MAP = {
  'groq/qwen/qwen3.8-27b': { litellm_provider: 'groq', max_output_tokens: 16384, mode: 'chat' },
  'gpt-4.1-mini': { litellm_provider: 'openai', max_output_tokens: 32768, mode: 'chat' },
  'azure-only': { litellm_provider: 'azure', max_output_tokens: 4096, mode: 'chat' },
  'openai/exact-and-short': { litellm_provider: 'openai', max_output_tokens: 1000, mode: 'chat' },
  'exact-and-short': { litellm_provider: 'openai', max_output_tokens: 2000, mode: 'chat' },
  'no-limit': { litellm_provider: 'openai', max_tokens: 8192, mode: 'chat' },
  'broken-limit': { litellm_provider: 'openai', max_output_tokens: 0, mode: 'chat' },
  'text-limit': { litellm_provider: 'openai', max_output_tokens: '4096', mode: 'chat' },
};

describe('the limit of an answer in the gateway’s model map (spec, section 8.19)', () => {
  it('finds a model by its full name «provider/model»', () => {
    expect(outputLimitIn(MAP, 'groq/qwen/qwen3.8-27b')).toBe(16384);
  });

  it('finds a model kept without its provider when the entry is of that provider, as OpenAI’s models are', () => {
    expect(outputLimitIn(MAP, 'openai/gpt-4.1-mini')).toBe(32768);
    expect(outputLimitIn(MAP, 'openai/azure-only')).toBeNull();
  });

  it('takes the full name first', () => {
    expect(outputLimitIn(MAP, 'openai/exact-and-short')).toBe(1000);
  });

  it('does not know a model that is absent or has no usable limit of an answer', () => {
    expect(outputLimitIn(MAP, 'groq/qwen/qwen3.6-27b')).toBeNull();
    expect(outputLimitIn(MAP, 'openai/no-limit')).toBeNull();
    expect(outputLimitIn(MAP, 'openai/broken-limit')).toBeNull();
    expect(outputLimitIn(MAP, 'openai/text-limit')).toBeNull();
    expect(outputLimitIn({ 'openai/x': null }, 'openai/x')).toBeNull();
  });
});
