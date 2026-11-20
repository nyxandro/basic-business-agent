// What «Проверить и сохранить» tells the admin when LiteLLM's probe of a provider fails (#7, section 8.19).
import { describe, expect, it } from 'vitest';
import { checkFailure } from './check-failure.ts';

// LiteLLM 1.109.1 (main.py, ahealth_check): str(error) + "\nstack trace: " + up to 1 000 characters of
// the traceback, whose lines of code may name any parameter.
const withTrace = (message: string) =>
  `${message}\nstack trace: Traceback (most recent call last):\n  File "/app/litellm/main.py", line 640, in acompletion\n    optional_params["max_tokens"] = max_tokens; timeout = kwargs.get("timeout"); reasoning_format = None`;

const GROQ_LIMIT = 'litellm.BadRequestError: GroqException - {"error":{"message":"`max_tokens` must be less than or equal to `65536`, the maximum value for `max_tokens` is less than the `context_window` for this model","type":"invalid_request_error","param":"max_tokens"}}';
const GROQ_REASONING = 'litellm.BadRequestError: GroqException - {"error":{"message":"`reasoning_format` is not supported with this model","type":"invalid_request_error","param":"reasoning_format"}}';
const WRONG_KEY = 'litellm.AuthenticationError: AuthenticationError: GroqException - Invalid API Key';
const LIMIT_TEXT = (n: number) => `Провайдер не принял наибольшую длину ответа: ${n.toLocaleString('ru-RU')}. Укажите меньшую — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).`;

describe('the failure of a provider check', () => {
  it('names a limit of an answer the provider refused, with the number', () => {
    const error = checkFailure(withTrace(GROQ_LIMIT), 'groq/openai/gpt-oss-20b', 1_000_000);
    expect(error.code).toBe('APP_MODEL_OUTPUT_LIMIT_REJECTED');
    expect(error.userMessage).toBe(LIMIT_TEXT(1_000_000));
  });

  // Providers name the limit in their own words; the probe carried nothing else that could be too large.
  it.each([
    ['TGI', 'litellm.BadRequestError: HuggingfaceException - `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 12 `inputs` tokens and 100000 `max_new_tokens`'],
    ['vLLM', "litellm.BadRequestError: OpenAIException - This model's maximum context length is 32768 tokens. However, you requested 100012 tokens (12 in the messages, 100000 in the completion)."],
    ['Groq tokens per minute', 'litellm.RateLimitError: GroqException - Request too large for model `qwen/qwen3.6-27b` in organization `org_1` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 100012, please reduce your message size and try again.'],
    ['Gemini, the words on the next line', 'litellm.BadRequestError: VertexAIException - {\n  "error": {\n    "message": "Unable to submit request because it has a maxOutputTokens value of 100000 but the supported range is from 1 (inclusive) to 65537 (exclusive)."\n  }\n}'],
  ])('takes a refusal of the limit in the words of %s', (_provider, message) => {
    const error = checkFailure(withTrace(message), 'openai/some-model', 100_000);
    expect(error.code).toBe('APP_MODEL_OUTPUT_LIMIT_REJECTED');
    expect(error.userMessage).toBe(LIMIT_TEXT(100_000));
  });

  it('names a Groq model that cannot keep its reasoning apart', () => {
    const error = checkFailure(withTrace(GROQ_REASONING), 'groq/allam-2-7b', 4096);
    expect(error.code).toBe('APP_MODEL_CHECK_FAILED');
    expect(error.userMessage).toBe('Эта модель Groq не умеет отдавать рассуждения отдельно от ответа, а база ждёт этого от всех моделей Groq. Выберите другую модель Groq.');
  });

  // The words of LiteLLM's own code in the trace say nothing about what the provider answered.
  it('takes a wrong key for a wrong key, whatever the stack trace or the provider names', () => {
    for (const message of [WRONG_KEY, 'litellm.AuthenticationError: OpenAIException - Incorrect API key provided for a request with max_tokens 100000']) {
      const error = checkFailure(withTrace(message), 'groq/qwen/qwen3.6-27b', 16_384);
      expect(error.code).toBe('APP_MODEL_CHECK_FAILED');
      expect(error.userMessage).toBe('Провайдер не принял ключ. Проверьте ключ и модель провайдера.');
    }
  });

  it('says the provider did not answer when it could not be reached', () => {
    const error = checkFailure(withTrace('litellm.APIConnectionError: OpenAIException - Connection error.'), 'openai/gpt-4.1-mini', 32_768);
    expect(error.userMessage).toBe('Провайдер не ответил. Попробуйте ещё раз.');
  });

  it('does not take a refusal about the limit for one when the probe carried no limit of the model', () => {
    expect(checkFailure(GROQ_LIMIT, 'groq/qwen/qwen3.6-27b', undefined).code).toBe('APP_MODEL_CHECK_FAILED');
  });

  // The technical message goes to the journal: the provider's first line, not the trace.
  it('keeps the trace out of the technical message', () => {
    const error = checkFailure(withTrace(WRONG_KEY), 'groq/qwen/qwen3.6-27b', undefined);
    expect(error.message).toContain('Invalid API Key');
    expect(error.message).not.toContain('Traceback');
  });
});
