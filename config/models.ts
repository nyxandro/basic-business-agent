// Model catalog: what agents may use, prices in rubles per 1 million tokens of each kind, and the
// deployments LiteLLM routes to. `pnpm models:config` turns it into deploy/litellm/config.json.
// Keys never live here: `os.environ/NAME` makes LiteLLM read the key from its environment (.env).
//
// Demo: one model of an OpenAI-compatible provider. Put the model you use and its prices here and
// its key into .env (OPENAI_API_KEY); prices below are an example, check your provider's tariff.
import { defineModels } from '../core/config/public/index.ts';

export default defineModels([
  {
    id: 'main',
    label: 'Основная модель',
    subscription: false,
    prices: { input: 35, output: 140, cacheRead: 9, cacheWrite: 35, reasoning: 140, image: 35 },
    deployments: [{ id: 'openai-main', litellm: { model: 'openai/gpt-4.1-mini', api_key: 'os.environ/OPENAI_API_KEY' } }],
  },
]);
