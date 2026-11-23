// Test helper: the real server on a fresh database, with helpers to create people and sign in.
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTool } from '@mastra/core/tools';
import { PostgresStore } from '@mastra/pg';
import type { Hono } from 'hono';
import { z } from 'zod';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import { createBackgroundService, createBackgroundWorkflow, type BackgroundService } from '../background/service.ts';
import { createCopilotHandler } from '../chat/copilot.ts';
import { NAMING_MAX_MS, TITLE_WAIT_AT_END_MS } from '../chat/naming.ts';
import type { Mastra } from '@mastra/core';
import type { AgentRuntime, Registry } from '../loader/registry.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import type { Memory } from '@mastra/memory';
import { createMemory } from '../memory/memory.ts';
import { startFakeModel, type FakeModel, type FakeRequest, type FakeTurn } from '../models/fake-openai.ts';
import { createMastraRuntime } from '../runtime/mastra.ts';
import { createSkillsRuntime } from '../skills-admin/runtime.ts';
import { removeSkillFolder } from '../skills-admin/archive.ts';
import type { SkillsDeps } from '../skills-admin/store.ts';
import { loadSystemSkills, SYSTEM_SKILLS_DIR } from '../skills-admin/system.ts';
import { createLimiter, MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS } from '../sandbox/limiter.ts';
import { assertIsolationAvailable } from '../sandbox/workspace.ts';
import { createConnectionManager, type ConnectionManager, type ConnectorRuntime } from '../connections/manager.ts';
import type { RunnerAccess } from '../connections/programs.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { ensureOrgName } from '../admin/org-profile.ts';
import { ensureAgentAbilities } from '../abilities/abilities.ts';
import { createModelCatalog, type ModelCatalog } from '../models/catalog.ts';
import { createChatGptAccounts, type ChatGptAccounts } from '../models/chatgpt-accounts.ts';
import { createChatGptAuthClient, type ChatGptAuthClient } from '../models/chatgpt-login.ts';
import { createGatewayWriter } from '../models/gateway-writer.ts';
import { createModelGateway, type ModelGateway } from '../models/gateway.ts';
import { createLiteLLMClient, type LiteLLMClient } from '../models/litellm-client.ts';
import { ensureLimitSettings } from '../models/limits.ts';
import { ensureApprovalSettings } from '../approvals/settings.ts';
import { createNotifications, type Notifications } from '../notifications/service.ts';
import type { PushTransport } from '../notifications/push.ts';
import { GATEWAY_TIMEOUTS, reconcile, type GatewayTimeouts } from '../models/gateway-sync.ts';
import { seedTestModels, TEST_CHATGPT_AUTH_DIR, TEST_MODEL_IDS } from '../models/test-catalog.ts';
import { AGENT_HEADER } from '../models/usage.ts';
import { createAuth, type Auth } from '../auth/auth.ts';
import { builtinRoleId } from '../auth/roles.ts';
import { acceptInvite, createInvite } from '../auth/users.ts';
import { migrate } from '../db/migrate.ts';
import { createAuthPool, createPool, type Db } from '../db/pool.ts';
import { createTestDatabase } from '../db/test-database.ts';
import { ensureMessageTexts } from '../search/message-texts.ts';
import { createFileStorage, KEEP_COPY_MS, type FileStorage } from '../storage/engine.ts';
import { createPreviewCache, PREVIEW_CACHE_MAX_AGE_MS, PREVIEW_CACHE_MAX_BYTES, PREVIEW_CACHE_SUFFIX } from '../preview/cache.ts';
import { sandboxRunner, type RunCommand } from '../preview/convert.ts';
import { ORG_SCRIPTS_DIR } from '../org-docs/blank.ts';
import { prepareOrgFiles } from '../org-docs/files.ts';
import { createPreviewService, PREVIEW_MAX_CONCURRENT, PREVIEW_MAX_UNPACKED_BYTES, PREVIEW_QUEUE_WAIT_MS } from '../preview/service.ts';
import { createDocTextService, DOC_TEXT_CACHE_MAX_AGE_MS, DOC_TEXT_CACHE_MAX_BYTES, DOC_TEXT_CACHE_SUFFIX } from '../doctext/service.ts';
import type { ObjectStore, S3Config } from '../storage/object-store.ts';
import { IMAP_PORTS, SMTP_PORTS } from '@bba/contracts';
import type { checkMailbox } from '../mail/client.ts';
import { TEST_MAIL_SERVERS } from '../mail/test-server.ts';
import { realDiscoverDeps, type DiscoverDeps } from '../mail/discover.ts';
import { realEndpoints, type EndpointsOf } from '../mail/oauth.ts';
import { createMailService, type MailService } from '../mail/service.ts';
import { createApp } from './app.ts';
import { appError } from '../errors/catalog.ts';
import type { PageReader } from '../web/fetch.ts';
import type { WebSearcher } from '../web/search.ts';
import type { AppEnv } from '../http/http.ts';
import type { TasksDeps } from '../background/tasks.ts';
import { createChainService, type ChainService } from '../approvals/chains.ts';
import { createChainContinuation } from '../chat/chain-continuation.ts';
import { createChainExecutor } from '../approvals/execute.ts';
import type { ChainExecutor } from '../approvals/execute.ts';
import { createKnowledgeIndexer } from '../knowledge/indexer.ts';
import type { KnowledgeIndexer } from '../knowledge/indexer.ts';

