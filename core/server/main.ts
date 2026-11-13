// Start of the server: read the environment, load and validate the installation, migrate, serve.
// Any configuration problem stops the start with APP_CONFIG_INVALID and the list of files and fields.
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../auth/auth.ts';
import { readCoreEnv } from '../config/env.ts';
import { loadInstallation } from '../config/load.ts';
import { buildRegistry } from '../loader/registry.ts';
import { migrate } from '../db/migrate.ts';
import { createAuthPool, createPool } from '../db/pool.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { createModelGateway } from '../models/gateway.ts';
import { createLiteLLMClient } from '../models/litellm-client.ts';
import { ensureLimitSettings } from '../models/limits.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import { isAppError } from '../errors/app-error.ts';
import { createApp } from './app.ts';
import { logEvent } from './log.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 3000;
const CORE_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

async function main(): Promise<void> {
  const env = readCoreEnv(process.env);
  const installation = await loadInstallation(ROOT, process.env);
  const db = createPool(env.DATABASE_URL);
  const registry = await buildRegistry({ root: ROOT, installation, env: process.env, db, coreSkillsDir: CORE_SKILLS_DIR });
  await migrate(env.DATABASE_URL, undefined, registry.pluginMigrations);
  const auth = createAuth({ db, authPool: createAuthPool(env.DATABASE_URL), secret: env.BETTER_AUTH_SECRET, publicUrl: env.APP_PUBLIC_URL });
  const agentIds = registry.ids();
  await ensureLimitSettings(db, installation.app.limits);
  await ensureMaskingSettings(db, installation.app.masking.initialKinds);
  const gateway = createModelGateway({
    db,
    client: createLiteLLMClient(env.LITELLM_URL, env.LITELLM_MASTER_KEY),
    box: createSecretBox(env.APP_ENCRYPTION_KEYS),
    catalog: installation.models,
    timezone: installation.app.timezone,
  });
  await gateway.syncOrgBudget();
  const app = createApp({ db, auth, publicUrl: env.APP_PUBLIC_URL, knownAgentIds: () => agentIds, gateway, ledgerSecret: env.LITELLM_CALLBACK_SECRET });
  serve({ fetch: app.fetch, port: PORT }, (info) => logEvent('info', 'server_started', { port: info.port, agents: [...agentIds] }));
}

main().catch((error: unknown) => {
  logEvent('error', 'server_start_failed', { code: isAppError(error) ? error.code : 'APP_INTERNAL', error });
  process.exit(1);
});
