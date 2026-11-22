// The HTTP server of the installation. Only our routes exist: Mastra's built-in routes are never
// registered (no MastraServer.init()), and everything that matches nothing answers 404 (spec, 17.6).
import { Hono } from 'hono';
import { registerModelRoutes } from '../admin/routes/models.ts';
import { registerTaskRoutes } from '../admin/routes/tasks.ts';
import { registerHookRoutes } from '../background/hooks.ts';
import { registerPeopleRoutes } from '../admin/routes/people.ts';
import { registerRoleRoutes } from '../admin/routes/roles.ts';
import { registerUsageReportRoutes } from '../admin/routes/usage.ts';
import { registerAdminSections } from '../admin/routes/sections.ts';
import type { Auth } from '../auth/auth.ts';
import { registerBackgroundRoutes } from '../background/routes.ts';
import type { BackgroundService } from '../background/service.ts';
import { registerAuthRoutes } from '../auth/routes.ts';
import type { CopilotHandler } from '../chat/copilot.ts';
import { registerChatRoutes } from '../chat/routes.ts';
import type { ChatDeps } from '../chat/run.ts';
import { registerMcpAdminRoutes } from '../connections/admin-routes.ts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { RunnerAccess } from '../connections/programs.ts';
import { registerConnectionRoutes } from '../connections/routes.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { ModelCatalog } from '../models/catalog.ts';
import type { ChatGptAccounts } from '../models/chatgpt-accounts.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { registerUsageRoutes } from '../models/routes.ts';
import { registerProjectRoutes } from '../projects/routes.ts';
import { registerFileSearchRoutes } from '../search/file-routes.ts';
import { registerSearchRoutes } from '../search/routes.ts';
import { registerVoiceRoutes } from '../voice/routes.ts';
import { registerSkillRoutes } from '../skills-admin/routes.ts';
import { registerInterfaceRoutes } from '../interface-settings/routes.ts';
import type { PreviewService } from '../preview/service.ts';
import type { FileStorage } from '../storage/engine.ts';
import { registerStorageRoutes } from '../storage/routes.ts';
import { registerMailRoutes } from '../mail/routes.ts';
import type { Notifications } from '../notifications/service.ts';
import { registerNotificationRoutes } from '../notifications/routes.ts';
import { registerMemoryRoutes } from '../memory/routes.ts';
import { registerOrgDocsRoutes, type OrgDocsRouteDeps } from '../org-docs/routes.ts';
import type { SkillsDeps } from '../skills-admin/store.ts';
import { requireSession } from './guards.ts';
import { errorJson, handleError, type AppEnv } from './http.ts';
import { registerChainRoutes } from '../approvals/chain-routes.ts';
import type { ChainContinuation } from '../approvals/continue.ts';
import { describeTools } from '../approvals/describe.ts';
import type { ChainExecutor } from '../approvals/execute.ts';
import { createMailTools } from '../mail/tools.ts';
import type { KnowledgeIndexer } from '../knowledge/indexer.ts';
import { registerKnowledgeRoutes } from '../knowledge/routes.ts';
import { registerSupportRoutes } from '../support/routes.ts';
import { registerExampleRoutes } from '../knowledge/examples.ts';
import type { ActionDescription } from '@bba/contracts';

export interface ServerDeps {
  db: Db;
  auth: Auth;
  publicUrl: string;
  knownAgentIds: () => ReadonlySet<string>;
  gateway: ModelGateway;
  models: ModelCatalog;
  accounts: ChatGptAccounts;
  skills: SkillsDeps;
  ledgerSecret: string;
  connections: ConnectionManager;
  // Seals the secrets of MCP servers the admin adds (docs/specs/[20.11.2026]-mcp-connections.md).
  box: SecretBox;
  // The container of program servers (mcp-runner); null — the installation has none.
  mcpRunner: RunnerAccess | null;
  chat: ChatDeps & { copilot: CopilotHandler };
  background: BackgroundService;
  timezone: string;
  // Where the files of conversations and projects are kept (spec, section 8.23).
  storage: FileStorage;
  // PDFs of Word, Excel and PowerPoint files for the viewer (spec, section 8.27).
  preview: PreviewService;
  // The letterhead, the logo, the stamp and the signature (docs/specs/[20.11.2026]-org-letterhead.md).
  org: Omit<OrgDocsRouteDeps, 'db'>;
  // Notifications in the browser (docs/specs/[20.11.2026]-notifications.md).
  notifications: Notifications;
  // Multi-step approvals: who executes agreed requests and writes their outcome (docs/specs/[20.11.2026]-multi-step-approvals.md).
  approvals: { executor: ChainExecutor; continuation: ChainContinuation };
  // The knowledge base: the reading of uploaded documents (docs/specs/[20.11.2026]-knowledge-base.md).
  knowledge: { indexer: KnowledgeIndexer };
}