export const TEST_PUBLIC_URL = 'http://localhost:8080';
export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestApp {
  app: Hono<AppEnv>;
  db: Db;
  auth: Auth;
  gateway: ModelGateway;
  // «Нейросеть» of the test installation; its deployments in the test LiteLLM carry `gatewayOwner`.
  models: ModelCatalog;
  accounts: ChatGptAccounts;
  // Where this installation writes the login files of its ChatGPT accounts.
  chatgptAuthDir: string;
  gatewayOwner: string;
  litellm: LiteLLMClient;
  ledgerSecret: string;
  connections: ConnectionManager;
  // The model behind the test agents: script its answers, read what it received.
  model: FakeModel;
  mastra: Mastra;
  registry: Registry;
  background: BackgroundService;
  workspaceRoot: string;
  // Where the files are kept: the disk, or a fake bucket the test connects (spec, section 8.23).
  storage: FileStorage;
  // The mailboxes of employees (spec, section 8.24).
  mail: MailService;
  // Mastra memory of the conversations: tests create threads directly.
  memory: Memory;
  // Unpacked skills of this test installation.
  skillsDir: string;
  // What the skills routes and runtime of this installation work with (system skills included).
  skillsDeps: SkillsDeps;
  // Where the letterhead and the logo are laid out for agents (docs/specs/[20.11.2026]-org-letterhead.md).
  orgFilesDir: string;
  // Actions the test agent "sales" performed (its mail_send tool).
  sentMail: { to: string; text: string }[];
  // Notifications of this installation: presence, the delivery (tests call `deliverDue` themselves).
  notifications: Notifications;
  // What «Режимы работы» works with in this installation (core/background/tasks.ts).
  tasks: TasksDeps;
  // Multi-step approvals: tests take agreed requests themselves (`executor.idle()`).
  approvals: { executor: ChainExecutor };
  // The knowledge base: tests read uploaded documents themselves (`indexer.idle()`).
  knowledge: { indexer: KnowledgeIndexer };
  createUser(input: { email: string; name?: string; roleIds?: string[]; departmentIds?: string[]; password?: string }): Promise<string>;
  signIn(email: string, password?: string, ip?: string): Promise<string>;
  call(method: string, path: string, opts?: { cookie?: string; body?: unknown; ip?: string }): Promise<Response>;
  roleId(builtin: 'superadmin' | 'employee'): Promise<string>;
  close(): Promise<void>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: start the dev stand (pnpm dev:db) and copy .env.example to .env`);
  return value;
}

const SKILLS_VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));
const PPTX_SCRIPTS = join(SYSTEM_SKILLS_DIR, 'pptx', 'scripts');
// A test app without the sandbox runs no program: a document that needs one gives «не разобрался».
const noProgram: RunCommand = () => Promise.reject(new Error('this test app runs no program of the sandbox (createTestApp({ sandbox }) or docTextRun)'));
// The system skills of the core, read once per test process (spec, section 8.18).
const SYSTEM_SKILLS = loadSystemSkills(SYSTEM_SKILLS_DIR);

// The internet of a test app without fakes: every search and every page fails, loudly and with its code.
const noSearch: WebSearcher = { search: () => Promise.reject(appError('APP_WEB_SEARCH_FAILED', 'this test app has no search (createTestApp({ web }))')) };
const noPages: PageReader = { read: () => Promise.reject(appError('APP_WEB_FETCH_HTTP', 'this test app opens no page (createTestApp({ web }))')) };

export const TEST_ENCRYPTION_KEYS = `1:${Buffer.alloc(32, 7).toString('base64')}`;

function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

function testAgent(id: string, name: string, tools: AgentRuntime['tools']): AgentRuntime {
  return {
    passport: { id, name, description: `Тестовый агент ${name}`, plugins: [], readOnly: [], starters: ['Покажи мои сделки'] },
    dir: `/agents/${id}`,
    instructions: `Ты тестовый агент «${name}».`,
    tools,
    readOnly: new Set(),
    subagents: [],
    connectorIds: [],
    toolSystems: {},
  };
}

// LibreOffice's stand-in for the tests of routes: a small PDF naming the file it was made of.
const stubPdf: RunCommand = (cwd, _program, args) => {
  mkdirSync(join(cwd, 'out'), { recursive: true });
  writeFileSync(join(cwd, 'out', 'source.pdf'), `%PDF-1.4 stand-in of ${args.at(-1)}`);
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
};

export async function createTestApp(
  opts: {
    knownAgentIds?: string[];
    limits?: Parameters<typeof ensureLimitSettings>[1];
    connectors?: ConnectorRuntime[];
    modelFallback?: (req: FakeRequest) => FakeTurn;
    // The answer to the naming call of a conversation when no test scripted one (default «-»).
    namingFallback?: (req: FakeRequest) => FakeTurn;
    // Shortens how long the end of an answer waits for the naming call (3 s in an installation).
    titleWaitMs?: number;
    // Shortens the limit of one naming call (60 s in an installation).
    namingMaxMs?: number;
    // Gives the test agent "assistant" a sub-agent "mailer" that sends letters (needs "Да").
    assistantSubagent?: boolean;
    // A real installation instead of the test agents (e.g. the demo of the repository); its plugin
    // migrations are applied to the test database.
    registry?: (db: Db, chains: ChainService) => Promise<Registry>;
    // A test of an empty installation: no models in the catalog.
    noModels?: boolean;
    // Shortens the wait for the primary model's first chunk before the fallback answers.
    firstChunkMs?: number;
    // Shortens the limit of one model call (5 minutes in an installation).
    stepMs?: number;
    // Shortens how long the gateway waits on a silent provider (GATEWAY_TIMEOUTS in an installation).
    gatewayTimeouts?: GatewayTimeouts;
    // The models behind the test agents (default: every model answers from `model`).
    modelConfig?: (modelId: string) => { url: string; apiKey: string };
    // OpenAI's login service for ChatGPT accounts (a fake, fake-chatgpt.ts). `gateway: true` writes
    // the login files into the folder the test LiteLLM reads; otherwise into a folder of this test.
    chatgpt?: { authBase: string; gateway?: boolean };
    // The agents get the employee's folder and the bubblewrap sandbox of an installation (the browser
    // stand: an agent makes a document there and shows it with «Скачать», spec section 8.18).
    sandbox?: boolean;
    // The internet of agents (spec, section 8.30): without it the search and the pages of this test app fail
    // with their own codes — a test of the internet gives its fakes.
    web?: { searcher?: WebSearcher; reader?: PageReader };
    // How long an unused copy of a folder stays when files are in a bucket (KEEP_COPY_MS in an installation).
    keepCopyMs?: number;
    connectStore?: (config: S3Config) => ObjectStore;
    // How the mail settings of a domain are found and where the services' sign-in is (fakes in tests).
    mailDiscover?: DiscoverDeps;
    mailEndpoints?: EndpointsOf;
    mailCheck?: typeof checkMailbox;
    // The container of program servers, started by the test itself (core/mcp-runner/runner.ts).
    mcpRunner?: RunnerAccess;
    // How the viewer's PDF is made (spec, section 8.27): without `sandbox`, a stand-in that writes a small PDF.
    previewRun?: RunCommand;
    // How the text of an attached document is made (spec, section 8.29): without `sandbox`, no program runs —
    // plain text, letters and pages without programs still give their text.
    docTextRun?: RunCommand;
    // How an uploaded letterhead is prepared (blank.py and LibreOffice): without `sandbox`, no program runs.
    orgRun?: RunCommand;
    // The terms of questions «Да» in hours (config/app.ts in an installation: 24 and 72).
    approvals?: { initialChatTtlHours: number; initialBackgroundTtlHours: number };
    // The push service of browsers: a fake (core/notifications/fake-push.ts); without it a push goes nowhere — the
    // test app refuses every address as not a push service.
    push?: { transport: PushTransport; testOrigin: string };
    // The clock of presence and of the delivery of notifications.
    now?: () => Date;
    // The browser stand runs at any hour: its pushes never wait for the morning.
    quietHours?: false;
  } = {},
): Promise<TestApp> {
  const database = await createTestDatabase();
  await migrate(database.url);
  const db = createPool(database.url);
  const authPool = createAuthPool(database.url);
  const auth = createAuth({ db, authPool, secret: 'test-secret-that-is-long-enough-1234567890', publicUrl: TEST_PUBLIC_URL });
  const known = new Set(opts.knownAgentIds ?? ['assistant', 'sales']);
  await ensureLimitSettings(db, opts.limits ?? { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null });
  await ensureApprovalSettings(db, opts.approvals ?? { initialChatTtlHours: 24, initialBackgroundTtlHours: 72 });
  // Each test database gets its own LiteLLM team, so balances never leak between test files or runs.
  const teamId = `test-${database.url.split('/').pop()}`;
  const litellm = createLiteLLMClient(requireEnv('LITELLM_TEST_URL'), requireEnv('LITELLM_TEST_MASTER_KEY'), teamId);
  const box = createSecretBox(TEST_ENCRYPTION_KEYS);
  const chains = createChainService({ db, box });
  const noPush: PushTransport = () => Promise.reject(new Error('this test app has no push service (createTestApp({ push }))'));
  const notifications = await createNotifications({
    db,
    box,
    timezone: 'Europe/Moscow',
    databaseUrl: database.url,
    push: opts.push ?? { transport: noPush, testOrigin: 'http://push.invalid' },
    ...(opts.quietHours === false ? { quietHours: false as const } : {}),
    ...(opts.now ? { now: opts.now, clock: () => opts.now!().getTime() } : {}),
  });
  const gateway = createModelGateway({ db, client: litellm, box, timezone: 'Europe/Moscow' });
  await gateway.syncOrgBudget();
  if (!opts.noModels) await seedTestModels(db);
  const ledgerSecret = requireEnv('LITELLM_TEST_CALLBACK_SECRET');
  const connections = createConnectionManager({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS), publicUrl: TEST_PUBLIC_URL, connectors: opts.connectors ?? [], runner: opts.mcpRunner ?? null, chains });
  await ensureMaskingSettings(db, []);
  await ensureOrgName(db, 'Альфа-Строй');
  const model = await startFakeModel({ ...(opts.modelFallback ? { fallback: opts.modelFallback } : {}), ...(opts.namingFallback ? { naming: opts.namingFallback } : {}) });
  const sentMail: { to: string; text: string }[] = [];
  const salesTools = {
    crm_search: applyApprovalPolicy(
      createTool({ id: 'crm_search', description: 'Найти сделки', inputSchema: z.object({ q: z.string() }), execute: () => Promise.resolve({ deals: 12 }) }),
      { readOnly: true, db, chains },
    ),
    mail_send: applyApprovalPolicy(
      createTool({
        id: 'mail_send',
        description: 'Отправить письмо клиенту',
        inputSchema: z.object({ to: z.string().describe('Кому'), text: z.string().describe('Текст письма') }),
        execute: (input) => (sentMail.push(input), Promise.resolve({ sent: true })),
      }),
      { readOnly: false, db, chains },
    ),
  };
  const assistant = testAgent('assistant', 'Помощник', {});
  if (opts.assistantSubagent) assistant.subagents = [testAgent('mailer', 'Почтальон', { mail_send: salesTools.mail_send })];
  const agents = [testAgent('sales', 'Продажи', salesTools), assistant].filter((a) => known.has(a.passport.id));
  const registry: Registry = opts.registry
    ? await opts.registry(db, chains)
    : {
        agents,
        get: (id) => agents.find((a) => a.passport.id === id),
        ids: () => new Set(agents.map((a) => a.passport.id)),
        pluginMigrations: [],
        connectors: opts.connectors ?? [],
        triggers: [],
      };
  if (registry.pluginMigrations.length > 0) await migrate(database.url, undefined, registry.pluginMigrations);
  await ensureAgentAbilities(db, registry.ids());
  const storage = new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' });
  await storage.init();
  await ensureMessageTexts(db);
  const memory = createMemory(storage);
  // The test agents call the fake model directly, not through LiteLLM, with the header LiteLLM gets.
  const fakeGateway = {
    modelConfig: (modelId: string, _userId: string, agentId: string) =>
      Promise.resolve({ providerId: 'fake', modelId, ...(opts.modelConfig?.(modelId) ?? { url: model.url, apiKey: 'x' }), headers: { [AGENT_HEADER]: agentId } }),
  };
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'bba-test-ws-'));
  const skillsDir = mkdtempSync(join(tmpdir(), 'bba-test-skills-'));
  const skillsDeps = { db, skillsDir, systemSkills: SYSTEM_SKILLS };
  const skills = createSkillsRuntime(skillsDeps);
  const mail = createMailService({
    db,
    box,
    publicUrl: TEST_PUBLIC_URL,
    // The test mail server has a self-signed certificate.
    transport: { trustSelfSigned: true },
    discover: opts.mailDiscover ?? realDiscoverDeps,
    endpoints: opts.mailEndpoints ?? realEndpoints,
    ...(opts.mailCheck ? { check: opts.mailCheck } : {}),
    // The test mail server's own ports besides the mail ports (deploy/compose.dev.yaml).
    ports: { imap: [...IMAP_PORTS, TEST_MAIL_SERVERS.imap.port], smtp: [...SMTP_PORTS, TEST_MAIL_SERVERS.smtp.port] },
  });
  const files = createFileStorage({ db, box, workspaceRoot, keepCopyMs: opts.keepCopyMs ?? KEEP_COPY_MS, ...(opts.connectStore ? { connectStore: opts.connectStore } : {}) });
  await files.start();
  const backgroundRef: { current?: BackgroundService } = {};
  const workflow = createBackgroundWorkflow(() => backgroundRef.current!);
  const previewRoot = mkdtempSync(join(tmpdir(), 'bba-test-preview-'));
  // The letterhead and the logo laid out for the agents of this test installation.
  const orgFilesDir = join(previewRoot, 'org-files');
  await prepareOrgFiles(db, orgFilesDir);
  // LibreOffice's runs of the viewer and of the text of documents share one queue, as in core/server/main.ts.
  const officeLimiter = createLimiter(PREVIEW_MAX_CONCURRENT, PREVIEW_QUEUE_WAIT_MS);
  const commandLimiter = createLimiter(MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS);
  const docText = createDocTextService({
    run: opts.sandbox ? sandboxRunner({ venv: SKILLS_VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [PPTX_SCRIPTS] }) : (opts.docTextRun ?? noProgram),
    officeLimiter,
    commandLimiter,
    cache: createPreviewCache({ dir: join(previewRoot, 'texts'), suffix: DOC_TEXT_CACHE_SUFFIX, maxBytes: DOC_TEXT_CACHE_MAX_BYTES, maxAgeMs: DOC_TEXT_CACHE_MAX_AGE_MS }),
    workRoot: previewRoot,
    pptxScripts: PPTX_SCRIPTS,
    timezone: 'Europe/Moscow',
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  const mastra = createMastraRuntime({
    chains,
    registry,
    storage,
    memory,
    gateway: fakeGateway,
    db,
    app: { timezone: 'Europe/Moscow' },
    workspaceRoot,
    files,
    docText,
    orgFilesDir,
    ...(opts.firstChunkMs ? { firstChunkMs: opts.firstChunkMs } : {}),
    ...(opts.stepMs ? { stepMs: opts.stepMs } : {}),
    connections,
    mail,
    web: {
      searcher: opts.web?.searcher ?? noSearch,
      reader: opts.web?.reader ?? noPages,
      translateError: (error: unknown, userId: string) => gateway.translateError(error, userId),
    },
    workflows: { [workflow.id]: workflow },
    ...(opts.sandbox
      ? {
          sandbox: { deps: { workspaceRoot, skillsVenv: SKILLS_VENV, limiter: commandLimiter, orgFilesDir }, isolation: assertIsolationAvailable() },
          signing: { run: sandboxRunner({ venv: SKILLS_VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [ORG_SCRIPTS_DIR] }), limiter: commandLimiter, workRoot: previewRoot, chains },
        }
      : {}),
  });
  const editor = { db, mastra, registry };
  const background = createBackgroundService({ db, memory, registry, gateway, editor, timezone: 'Europe/Moscow', skills, workspaceRoot, storage: files, activity: notifications.activity });
  backgroundRef.current = background;
  // The naming call goes to the same model as the test agents.
  const naming = { db, memory, modelConfig: fakeGateway.modelConfig, waitAtEndMs: opts.titleWaitMs ?? TITLE_WAIT_AT_END_MS, maxMs: opts.namingMaxMs ?? NAMING_MAX_MS };
  // The knowledge base reads uploaded documents one at a time (docs/specs/[20.11.2026]-knowledge-base.md).
  const knowledgeIndexer = createKnowledgeIndexer({ db, docText });
  // Multi-step approvals: agreed requests run and end in the employee's conversation (docs/specs/[20.11.2026]-multi-step-approvals.md).
  const continuation = createChainContinuation({ db, memory, editor, timezone: 'Europe/Moscow', gateway, skills, storage: files, workspaceRoot: workspaceRoot, activity: notifications.activity });
  const executor = createChainExecutor({ db, box, editor, skills, storage: files, continuation });
  const chat = { db, memory, registry, gateway, editor, workspaceRoot, timezone: 'Europe/Moscow', skills, connections, naming, storage: files, mail, presence: notifications.presence, activity: notifications.activity, chains, copilot: createCopilotHandler({ editor }) };
  const agentName = (id: string) => registry.get(id)?.passport.name ?? id;
  // The mock models' deployments are in the test LiteLLM's file: the copying leaves them alone.
  const writer = createGatewayWriter({ db, box, client: litellm, owner: teamId, fileModelIds: TEST_MODEL_IDS, timeouts: opts.gatewayTimeouts ?? GATEWAY_TIMEOUTS });
  const chatgptAuthDir = opts.chatgpt?.gateway ? TEST_CHATGPT_AUTH_DIR : mkdtempSync(join(tmpdir(), 'bba-test-chatgpt-'));
  mkdirSync(chatgptAuthDir, { recursive: true });
  const chatgptAuth: ChatGptAuthClient = opts.chatgpt
    ? createChatGptAuthClient(opts.chatgpt.authBase)
    : {
        verifyUrl: 'about:blank',
        requestDeviceCode: () => Promise.reject(new Error('this test app has no fake OpenAI login (createTestApp({ chatgpt }))')),
        poll: () => Promise.reject(new Error('this test app has no fake OpenAI login (createTestApp({ chatgpt }))')),
      };
  const accounts = createChatGptAccounts({ db, box, writer, auth: chatgptAuth, authDir: chatgptAuthDir, timezone: 'Europe/Moscow' });
  const models = createModelCatalog({ db, box, client: litellm, writer, accounts, agentName });
  const preview = createPreviewService({
    storage: files,
    cache: createPreviewCache({ dir: join(previewRoot, 'cache'), suffix: PREVIEW_CACHE_SUFFIX, maxBytes: PREVIEW_CACHE_MAX_BYTES, maxAgeMs: PREVIEW_CACHE_MAX_AGE_MS }),
    run: opts.sandbox ? sandboxRunner({ venv: SKILLS_VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [] }) : (opts.previewRun ?? stubPdf),
    limiter: officeLimiter,
    workRoot: previewRoot,
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  const org = {
    filesDir: orgFilesDir,
    blank: { run: opts.sandbox ? sandboxRunner({ venv: SKILLS_VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [ORG_SCRIPTS_DIR] }) : (opts.orgRun ?? noProgram), limiter: officeLimiter, workRoot: previewRoot },
  };
  const app = createApp({ db, auth, publicUrl: TEST_PUBLIC_URL, knownAgentIds: () => (opts.registry ? registry.ids() : known), gateway, models, accounts, skills: skillsDeps, ledgerSecret, connections, box, mcpRunner: opts.mcpRunner ?? null, chat, background, timezone: 'Europe/Moscow', storage: files, preview, org, notifications, approvals: { executor, continuation }, knowledge: { indexer: knowledgeIndexer } });

  const call: TestApp['call'] = (method, path, o = {}) =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: {
          ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
          origin: TEST_PUBLIC_URL,
          'x-forwarded-for': o.ip ?? randomIp(),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
      }),
    );

  const roleId: TestApp['roleId'] = (builtin) => builtinRoleId(db, builtin);

  return {
    app,
    db,
    auth,
    gateway,
    models,
    accounts,
    chatgptAuthDir,
    gatewayOwner: teamId,
    litellm,
    ledgerSecret,
    connections,
    model,
    mastra,
    registry,
    background,
    workspaceRoot,
    storage: files,
    mail,
    memory,
    skillsDir,
    skillsDeps,
    orgFilesDir,
    sentMail,
    notifications,
    tasks: { db, registry, background, timezone: 'Europe/Moscow', box, publicUrl: TEST_PUBLIC_URL },
    approvals: { executor },
    knowledge: { indexer: knowledgeIndexer },
    call,
    roleId,
    async createUser({ email, name, roleIds, departmentIds, password }) {
      const roles = roleIds ?? [await roleId('employee')];
      const issued = await createInvite(db, null, { email, name: name ?? email, roleIds: roles, departmentIds: departmentIds ?? [] });
      await acceptInvite(db, auth, issued.token, password ?? TEST_PASSWORD);
      const { rows } = await db.query<{ id: string }>('SELECT "id" FROM app."user" WHERE "email" = $1', [email]);
      return rows[0]!.id;
    },
    async signIn(email, password = TEST_PASSWORD, ip) {
      const res = await call('POST', '/app/api/auth/sign-in/email', { body: { email, password }, ...(ip ? { ip } : {}) });
      if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
      const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      if (!cookie) throw new Error('sign-in returned no cookie');
      return cookie;
    },
    async close() {
      background.stop();
      await notifications.live.stop();
      files.stop();
      // Deployments this test database put into the shared test LiteLLM leave with it.
      await reconcile(litellm, teamId, []);
      // The login files of this database's accounts; other test files share the gateway's folder.
      const { rows: own } = await db.query<{ id: string }>('SELECT id FROM app.chatgpt_accounts');
      for (const a of own) rmSync(join(chatgptAuthDir, `${a.id}.json`), { force: true });
      if (!opts.chatgpt?.gateway) rmSync(chatgptAuthDir, { recursive: true, force: true });
      await mastra.stopWorkers();
      await model.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(previewRoot, { recursive: true, force: true });
      removeSkillFolder(skillsDir);
      await connections.close();
      await db.end();
      await authPool.end();
      await database.drop();
    },
  };
}
