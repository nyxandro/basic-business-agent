// Test helper: the real server on a fresh database, with helpers to create people and sign in.
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { createSecretBox } from '../crypto/secret-box.ts';
import { ensureOrgName } from '../admin/org-profile.ts';
import { createModelCatalog, type ModelCatalog } from '../models/catalog.ts';
import { createChatGptAccounts, type ChatGptAccounts } from '../models/chatgpt-accounts.ts';
import { createChatGptAuthClient, type ChatGptAuthClient } from '../models/chatgpt-login.ts';
import { createGatewayWriter } from '../models/gateway-writer.ts';
import { createModelGateway, type ModelGateway } from '../models/gateway.ts';
import { createLiteLLMClient, type LiteLLMClient } from '../models/litellm-client.ts';
import { ensureLimitSettings } from '../models/limits.ts';
import { reconcile } from '../models/gateway-sync.ts';
import { seedTestModels, TEST_CHATGPT_AUTH_DIR, TEST_MODEL_IDS } from '../models/test-catalog.ts';
import { AGENT_HEADER } from '../models/usage.ts';
import { createAuth, type Auth } from '../auth/auth.ts';
import { builtinRoleId } from '../auth/roles.ts';
import { acceptInvite, createInvite } from '../auth/users.ts';
import { migrate } from '../db/migrate.ts';
import { createAuthPool, createPool, type Db } from '../db/pool.ts';
import { createTestDatabase } from '../db/test-database.ts';
import { createApp } from './app.ts';
import type { AppEnv } from './http.ts';

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
  // Mastra memory of the conversations: tests create threads directly.
  memory: Memory;
  // Unpacked skills of this test installation.
  skillsDir: string;
  // What the skills routes and runtime of this installation work with (system skills included).
  skillsDeps: SkillsDeps;
  // Actions the test agent "sales" performed (its mail_send tool).
  sentMail: { to: string; text: string }[];
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
// The system skills of the core, read once per test process (spec, section 8.18).
const SYSTEM_SKILLS = loadSystemSkills(SYSTEM_SKILLS_DIR);

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
    registry?: (db: Db) => Promise<Registry>;
    // A test of an empty installation: no models in the catalog.
    noModels?: boolean;
    // Shortens the wait for the primary model's first chunk before the fallback answers.
    firstChunkMs?: number;
    // Shortens the limit of one model call (5 minutes in an installation).
    stepMs?: number;
    // The models behind the test agents (default: every model answers from `model`).
    modelConfig?: (modelId: string) => { url: string; apiKey: string };
    // OpenAI's login service for ChatGPT accounts (a fake, fake-chatgpt.ts). `gateway: true` writes
    // the login files into the folder the test LiteLLM reads; otherwise into a folder of this test.
    chatgpt?: { authBase: string; gateway?: boolean };
    // The agents get the employee's folder and the bubblewrap sandbox of an installation (the browser
    // stand: an agent makes a document there and shows it with «Скачать», spec section 8.18).
    sandbox?: boolean;
  } = {},
): Promise<TestApp> {
  const database = await createTestDatabase();
  await migrate(database.url);
  const db = createPool(database.url);
  const authPool = createAuthPool(database.url);
  const auth = createAuth({ db, authPool, secret: 'test-secret-that-is-long-enough-1234567890', publicUrl: TEST_PUBLIC_URL });
  const known = new Set(opts.knownAgentIds ?? ['assistant', 'sales']);
  await ensureLimitSettings(db, opts.limits ?? { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null });
  // Each test database gets its own LiteLLM team, so balances never leak between test files or runs.
  const teamId = `test-${database.url.split('/').pop()}`;
  const litellm = createLiteLLMClient(requireEnv('LITELLM_TEST_URL'), requireEnv('LITELLM_TEST_MASTER_KEY'), teamId);
  const box = createSecretBox(TEST_ENCRYPTION_KEYS);
  const gateway = createModelGateway({ db, client: litellm, box, timezone: 'Europe/Moscow' });
  await gateway.syncOrgBudget();
  if (!opts.noModels) await seedTestModels(db);
  const ledgerSecret = requireEnv('LITELLM_TEST_CALLBACK_SECRET');
  const connections = createConnectionManager({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS), publicUrl: TEST_PUBLIC_URL, connectors: opts.connectors ?? [] });
  await ensureMaskingSettings(db, []);
  await ensureOrgName(db, 'Альфа-Строй');
  const model = await startFakeModel({ ...(opts.modelFallback ? { fallback: opts.modelFallback } : {}), ...(opts.namingFallback ? { naming: opts.namingFallback } : {}) });
  const sentMail: { to: string; text: string }[] = [];
  const salesTools = {
    crm_search: applyApprovalPolicy(
      createTool({ id: 'crm_search', description: 'Найти сделки', inputSchema: z.object({ q: z.string() }), execute: () => Promise.resolve({ deals: 12 }) }),
      { readOnly: true, db },
    ),
    mail_send: applyApprovalPolicy(
      createTool({
        id: 'mail_send',
        description: 'Отправить письмо клиенту',
        inputSchema: z.object({ to: z.string().describe('Кому'), text: z.string().describe('Текст письма') }),
        execute: (input) => (sentMail.push(input), Promise.resolve({ sent: true })),
      }),
      { readOnly: false, db },
    ),
  };
  const assistant = testAgent('assistant', 'Помощник', {});
  if (opts.assistantSubagent) assistant.subagents = [testAgent('mailer', 'Почтальон', { mail_send: salesTools.mail_send })];
  const agents = [testAgent('sales', 'Продажи', salesTools), assistant].filter((a) => known.has(a.passport.id));
  const registry: Registry = opts.registry
    ? await opts.registry(db)
    : {
        agents,
        get: (id) => agents.find((a) => a.passport.id === id),
        ids: () => new Set(agents.map((a) => a.passport.id)),
        pluginMigrations: [],
        connectors: opts.connectors ?? [],
        triggers: [],
      };
  if (registry.pluginMigrations.length > 0) await migrate(database.url, undefined, registry.pluginMigrations);
  const storage = new PostgresStore({ id: 'test', connectionString: database.url, schemaName: 'mastra' });
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
  const backgroundRef: { current?: BackgroundService } = {};
  const workflow = createBackgroundWorkflow(() => backgroundRef.current!);
  const mastra = createMastraRuntime({
    registry,
    storage,
    memory,
    gateway: fakeGateway,
    db,
    app: { timezone: 'Europe/Moscow' },
    workspaceRoot,
    ...(opts.firstChunkMs ? { firstChunkMs: opts.firstChunkMs } : {}),
    ...(opts.stepMs ? { stepMs: opts.stepMs } : {}),
    connections,
    workflows: { [workflow.id]: workflow },
    ...(opts.sandbox
      ? { sandbox: { deps: { workspaceRoot, skillsVenv: SKILLS_VENV, limiter: createLimiter(MAX_CONCURRENT_COMMANDS, QUEUE_TIMEOUT_MS) }, isolation: assertIsolationAvailable() } }
      : {}),
  });
  const editor = { db, mastra, registry };
  const background = createBackgroundService({ db, memory, registry, gateway, editor, timezone: 'Europe/Moscow', skills });
  backgroundRef.current = background;
  // The naming call goes to the same model as the test agents.
  const naming = { db, memory, modelConfig: fakeGateway.modelConfig, waitAtEndMs: opts.titleWaitMs ?? TITLE_WAIT_AT_END_MS, maxMs: opts.namingMaxMs ?? NAMING_MAX_MS };
  const chat = { db, memory, registry, gateway, editor, workspaceRoot, timezone: 'Europe/Moscow', skills, connections, naming, copilot: createCopilotHandler({ editor }) };
  const agentName = (id: string) => registry.get(id)?.passport.name ?? id;
  // The mock models' deployments are in the test LiteLLM's file: the copying leaves them alone.
  const writer = createGatewayWriter({ db, box, client: litellm, owner: teamId, fileModelIds: TEST_MODEL_IDS });
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
  const app = createApp({ db, auth, publicUrl: TEST_PUBLIC_URL, knownAgentIds: () => (opts.registry ? registry.ids() : known), gateway, models, accounts, skills: skillsDeps, ledgerSecret, connections, chat, background, timezone: 'Europe/Moscow' });

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
    memory,
    skillsDir,
    skillsDeps,
    sentMail,
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
      // Deployments this test database put into the shared test LiteLLM leave with it.
      await reconcile(litellm, teamId, []);
      // The login files of this database's accounts; other test files share the gateway's folder.
      const { rows: own } = await db.query<{ id: string }>('SELECT id FROM app.chatgpt_accounts');
      for (const a of own) rmSync(join(chatgptAuthDir, `${a.id}.json`), { force: true });
      if (!opts.chatgpt?.gateway) rmSync(chatgptAuthDir, { recursive: true, force: true });
      await mastra.stopWorkers();
      await model.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
      removeSkillFolder(skillsDir);
      await connections.close();
      await db.end();
      await authPool.end();
      await database.drop();
    },
  };
}