export function createApp(deps: ServerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => errorJson(c, appError('APP_NOT_FOUND', `no route ${c.req.method} ${c.req.path}`)));

  app.use('/app/api/*', requireSession(deps.db, deps.auth));

  app.get('/app/api/health', async (c) => {
    await deps.db.query('SELECT 1');
    if (!(await deps.gateway.health())) throw appError('APP_MODEL_GATEWAY_UNAVAILABLE', 'LiteLLM liveliness check failed');
    return c.json({ status: 'ok' });
  });

  registerAuthRoutes(app, deps);
  registerPeopleRoutes(app, {
    db: deps.db,
    publicUrl: deps.publicUrl,
    gateway: deps.gateway,
    deletion: { db: deps.db, memory: deps.chat.memory, gateway: deps.gateway, workspaceRoot: deps.chat.workspaceRoot, storage: deps.storage },
  });
  registerRoleRoutes(app, deps);
  registerUsageRoutes(app, { db: deps.db, ledgerSecret: deps.ledgerSecret, accounts: deps.accounts, timezone: deps.timezone });
  registerConnectionRoutes(app, { ...deps, registry: deps.chat.registry });
  registerMcpAdminRoutes(app, { db: deps.db, box: deps.box, publicUrl: deps.publicUrl, runner: deps.mcpRunner, registry: deps.chat.registry });
  registerChatRoutes(app, { ...deps.chat, preview: deps.preview });
  const projects = { db: deps.db, memory: deps.chat.memory, workspaceRoot: deps.chat.workspaceRoot, storage: deps.storage };
  registerProjectRoutes(app, { ...projects, preview: deps.preview });
  registerMemoryRoutes(app, { db: deps.db });
  registerSearchRoutes(app, projects);
  registerFileSearchRoutes(app, { ...projects, preview: deps.preview });
  registerVoiceRoutes(app, { db: deps.db, gateway: deps.gateway, registry: deps.chat.registry });
  registerBackgroundRoutes(app, { db: deps.db, registry: deps.chat.registry, background: deps.background, memory: deps.chat.memory });
  registerNotificationRoutes(app, { db: deps.db, ...deps.notifications });
  registerAdminSections(app, { db: deps.db, registry: deps.chat.registry, editor: deps.chat.editor, gateway: deps.gateway, connections: deps.connections });
  registerOrgDocsRoutes(app, { db: deps.db, ...deps.org });
  registerUsageReportRoutes(app, { db: deps.db, registry: deps.chat.registry, timezone: deps.timezone });
  registerModelRoutes(app, deps.models, deps.accounts);
  registerSkillRoutes(app, deps.skills);
  registerInterfaceRoutes(app, { db: deps.db, registry: deps.chat.registry });
  registerStorageRoutes(app, { db: deps.db, storage: deps.storage });
  registerMailRoutes(app, { db: deps.db, mail: deps.chat.mail });
  registerTaskRoutes(app, { db: deps.db, registry: deps.chat.registry, background: deps.background, timezone: deps.timezone, box: deps.box, publicUrl: deps.publicUrl });
  registerHookRoutes(app, { db: deps.db, wake: () => deps.background.wake() });
  registerKnowledgeRoutes(app, { db: deps.db, indexer: deps.knowledge.indexer });
  const agentName = (id: string) => deps.chat.registry.get(id)?.passport.name ?? id;
  registerExampleRoutes(app, { db: deps.db, memory: deps.chat.memory, storage: deps.storage, workspaceRoot: deps.chat.workspaceRoot, indexer: deps.knowledge.indexer });
  registerSupportRoutes(app, { db: deps.db, memory: deps.chat.memory, storage: deps.storage, workspaceRoot: deps.chat.workspaceRoot, timezone: deps.timezone, agentName });
  const mailActions = describeTools(createMailTools({ db: deps.db, mail: deps.chat.mail, workspaceRoot: deps.chat.workspaceRoot, listNote: false, chains: deps.chat.chains }));
  registerChainRoutes(app, {
    db: deps.db,
    box: deps.box,
    registry: deps.chat.registry,
    ...deps.approvals,
    extraActions: async () => {
      const catalog = await deps.connections.mcpCatalog();
      const mcp: Record<string, ActionDescription & { system?: string }> = {};
      for (const { actions, prefixes } of catalog.values()) {
        for (const [name, a] of Object.entries(actions)) mcp[name] = { ...a, system: Object.entries(prefixes).find(([prefix]) => name.startsWith(prefix))?.[1] ?? '' };
      }
      return { ...Object.fromEntries(Object.entries(mailActions).map(([k, a]) => [k, { ...a, system: 'Почта' }])), ...deps.connections.actionsSeen(), ...mcp };
    },
  });
  return app;
}
