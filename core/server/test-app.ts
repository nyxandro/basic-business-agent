// Test helper: the real server on a fresh database, with helpers to create people and sign in.
import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { PostgresStore } from '@mastra/pg';
import type { Hono } from 'hono';
import { z } from 'zod';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import { createBackgroundService, createBackgroundWorkflow, type BackgroundService } from '../background/service.ts';
import { createCopilotHandler } from '../chat/copilot.ts';
import type { Mastra } from '@mastra/core';
import type { AgentRuntime, Registry } from '../loader/registry.ts';
import { ensureMaskingSettings } from '../masking/settings.ts';
import { createMemory } from '../memory/memory.ts';
import { startFakeModel, type FakeModel, type FakeRequest, type FakeTurn } from '../models/fake-openai.ts';
import { createMastraRuntime } from '../runtime/mastra.ts';
import { createConnectionManager, type ConnectionManager, type ConnectorRuntime } from '../connections/manager.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { createModelGateway, type ModelGateway } from '../models/gateway.ts';
import { createLiteLLMClient, type LiteLLMClient } from '../models/litellm-client.ts';
import { ensureLimitSettings } from '../models/limits.ts';
import { TEST_CATALOG } from '../models/test-catalog.ts';
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
  litellm: LiteLLMClient;
  ledgerSecret: string;
  connections: ConnectionManager;
  // The model behind the test agents: script its answers, read what it received.
  model: FakeModel;
  mastra: Mastra;
  background: BackgroundService;
  workspaceRoot: string;
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

export const TEST_ENCRYPTION_KEYS = `1:${Buffer.alloc(32, 7).toString('base64')}`;

function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

function testAgent(id: string, name: string, tools: AgentRuntime['tools']): AgentRuntime {
  return {
    passport: { id, name, description: `Тестовый агент ${name}`, model: 'test-paid', plugins: [], readOnly: [], starters: ['Покажи мои сделки'] },
    dir: `/agents/${id}`,
    instructions: `Ты тестовый агент «${name}».`,
    tools,
    readOnly: new Set(),
    skillDirs: [],
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
    // Gives the test agent "assistant" a sub-agent "mailer" that sends letters (needs "Да").
    assistantSubagent?: boolean;
    // A real installation instead of the test agents (e.g. the demo of the repository); its plugin
    // migrations are applied to the test database.
    registry?: (db: Db) => Promise<Registry>;
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
  const gateway = createModelGateway({ db, client: litellm, box: createSecretBox(TEST_ENCRYPTION_KEYS), catalog: TEST_CATALOG, timezone: 'Europe/Moscow' });
  await gateway.syncOrgBudget();
  const ledgerSecret = requireEnv('LITELLM_TEST_CALLBACK_SECRET');
  const connections = createConnectionManager({ db, box: createSecretBox(TEST_ENCRYPTION_KEYS), publicUrl: TEST_PUBLIC_URL, connectors: opts.connectors ?? [] });
  await ensureMaskingSettings(db, []);
  const model = await startFakeModel(opts.modelFallback ? { fallback: opts.modelFallback } : {});
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
        inputSchema: z.object({ to: z.string(), text: z.string() }),
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
  const fakeGateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
  const backgroundRef: { current?: BackgroundService } = {};
  const workflow = createBackgroundWorkflow(() => backgroundRef.current!);
  const mastra = createMastraRuntime({
    registry,
    storage,
    memory,
    gateway: fakeGateway,
    db,
    app: { name: 'Альфа-Строй', timezone: 'Europe/Moscow' },
    connections,
    workflows: { [workflow.id]: workflow },
  });
  const editor = { db, mastra, registry };
  const background = createBackgroundService({ db, memory, registry, gateway, editor, timezone: 'Europe/Moscow' });
  backgroundRef.current = background;
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'bba-test-ws-'));
  const chat = { db, memory, registry, gateway, editor, workspaceRoot, copilot: createCopilotHandler({ editor }) };
  const app = createApp({ db, auth, publicUrl: TEST_PUBLIC_URL, knownAgentIds: () => (opts.registry ? registry.ids() : known), gateway, ledgerSecret, connections, chat, background, timezone: 'Europe/Moscow' });

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
    litellm,
    ledgerSecret,
    connections,
    model,
    mastra,
    background,
    workspaceRoot,
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
      await mastra.stopWorkers();
      await model.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
      await connections.close();
      await db.end();
      await authPool.end();
      await database.drop();
    },
  };
}
