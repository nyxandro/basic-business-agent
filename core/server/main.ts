// Start of the server: read the environment, load and validate the installation, migrate, serve.
// Any configuration problem stops the start with APP_CONFIG_INVALID and the list of files and fields.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverProjectFolders, startTrashPurge } from '../projects/trash.ts';
import { startDraftsSweep } from '../storage/drafts-sweep.ts';
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
import { assertSandboxEnvironment } from '../sandbox/environment.ts';
import { migrate } from '../db/migrate.ts';
import { createAuthPool, createPool } from '../db/pool.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { ensureOrgName } from '../admin/org-profile.ts';
import { ensureAgentAbilities } from '../abilities/abilities.ts';
import { cleanWebWork, createPageReader, FETCH_MAX_MS, WEB_TEXT_CACHE_DIR, WEB_TEXT_CACHE_MAX_AGE_MS, WEB_TEXT_CACHE_MAX_BYTES } from '../web/fetch.ts';
import { createGatewaySearcher } from '../web/search.ts';
import { createModelCatalog } from '../models/catalog.ts';
import { createChatGptAccounts } from '../models/chatgpt-accounts.ts';
import { createChatGptAuthClient, OPENAI_AUTH_BASE } from '../models/chatgpt-login.ts';
import { createGatewayWriter } from '../models/gateway-writer.ts';
import { createModelGateway } from '../models/gateway.ts';
import { GATEWAY_OWNER, GATEWAY_TIMEOUTS } from '../models/gateway-sync.ts';
import { createLiteLLMClient } from '../models/litellm-client.ts';
import { ensureLimitSettings } from '../models/limits.ts';
import { ensureApprovalSettings } from '../approvals/settings.ts';
import { createNotifications } from '../notifications/service.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import { createCopilotHandler } from '../chat/copilot.ts';
import { NAMING_MAX_MS, TITLE_WAIT_AT_END_MS } from '../chat/naming.ts';
import { createBackgroundService, createBackgroundWorkflow, type BackgroundService } from '../background/service.ts';
import { createMemory } from '../memory/memory.ts';
import { createSkillsRuntime } from '../skills-admin/runtime.ts';
import { loadSystemSkills, SYSTEM_SKILLS_DIR } from '../skills-admin/system.ts';
import { isAppError } from '../errors/app-error.ts';
import { ensureMessageTexts } from '../search/message-texts.ts';
import { createFileStorage, KEEP_COPY_MS } from '../storage/engine.ts';
import { createPreviewCache, PREVIEW_CACHE_DIR, PREVIEW_CACHE_MAX_AGE_MS, PREVIEW_CACHE_MAX_BYTES, PREVIEW_CACHE_SUFFIX, startPreviewPurge } from '../preview/cache.ts';
import { sandboxRunner } from '../preview/convert.ts';
import { cleanOrgWork, ORG_SCRIPTS_DIR } from '../org-docs/blank.ts';
import { ORG_FILES_DIR, prepareOrgFiles } from '../org-docs/files.ts';
import { cleanWorkRoot, createPreviewService, PREVIEW_MAX_CONCURRENT, PREVIEW_MAX_UNPACKED_BYTES, PREVIEW_QUEUE_WAIT_MS } from '../preview/service.ts';
import { cleanDocTextWork, createDocTextService, DOC_TEXT_CACHE_DIR, DOC_TEXT_CACHE_MAX_AGE_MS, DOC_TEXT_CACHE_MAX_BYTES, DOC_TEXT_CACHE_SUFFIX } from '../doctext/service.ts';
import { IMAP_PORTS, SMTP_PORTS } from '@bba/contracts';
import { realDiscoverDeps } from '../mail/discover.ts';
import { realEndpoints } from '../mail/oauth.ts';
import { createMailService } from '../mail/service.ts';
import { createMailTrigger, POLL_INTERVAL_MS } from '../background/mail-trigger.ts';
import { createApp } from './app.ts';
import { logEvent } from './log.ts';
import { createChainService } from '../approvals/chains.ts';
import { createChainContinuation } from '../approvals/continue.ts';
import { createChainExecutor } from '../approvals/execute.ts';
import { createKnowledgeIndexer } from '../knowledge/indexer.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 3000;
const SKILLS_VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));

