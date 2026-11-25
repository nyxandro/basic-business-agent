import { describe, expect, it } from 'vitest';
import { contextInList, listBaseOf } from './provider-models.ts';

// Lists of models as providers give them (GET …/models).
const LISTS = {
  // neuraldeep: the format of models.dev.
  neuraldeep: { object: 'list', data: [{ id: 'qwen3.8-flash-next-ru', object: 'model', limit: { context: 262144, output: 235929 } }] },
  groq: { object: 'list', data: [{ id: 'qwen/qwen3.8-27b', object: 'model', context_window: 131072 }] },
  openrouter: { data: [{ id: 'deepseek/deepseek-v4', context_length: 163840 }] },
  vllm: { object: 'list', data: [{ id: 'local-model', object: 'model', max_model_len: 32768 }] },
};

describe('the size of the context in a provider’s list of models (spec, section 8.34)', () => {
  it('reads the fields providers name it by', () => {
    expect(contextInList(LISTS.neuraldeep, 'qwen3.8-flash-next-ru')).toBe(262144);
    expect(contextInList(LISTS.groq, 'qwen/qwen3.8-27b')).toBe(131072);
    expect(contextInList(LISTS.openrouter, 'deepseek/deepseek-v4')).toBe(163840);
    expect(contextInList(LISTS.vllm, 'local-model')).toBe(32768);
  });

  it('knows nothing of a model that is not in the list or has no whole positive size', () => {
    expect(contextInList(LISTS.neuraldeep, 'qwen3.8-flash-next-ru-noreason')).toBeNull();
    expect(contextInList({ data: [{ id: 'm', context_window: 0 }] }, 'm')).toBeNull();
    expect(contextInList({ data: [{ id: 'm', context_length: '8192' }] }, 'm')).toBeNull();
    expect(contextInList({ data: [{ id: 'm', max_model_len: 1.5 }] }, 'm')).toBeNull();
    expect(contextInList({ data: [{ id: 'm', limit: null }] }, 'm')).toBeNull();
    expect(contextInList({ models: [] }, 'm')).toBeNull();
    expect(contextInList(null, 'm')).toBeNull();
  });

  it('asks the model’s own address, or the standard one of a provider whose list tells the size', () => {
    expect(listBaseOf({ providerModel: 'openai/qwen3.8-flash-next-ru', apiBase: 'https://api.neuraldeep.ru/v1/' })).toEqual({ base: 'https://api.neuraldeep.ru/v1', modelId: 'qwen3.8-flash-next-ru' });
    expect(listBaseOf({ providerModel: 'groq/qwen/qwen3.8-27b', apiBase: null })).toEqual({ base: 'https://api.groq.com/openai/v1', modelId: 'qwen/qwen3.8-27b' });
    expect(listBaseOf({ providerModel: 'openrouter/deepseek/deepseek-v4', apiBase: null })).toEqual({ base: 'https://openrouter.ai/api/v1', modelId: 'deepseek/deepseek-v4' });
    // OpenAI's list says nothing of the size.
    expect(listBaseOf({ providerModel: 'openai/gpt-4.1-mini', apiBase: null })).toBeNull();
  });
});
