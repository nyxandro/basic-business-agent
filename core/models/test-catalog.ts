// Model catalog of the test LiteLLM (deploy/litellm/test.config.json): mock answers, no real providers.
// LiteLLM's mock_response may also name an exception class, which makes it raise that error.
import type { ModelConfig } from '../config/schemas.ts';

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, image: 0 };
export const TEST_PAID_PRICES = { input: 100, output: 400, cacheRead: 10, cacheWrite: 125, reasoning: 400, image: 1 };

export const TEST_CATALOG: ModelConfig[] = [
  {
    id: 'test-paid',
    label: 'Платная (заглушка)',
    subscription: false,
    prices: TEST_PAID_PRICES,
    deployments: [{ id: 'paid-1', litellm: { model: 'openai/test-paid', api_key: 'fake', mock_response: 'Ответ платной модели' } }],
  },
  {
    id: 'test-sub',
    label: 'Подписка (заглушка)',
    subscription: true,
    prices: ZERO,
    deployments: [
      { id: 'sub-1', litellm: { model: 'openai/test-sub', api_key: 'fake', mock_response: 'Ответ подписки' } },
      { id: 'sub-2', litellm: { model: 'openai/test-sub', api_key: 'fake', mock_response: 'Ответ подписки' } },
    ],
  },
  {
    id: 'test-ratelimited',
    label: 'Всегда 429 (заглушка)',
    subscription: false,
    prices: TEST_PAID_PRICES,
    deployments: [{ id: 'rl-1', litellm: { model: 'openai/test-rl', api_key: 'fake', mock_response: 'litellm.RateLimitError' } }],
  },
  {
    id: 'test-down',
    label: 'Недоступна (заглушка)',
    subscription: false,
    prices: TEST_PAID_PRICES,
    deployments: [{ id: 'down-1', litellm: { model: 'openai/test-down', api_key: 'fake', api_base: 'http://127.0.0.1:9/v1', timeout: 2 } }],
  },
];

export const TEST_CALLBACK_PORT = 39_999;
export const TEST_LITELLM_OPTIONS = {
  timezone: 'Europe/Moscow',
  callbackUrl: `http://host.docker.internal:${TEST_CALLBACK_PORT}/app/api/internal/usage`,
};