async function main(): Promise<void> {
  const env = readCoreEnv(process.env);
  const installation = await loadInstallation(ROOT, process.env);
  const db = createPool(env.DATABASE_URL);
  const box = createSecretBox(env.APP_ENCRYPTION_KEYS);
  // Multi-step approvals: every tool's «Да» may make a request (docs/specs/[20.11.2026]-multi-step-approvals.md).
  const chains = createChainService({ db, box });
  // The registry and the Mastra workflow need the background service, which itself needs them.
  const backgroundRef: { current?: BackgroundService } = {};
  const runner = { startAgentRun: (input: Parameters<BackgroundService['startAgentRun']>[0]) => backgroundRef.current!.startAgentRun(input) };
  const registry = await buildRegistry({ root: ROOT, installation, env: process.env, db, runner, chains });
  await migrate(env.DATABASE_URL, undefined, registry.pluginMigrations);
  const auth = createAuth({ db, authPool: createAuthPool(env.DATABASE_URL), secret: env.BETTER_AUTH_SECRET, publicUrl: env.APP_PUBLIC_URL });
  const agentIds = registry.ids();
  await ensureLimitSettings(db, installation.app.limits);
  await ensureApprovalSettings(db, installation.app.approvals);
  await ensureMaskingSettings(db, installation.app.masking.initialKinds);
  await ensureOrgName(db, installation.app.name);
  // «Что агенту можно» (spec, section 8.30): every agent of the installation has its row from the start.
  await ensureAgentAbilities(db, agentIds);
  // Notifications in the browser: the VAPID keys are made at the first start (docs/specs/[20.11.2026]-notifications.md).
  const notifications = await createNotifications({ db, box, timezone: installation.app.timezone, databaseUrl: env.DATABASE_URL });
  const litellm = createLiteLLMClient(env.LITELLM_URL, env.LITELLM_MASTER_KEY);
  const gateway = createModelGateway({ db, client: litellm, box, timezone: installation.app.timezone });
  await gateway.syncOrgBudget();
  const agentName = (id: string) => registry.get(id)?.passport.name ?? id;
  const writer = createGatewayWriter({ db, box, client: litellm, owner: GATEWAY_OWNER, fileModelIds: new Set(), timeouts: GATEWAY_TIMEOUTS });
  const accounts = createChatGptAccounts({ db, box, writer, auth: createChatGptAuthClient(OPENAI_AUTH_BASE), authDir: env.APP_CHATGPT_AUTH_DIR, timezone: installation.app.timezone });
  const models = createModelCatalog({ db, box, client: litellm, writer, accounts, agentName });
  // The accounts' login files go into the volume before LiteLLM gets deployments that read them.
  await accounts.prepare();
  // Our database is the source of truth: LiteLLM gets the admin's models at every start. A refusal
  // does not stop the server — «Нейросеть» shows what LiteLLM has not applied.
  await models.sync().then(
    (result) => logEvent('info', 'gateway_synced', { ...result }),
    (error: unknown) => logEvent('error', 'gateway_sync_failed', { code: 'APP_GATEWAY_SYNC_FAILED', error }),
  );
  const skillsDeps = { db, skillsDir: env.APP_SKILLS_DIR, systemSkills: loadSystemSkills(SYSTEM_SKILLS_DIR) };
  const skills = createSkillsRuntime(skillsDeps);
  await skills.prepare();
  const storage = new PostgresStore({ id: 'bba', connectionString: env.DATABASE_URL, schemaName: 'mastra' });
  // Mastra makes its tables here; the search keeps the text of its messages by a trigger on them (8.21).
  await storage.init();
  await ensureMessageTexts(db);
  const memory = createMemory(storage);
  // Program servers only with the container mcp-runner (docs/specs/[20.11.2026]-mcp-connections.md, F1).
  const mcpRunner = env.MCP_RUNNER_SOCKET && env.MCP_RUNNER_SECRET ? { socketPath: env.MCP_RUNNER_SOCKET, secret: env.MCP_RUNNER_SECRET } : null;
  const connections = createConnectionManager({ db, box, publicUrl: env.APP_PUBLIC_URL, connectors: registry.connectors, runner: mcpRunner , chains });
  // The commands of the sandbox and LibreOffice's runs: each its own queue for the whole installation (8.7, 8.27).
  const commandLimiter = createLimiter(MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS);
  const officeLimiter = createLimiter(PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS);
  const sandbox = {
    deps: { workspaceRoot: env.APP_WORKSPACE_DIR, skillsVenv: SKILLS_VENV, limiter: commandLimiter, orgFilesDir: join(tmpdir(), ORG_FILES_DIR) },
    isolation: assertIsolationAvailable(),
  };
  assertSandboxEnvironment(SKILLS_VENV);
  // Where the files are kept — the disk or the bucket the superadmin connected (spec, section 8.23).
  const files = createFileStorage({ db, box, workspaceRoot: env.APP_WORKSPACE_DIR, keepCopyMs: KEEP_COPY_MS });
  // PDFs of documents for the viewer: made in the sandbox, kept a week in the temporary folder (spec, 8.27).
  const previewCache = createPreviewCache({ dir: join(tmpdir(), PREVIEW_CACHE_DIR), suffix: PREVIEW_CACHE_SUFFIX, maxBytes: PREVIEW_CACHE_MAX_BYTES, maxAgeMs: PREVIEW_CACHE_MAX_AGE_MS });
  const preview = createPreviewService({
    storage: files,
    cache: previewCache,
    run: sandboxRunner({ venv: SKILLS_VENV, isolation: sandbox.isolation, readOnlyPaths: [] }),
    limiter: officeLimiter,
    workRoot: tmpdir(),
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  cleanWorkRoot(tmpdir());
  // The letterhead and the logo laid out for agents; blank.py and LibreOffice prepare an uploaded letterhead
  // (docs/specs/[20.11.2026]-org-letterhead.md).
  const orgFilesDir = sandbox.deps.orgFilesDir;
  await prepareOrgFiles(db, orgFilesDir);
  cleanOrgWork(tmpdir());
  const org = { filesDir: orgFilesDir, blank: { run: sandboxRunner({ venv: SKILLS_VENV, isolation: sandbox.isolation, readOnlyPaths: [ORG_SCRIPTS_DIR] }), limiter: officeLimiter, workRoot: tmpdir() } };
  // The text of attached documents for the model: made in the sandbox, kept a week like the viewer's PDFs (8.29).
  const docTextCache = createPreviewCache({ dir: join(tmpdir(), DOC_TEXT_CACHE_DIR), suffix: DOC_TEXT_CACHE_SUFFIX, maxBytes: DOC_TEXT_CACHE_MAX_BYTES, maxAgeMs: DOC_TEXT_CACHE_MAX_AGE_MS });
  const pptxScripts = join(SYSTEM_SKILLS_DIR, 'pptx', 'scripts');
  const docText = createDocTextService({
    run: sandboxRunner({ venv: SKILLS_VENV, isolation: sandbox.isolation, readOnlyPaths: [pptxScripts] }),
    officeLimiter,
    commandLimiter,
    cache: docTextCache,
    workRoot: tmpdir(),
    pptxScripts,
    timezone: installation.app.timezone,
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  cleanDocTextWork(tmpdir());
  // The mailboxes of employees (spec, section 8.24).
  const mail = createMailService({ db, box, publicUrl: env.APP_PUBLIC_URL, transport: { trustSelfSigned: false }, discover: realDiscoverDeps, endpoints: realEndpoints, ports: { imap: IMAP_PORTS, smtp: SMTP_PORTS } });
  const workflow = createBackgroundWorkflow(() => backgroundRef.current!);
  // The internet of agents (spec, section 8.30): the gateway's search, the server's reader of pages.
  cleanWebWork(tmpdir());
  const webTextCache = createPreviewCache({ dir: join(tmpdir(), WEB_TEXT_CACHE_DIR), suffix: DOC_TEXT_CACHE_SUFFIX, maxBytes: WEB_TEXT_CACHE_MAX_BYTES, maxAgeMs: WEB_TEXT_CACHE_MAX_AGE_MS });
  const webText = createDocTextService({
    run: sandboxRunner({ venv: SKILLS_VENV, isolation: sandbox.isolation, readOnlyPaths: [pptxScripts] }),
    officeLimiter,
    commandLimiter,
    cache: webTextCache,
    workRoot: tmpdir(),
    pptxScripts,
    timezone: installation.app.timezone,
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  const web = { searcher: createGatewaySearcher(gateway), reader: createPageReader({ docText: webText, timeoutMs: FETCH_MAX_MS }), translateError: (error: unknown, userId: string) => gateway.translateError(error, userId) };
  const mastra = createMastraRuntime({ registry, storage, memory, gateway, db, app: installation.app, workspaceRoot: env.APP_WORKSPACE_DIR, files, docText, orgFilesDir, signing: { run: org.blank.run, limiter: commandLimiter, workRoot: tmpdir(), chains }, connections, sandbox, mail, web, chains, workflows: { [workflow.id]: workflow } });
  const editor = { db, mastra, registry };
  const background = createBackgroundService({ db, memory, registry, gateway, editor, timezone: installation.app.timezone, skills, workspaceRoot: env.APP_WORKSPACE_DIR, storage: files, activity: notifications.activity });
  backgroundRef.current = background;
  const naming = { db, memory, modelConfig: (modelId: string, userId: string, agentId: string) => gateway.modelConfig(modelId, userId, agentId), waitAtEndMs: TITLE_WAIT_AT_END_MS, maxMs: NAMING_MAX_MS };
  // The knowledge base reads uploaded documents one at a time (docs/specs/[20.11.2026]-knowledge-base.md).
  const knowledgeIndexer = createKnowledgeIndexer({ db, docText });
  // Multi-step approvals: agreed requests run and end in the employee's conversation (docs/specs/[20.11.2026]-multi-step-approvals.md).
  const continuation = createChainContinuation({ db, memory, editor, timezone: installation.app.timezone, gateway, skills });
  const executor = createChainExecutor({ db, box, editor, skills, storage: files, continuation });
  const chat = { db, memory, registry, gateway, editor, workspaceRoot: env.APP_WORKSPACE_DIR, timezone: installation.app.timezone, skills, connections, naming, storage: files, mail, presence: notifications.presence, activity: notifications.activity, chains, copilot: createCopilotHandler({ editor }) };
  const app = createApp({ db, auth, publicUrl: env.APP_PUBLIC_URL, knownAgentIds: () => agentIds, gateway, models, accounts, skills: skillsDeps, ledgerSecret: env.LITELLM_CALLBACK_SECRET, connections, box, mcpRunner, chat, background, timezone: installation.app.timezone, storage: files, preview, org, notifications, approvals: { executor, continuation }, knowledge: { indexer: knowledgeIndexer } });
  await background.syncSchedules();
  // Answers a stopped server left in projects are settled into the trash; folders of gone projects go.
  await recoverProjectFolders(db, env.APP_WORKSPACE_DIR);
  // After the recovery: copies a stopped server left are stored into the bucket by the first pass.
  await files.start();
  const stopTrashPurge = startTrashPurge(db, files);
  const stopDraftsSweep = startDraftsSweep(files);
  const stopPreviewPurge = startPreviewPurge(previewCache, 'preview');
  const stopDocTextPurge = startPreviewPurge(docTextCache, 'doctext');
  const stopWebTextPurge = startPreviewPurge(webTextCache, 'webtext');
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => logEvent('info', 'server_started', { port: info.port, agents: [...agentIds] }));
  // Schedules fire only where Mastra's workers run (step 0, V5); missed fires get one catch-up run.
  await mastra.startWorkers();
  background.start();
  // Requests a stopped server left: started ones are «итог неизвестен», agreed ones run; then every 10 s.
  await executor.recover();
  executor.start();
  knowledgeIndexer.start();
  // Mail tasks: the mailboxes of their people are checked once a minute (docs/specs/[20.11.2026]-event-tasks.md).
  const mailTrigger = createMailTrigger({ db, mail, wake: () => background.wake(), intervalMs: POLL_INTERVAL_MS });
  mailTrigger.start();
  notifications.delivery.start();
  // Runs a stopped server left go on first, then fires missed while it was down.
  await background.recover();
  void background.catchUp().catch((error: unknown) => logEvent('error', 'background_catch_up_failed', { error }));
  for (const { plugin, trigger } of registry.triggers) {
    await Promise.resolve(trigger.start()).catch((error: unknown) => logEvent('error', 'plugin_trigger_start_failed', { plugin, error }));
  }

  // Docker stops the container with SIGTERM: finish what runs, then close connections.
  const shutdown = async (signal: string) => {
    logEvent('info', 'server_stopping', { signal });
    for (const { trigger } of registry.triggers) await Promise.resolve(trigger.stop());
    background.stop();
    mailTrigger.stop();
    executor.stop();
    knowledgeIndexer.stop();
    await notifications.delivery.stop();
    await notifications.live.stop();
    stopTrashPurge();
    stopDraftsSweep();
    stopPreviewPurge();
    stopDocTextPurge();
    stopWebTextPurge();
    files.stop();
    await mastra.stopWorkers();
    await connections.close();
    server.close();
    await db.end();
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, (s) => void shutdown(s));
}

main().catch((error: unknown) => {
  logEvent('error', 'server_start_failed', { code: isAppError(error) ? error.code : 'APP_INTERNAL', error });
  process.exit(1);
});
