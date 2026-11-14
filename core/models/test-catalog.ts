// Mock models of the tests. The test LiteLLM keeps their deployments in its file
// (deploy/litellm/test.config.json, `pnpm gateway:config --test`): mock answers, no real providers;
// mock_response may also name an exception class, which makes LiteLLM raise that error.
// seedTestModels() registers the same ids in a test database, without keys: the deployments are
// the file's, so the server's copying of models into LiteLLM leaves them alone.
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/pool.ts';
import type { StaticDeployment } from './litellm-config.ts';
import { pricesToLiteLLM, ZERO_PRICES, type TokenPrices } from './prices.ts';

export const TEST_PAID_PRICES: TokenPrices = { input: 100, output: 400, cacheRead: 10, cacheWrite: 125, reasoning: 400, image: 1 };

interface TestModel {
  id: string;
  label: string;
  subscription: boolean;
  deployments: { id: string; params: Record<string, string | number | boolean> }[];
}

const TEST_MODELS: TestModel[] = [
  {
    id: 'test-paid',
    label: 'Платная (заглушка)',
    subscription: false,
    deployments: [{ id: 'paid-1', params: { model: 'openai/test-paid', api_key: 'fake', mock_response: 'Ответ платной модели' } }],
  },
  {
    id: 'test-sub',
    label: 'Подписка (заглушка)',
    subscription: true,
    deployments: [
      { id: 'sub-1', params: { model: 'openai/test-sub', api_key: 'fake', mock_response: 'Ответ подписки' } },
      { id: 'sub-2', params: { model: 'openai/test-sub', api_key: 'fake', mock_response: 'Ответ подписки' } },
    ],
  },
  {
    id: 'test-ratelimited',
    label: 'Всегда 429 (заглушка)',
    subscription: false,
    deployments: [{ id: 'rl-1', params: { model: 'openai/test-rl', api_key: 'fake', mock_response: 'litellm.RateLimitError' } }],
  },
  {
    id: 'test-down',
    label: 'Недоступна (заглушка)',
    subscription: false,
    deployments: [{ id: 'down-1', params: { model: 'openai/test-down', api_key: 'fake', api_base: 'http://127.0.0.1:9/v1', timeout: 2 } }],
  },
];

export const TEST_STATIC_DEPLOYMENTS: StaticDeployment[] = TEST_MODELS.flatMap((m) =>
  m.deployments.map((d) => ({ modelName: m.id, id: d.id, params: { ...d.params, ...pricesToLiteLLM(m.subscription ? ZERO_PRICES : TEST_PAID_PRICES) } })),
);

export const TEST_PRIMARY_MODEL = 'test-paid';
export const TEST_MODEL_IDS: ReadonlySet<string> = new Set(TEST_MODELS.map((m) => m.id));

// The test LiteLLM reads the ChatGPT login files from here (deploy/compose.dev.yaml: /chatgpt-auth),
// and sends the requests of subscription models to a fake ChatGPT on this port (CHATGPT_API_BASE).
export const TEST_CHATGPT_AUTH_DIR = fileURLToPath(new URL('../../.data/chatgpt-auth-test', import.meta.url));
export const TEST_CHATGPT_PORT = 39_998;

// The catalog of a test installation: the mock models, test-paid as the organisation's model.
export async function seedTestModels(db: Db): Promise<void> {
  const p = TEST_PAID_PRICES;
  for (const m of TEST_MODELS) {
    await db.query(
      m.subscription
        ? `INSERT INTO app.models (id, kind, label, connection, provider_model, vision) VALUES ($1, 'chat', $2, 'chatgpt', $3, true)`
        : `INSERT INTO app.models (id, kind, label, connection, provider_model, vision, price_input, price_output, price_cache_read, price_cache_write, price_reasoning, price_image)
           VALUES ($1, 'chat', $2, 'api_key', $3, true, $4, $5, $6, $7, $8, $9)`,
      m.subscription ? [m.id, m.label, m.deployments[0]!.params.model] : [m.id, m.label, m.deployments[0]!.params.model, p.input, p.output, p.cacheRead, p.cacheWrite, p.reasoning, p.image],
    );
  }
  await db.query('UPDATE app.model_settings SET primary_model_id = $1', [TEST_PRIMARY_MODEL]);
}

export const TEST_CALLBACK_PORT = 39_999;
export const TEST_LITELLM_OPTIONS = {
  timezone: 'Europe/Moscow',
  callbackUrl: `http://host.docker.internal:${TEST_CALLBACK_PORT}/app/api/internal/usage`,
  staticDeployments: TEST_STATIC_DEPLOYMENTS,
};
