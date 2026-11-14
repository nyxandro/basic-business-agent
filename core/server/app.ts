// The HTTP server of the installation. Only our routes exist: Mastra's built-in routes are never
// registered (no MastraServer.init()), and everything that matches nothing answers 404 (spec, 17.6).
import { Hono } from 'hono';
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
import type { ConnectionManager } from '../connections/manager.ts';
import { registerConnectionRoutes } from '../connections/routes.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { registerUsageRoutes } from '../models/routes.ts';
import { registerProjectRoutes } from '../projects/routes.ts';
import { registerSearchRoutes } from '../search/routes.ts';
import { requireSession } from './guards.ts';
import { errorJson, handleError, type AppEnv } from './http.ts';

export interface ServerDeps {
  db: Db;
  auth: Auth;
  publicUrl: string;
  knownAgentIds: () => ReadonlySet<string>;
  gateway: ModelGateway;
  ledgerSecret: string;
  connections: ConnectionManager;
  chat: ChatDeps & { copilot: CopilotHandler };
  background: BackgroundService;
  timezone: string;
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
    deletion: { db: deps.db, memory: deps.chat.memory, gateway: deps.gateway, workspaceRoot: deps.chat.workspaceRoot },
  });
  registerRoleRoutes(app, deps);
  registerUsageRoutes(app, { db: deps.db, catalog: deps.gateway.catalog, ledgerSecret: deps.ledgerSecret });
  registerConnectionRoutes(app, deps);
  registerChatRoutes(app, deps.chat);
  const projects = { db: deps.db, memory: deps.chat.memory, workspaceRoot: deps.chat.workspaceRoot };
  registerProjectRoutes(app, projects);
  registerSearchRoutes(app, projects);
  registerBackgroundRoutes(app, { db: deps.db, registry: deps.chat.registry, background: deps.background, memory: deps.chat.memory });
  registerAdminSections(app, { db: deps.db, registry: deps.chat.registry, editor: deps.chat.editor, gateway: deps.gateway, connections: deps.connections });
  registerUsageReportRoutes(app, { db: deps.db, registry: deps.chat.registry, catalog: deps.gateway.catalog, timezone: deps.timezone });
  return app;
}
