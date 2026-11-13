// Start of the server: read the environment, load and validate the installation, migrate, serve.
// Any configuration problem stops the start with APP_CONFIG_INVALID and the list of files and fields.
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../auth/auth.ts';
import { readCoreEnv } from '../config/env.ts';
import { loadInstallation } from '../config/load.ts';
import { buildRegistry } from '../loader/registry.ts';
import { PostgresStore } from '@mastra/pg';
import { createMastraRuntime } from '../runtime/mastra.ts';
import { createConnectionManager } from '../connections/manager.ts';
import { createLimiter, MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS } from '../sandbox/limiter.ts';
import { assertIsolationAvailable } from '../sandbox/workspace.ts';
import { migrate } from '../db/migrate.ts';
import { createAuthPool, createPool } from '../db/pool.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { createModelGateway } from '../models/gateway.ts';
import { createLiteLLMClient } from '../models/litellm-client.ts';
import { ensureLimitSettings } from '../models/limits.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import { createCopilotHandler } from '../chat/copilot.ts';
import { createMemory } from '../memory/memory.ts';
import { isAppError } from '../errors/app-error.ts';
import { createApp } from './app.ts';
import { logEvent } from './log.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 3000;
const CORE_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));
const SKILLS_VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));

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
  const box = createSecretBox(env.APP_ENCRYPTION_KEYS);
  const gateway = createModelGateway({
    db,
    client: createLiteLLMClient(env.LITELLM_URL, env.LITELLM_MASTER_KEY),
    box,
    catalog: installation.models,
    timezone: installation.app.timezone,
  });
  await gateway.syncOrgBudget();
  const storage = new PostgresStore({ id: 'bba', connectionString: env.DATABASE_URL, schemaName: 'mastra' });
  const memory = createMemory(storage);
  const connections = createConnectionManager({ db, box, publicUrl: env.APP_PUBLIC_URL, connectors: registry.connectors });
  const sandbox = {
    deps: { workspaceRoot: env.APP_WORKSPACE_DIR, skillsVenv: SKILLS_VENV, limiter: createLimiter(MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS) },
    isolation: assertIsolationAvailable(),
  };
  const mastra = createMastraRuntime({ registry, storage, memory, gateway, db, app: installation.app, connections, sandbox });
  const editor = { db, mastra, registry };
  const chat = { db, memory, registry, gateway, editor, workspaceRoot: env.APP_WORKSPACE_DIR, copilot: createCopilotHandler({ editor }) };
  const app = createApp({ db, auth, publicUrl: env.APP_PUBLIC_URL, knownAgentIds: () => agentIds, gateway, ledgerSecret: env.LITELLM_CALLBACK_SECRET, connections, chat });
  serve({ fetch: app.fetch, port: PORT }, (info) => logEvent('info', 'server_started', { port: info.port, agents: [...agentIds] }));
}

main().catch((error: unknown) => {
  logEvent('error', 'server_start_failed', { code: isAppError(error) ? error.code : 'APP_INTERNAL', error });
  process.exit(1);
});
