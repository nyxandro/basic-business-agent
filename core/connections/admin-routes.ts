// «Подключения» → «Сервер MCP» in the admin panel (docs/specs/[20.11.2026]-mcp-connections.md, section 17): look at an
// address, add a server, check it with one's own access, set its actions and agents, turn it on and off, delete it.
// All of it needs the right «Подключения».
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { z } from 'zod';
import { mcpCheckInputSchema, mcpProbeInputSchema, mcpServerInputSchema, mcpServerPatchSchema } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { Registry } from '../loader/registry.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import { mcpAccessToken, startMcpSignIn } from './mcp-auth.ts';
import { probeServer } from './probe.ts';
import type { RunnerAccess } from './programs.ts';
import { checkServer, createServer, deleteServer, getServer, listServers, updateServer } from './servers.ts';

export interface McpAdminDeps {
  db: Db;
  box: SecretBox;
  publicUrl: string;
  // The container of program servers; null — the installation has none.
  runner: RunnerAccess | null;
  registry: Pick<Registry, 'ids'>;
}

// The admin checks a server with a sign-in by their own account: without it there is nothing to check with.
const signInFirst = (cause: unknown) =>
  new AppError({
    code: 'APP_CONNECTOR_NOT_CONNECTED',
    message: 'the admin has not signed in to the system yet',
    userMessage: 'Войдите в систему своим аккаунтом: нажмите «Проверить своим доступом» — список действий берётся вашим доступом.',
    status: 409,
    cause,
  });

const BASE = '/app/api/admin/mcp-servers';

function serverId(c: Context<AppEnv>): string {
  const id = c.req.param('id');
  if (!z.uuid().safeParse(id).success) throw appError('APP_NOT_FOUND', `mcp server id ${id} is not a uuid`, { userMessage: 'Такого подключения нет. Обновите страницу.' });
  return id!;
}

export function registerMcpAdminRoutes(app: Hono<AppEnv>, deps: McpAdminDeps): void {
  const { db, box } = deps;
  const guard = requirePermission('connections');

  app.get(BASE, guard, async (c) => c.json({ servers: await listServers(db, box) }));

  app.post(`${BASE}/probe`, guard, async (c) => c.json(await probeServer(await parseJson(c, mcpProbeInputSchema))));

  app.post(BASE, guard, async (c) => {
    const actor = access(c).userId;
    const server = await createServer(db, box, await parseJson(c, mcpServerInputSchema), actor, [...deps.registry.ids()]);
    await writeAudit(db, { actorUserId: actor, action: 'mcp_server.create', target: server.id, details: { title: server.title } });
    logEvent('info', 'mcp_server_saved', { serverId: server.id, change: 'create' });
    return c.json({ server });
  });

  app.get(`${BASE}/:id`, guard, async (c) => c.json({ server: await getServer(db, box, serverId(c)) }));

  app.patch(`${BASE}/:id`, guard, async (c) => {
    const id = serverId(c);
    const patch = await parseJson(c, mcpServerPatchSchema);
    const server = await updateServer(db, box, id, patch, deps.registry.ids());
    // What changed, never the values: the shared key and the client secret stay out of the audit.
    await writeAudit(db, { actorUserId: access(c).userId, action: 'mcp_server.update', target: id, details: { changed: Object.keys(patch).sort(), status: server.status } });
    logEvent('info', 'mcp_server_saved', { serverId: id, change: 'update', status: server.status });
    return c.json({ server });
  });

  // A server with a sign-in: the admin signs in on the system's site first, then checks.
  app.post(`${BASE}/:id/sign-in`, guard, async (c) => c.json({ url: await startMcpSignIn(deps, { userId: access(c).userId, serverId: serverId(c), purpose: 'check' }) }));

  // «Проверить своим доступом» and «Обновить список действий» take the snapshot the same way.
  app.post(`${BASE}/:id/check`, guard, async (c) => {
    const id = serverId(c);
    const input = await parseJson(c, mcpCheckInputSchema);
    const userId = access(c).userId;
    const adminToken = async () => {
      try {
        return await mcpAccessToken(deps, { userId, serverId: id });
      } catch (error) {
        if (isAppError(error) && error.code === 'APP_CONNECTOR_NOT_CONNECTED') throw signInFirst(error);
        throw error;
      }
    };
    try {
      return c.json({ server: await checkServer(db, box, id, input, adminToken, deps.runner) });
    } catch (error) {
      // Only the code and the HTTP facts: the texts of the client library carry the address with its key.
      if (isAppError(error) && error.status < 500) logEvent('warn', 'mcp_snapshot_failed', { serverId: id, code: error.code, details: error.details ?? null });
      throw error;
    }
  });

  app.delete(`${BASE}/:id`, guard, async (c) => {
    const id = serverId(c);
    const { title } = await deleteServer(db, id);
    await writeAudit(db, { actorUserId: access(c).userId, action: 'mcp_server.delete', target: id, details: { title } });
    logEvent('info', 'mcp_server_saved', { serverId: id, change: 'delete' });
    return c.json({ ok: true });
  });
}
