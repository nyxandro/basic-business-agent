// pnpm gateway:config — write deploy/litellm/config.json: how LiteLLM reports usage and routes.
// pnpm gateway:config --test — rewrite deploy/litellm/test.config.json with the tests' mock models.
// --mkdir-auth (pnpm dev:stack) also creates APP_CHATGPT_AUTH_DIR, which the development LiteLLM
// mounts: Docker would create a missing folder owned by root, and the server could not write it.
// Models of an installation are not in the file: the server puts them into LiteLLM's database.
// JSON is valid YAML, so LiteLLM reads the file as its usual config.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadInstallation } from '../config/load.ts';
import { isAppError } from '../errors/app-error.ts';
import { buildLiteLLMConfig } from '../models/litellm-config.ts';
import { TEST_LITELLM_OPTIONS } from '../models/test-catalog.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function write(file: string, config: Record<string, unknown>): void {
  writeFileSync(new URL(`../../deploy/litellm/${file}`, import.meta.url), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Written deploy/litellm/${file}`);
}

try {
  if (process.argv.includes('--test')) {
    write('test.config.json', buildLiteLLMConfig(TEST_LITELLM_OPTIONS));
  } else {
    const callbackUrl = process.env.LITELLM_CALLBACK_URL;
    if (!callbackUrl) throw new Error('APP_CONFIG_INVALID: .env: LITELLM_CALLBACK_URL: is not set');
    const installation = await loadInstallation(ROOT, process.env);
    write('config.json', buildLiteLLMConfig({ timezone: installation.app.timezone, callbackUrl, staticDeployments: [] }));
    if (process.argv.includes('--mkdir-auth')) {
      const authDir = process.env.APP_CHATGPT_AUTH_DIR;
      if (!authDir) throw new Error('APP_CONFIG_INVALID: .env: APP_CHATGPT_AUTH_DIR: is not set');
      mkdirSync(authDir, { recursive: true, mode: 0o700 });
    }
  }
} catch (error) {
  console.error(isAppError(error) ? error.message : error instanceof Error ? error.message : error);
  process.exit(1);
}
