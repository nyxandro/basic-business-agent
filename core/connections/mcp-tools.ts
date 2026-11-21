// The actions of the MCP servers the admin added, as tools of an agent's turn (docs/specs/[20.11.2026]-mcp-connections.md,
// sections 4 and 8, step 6). They are rebuilt from the snapshot the admin checked (Mastra `toolFromDefinition`): no
// connection is opened until an action is called, so a silent server never holds a turn, and an action the admin
// has not seen never reaches the agent. Each employee's access goes only to their own client: a server with
// personal access gets a client per (employee, server), one without — one client per server.
import { createHash } from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';
import { z } from 'zod';
import type { ActionDescription } from '@bba/contracts';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { logEvent } from '../server/log.ts';
import { classifyCall } from './call-errors.ts';
import { loadCredential, markCredentialBroken } from './credentials.ts';
import { accessLost, forbidden, keyRefused, notConnected, unavailable, unknownOutcome } from './errors.ts';
import { safeCause } from './log-safe.ts';
import { accessToken, mcpTarget } from './mcp-auth.ts';
import { programSpecOf, programUrl, requireRunner, signedFetch, type RunnerAccess } from './programs.ts';
import { accessOf, markProgramCrashed, markSharedKeyRefused, mcpConnectorId, serversForRun, type RunServer } from './servers.ts';
import { CONNECT_TIMEOUT_MS, definitionForCalls, describeAction } from './snapshot.ts';
import { assertPlainHttpAllowed } from './probe.ts';

// Section 8: a call waits for the system 60 s at most.
const CALL_TIMEOUT_MS = 60_000;
const IDLE_CLOSE_MS = 30 * 60 * 1000;

export interface McpToolsDeps {
  db: Db;
  box: SecretBox;
  publicUrl: string;
  // The container of program servers; null — the installation has none.
  runner: RunnerAccess | null;
}

// mcp-runner answers 503 only for a program that fell three times in ten minutes (a container that is down answers
// nothing at all).
const PROGRAM_FELL = 503;

export interface McpTools {
  toolsFor(userId: string, agentId: string): Promise<Record<string, AnyTool>>;
  // The actions of servers built so far, by the name the model calls them: the card of «Да» names them.
  actionsSeen(): Record<string, ActionDescription>;
  // Calls the action the admin chose to check a personal key with: «connected» when the system took the key,
  // «unverified» when there is no such action or the system did not answer; a refused key throws.
  verify(userId: string, server: RunServer): Promise<'connected' | 'unverified'>;
  // The client of a server is rebuilt after the access changed: a person's (a new key, «Отключить») or the
  // organization's (`null`: a new shared key).
  forget(serverId: string, userId: string | null): void;
  close(): Promise<void>;
}

const sharedAuthRefused = (server: RunServer) =>
  new AppError({
    code: 'APP_CONNECTOR_AUTH_FAILED',
    message: `${server.title}: the shared key is refused`,
    userMessage: `${server.title} не принимает общий ключ организации. Администратор видит это в «Подключениях»; попробуйте позже.`,
    status: 401,
    details: { connectorId: mcpConnectorId(server.id) },
  });

// The tool the model sees instead of the actions when the server cannot be used: calling it tells the person why.
function statusTool(server: RunServer, error: AppError): AnyTool {
  return createTool({
    id: `${server.slug}_connection`,
    description: `Система «${server.title}» сейчас недоступна этому сотруднику. Вызови, чтобы сообщить ему, что сделать.`,
    inputSchema: z.object({}),
    execute: () => Promise.reject(error),
  }) as AnyTool;
}

export function createMcpTools(deps: McpToolsDeps): McpTools {
  const { db, box } = deps;
  const clients = new Map<string, { client: MCPClient; timer: NodeJS.Timeout; serverId: string; userId: string | null }>();
  const seen = new Map<string, ActionDescription>();

  // The client is keyed by what it sends: a new key of the person or a new shared key gives a new client, the old
  // one closes after its idle time. Only a hash of the access is kept as the key.
  function clientFor(server: RunServer, userId: string | null, definition: MastraMCPServerDefinition, access: string): MCPClient {
    const key = createHash('sha256').update(`${server.id}\n${userId ?? ''}\n${access}`).digest('hex');
    const existing = clients.get(key);
    if (existing) clearTimeout(existing.timer);
    const client = existing?.client ?? new MCPClient({ id: `mcp-${key.slice(0, 16)}`, registerProcessHooks: false, servers: { [server.slug]: definition } });
    const timer = setTimeout(() => {
      clients.delete(key);
      void client.disconnect();
    }, IDLE_CLOSE_MS);
    timer.unref();
    clients.set(key, { client, timer, serverId: server.id, userId });
    return client;
  }

  // The client with the access of this person (or of the organization), or the reason it cannot be used.
  async function clientOf(server: RunServer, userId: string): Promise<MCPClient> {
    const base = { connectTimeout: CONNECT_TIMEOUT_MS, timeout: CALL_TIMEOUT_MS };
    if (server.status === 'shared_auth_error') throw sharedAuthRefused(server);
    if (server.status === 'program_crashed') throw unavailable(server.title, mcpConnectorId(server.id));
    if (server.transport === 'program') {
      // One process per server for the whole organization: without a sign-in or with the shared key only.
      const runner = requireRunner(deps.runner);
      const spec = programSpecOf(server.program!, server.envTemplates, server.fields, server.shared);
      return clientFor(server, null, { url: programUrl(runner, server.id), fetch: signedFetch(runner, server.id, spec), ...base }, JSON.stringify(spec));
    }
    const url = server.url!;
    if (server.auth === 'none') return clientFor(server, null, { url: new URL(url), ...base }, url);
    if (server.auth === 'shared_key') {
      const access = accessOf({ url, header_templates: server.headerTemplates, fields: server.fields }, (field) => server.shared![field.key]!);
      // A host made of a value is checked only now (servers.ts, checkPlainHttp): no key over http to the internet.
      await assertPlainHttpAllowed(access.url);
      return clientFor(server, null, { url: access.url, requestInit: { headers: access.headers }, ...base }, JSON.stringify([access.url, access.headers]));
    }
    const connectorId = mcpConnectorId(server.id);
    const record = await loadCredential(db, box, userId, connectorId, server.title);
    if (!record) throw notConnected(server.title, connectorId);
    if (record.status === 'auth_error') throw accessLost(server.title, connectorId);
    if (server.auth === 'oauth') {
      const target = mcpTarget(deps, { id: server.id, title: server.title, url, status: server.status, client: undefined });
      // The token is taken, and refreshed ahead of expiry, for every request of this person's client.
      const fetchWithToken = async (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${await accessToken(deps, target, userId)}`);
        return fetch(url, { ...init, headers });
      };
      return clientFor(server, userId, { url: new URL(url), fetch: fetchWithToken, ...base }, 'oauth');
    }
    if (record.credential.kind !== 'static') throw notConnected(server.title, connectorId);
    const fields = record.credential.fields;
    const access = accessOf({ url, header_templates: server.headerTemplates, fields: server.fields }, (field) => {
      const value = fields[field.key];
      if (!value) throw notConnected(server.title, connectorId);
      return value;
    });
    await assertPlainHttpAllowed(access.url);
    return clientFor(server, userId, { url: access.url, requestInit: { headers: access.headers }, ...base }, JSON.stringify([access.url, access.headers]));
  }

  // What a failed call means for the person and for the connection (step 7): by the HTTP status, not the text.
  async function failureOf(server: RunServer, userId: string, error: unknown): Promise<unknown> {
    const connectorId = mcpConnectorId(server.id);
    const failure = classifyCall(error);
    switch (failure.kind) {
      case 'own':
        return failure.error;
      case 'answered':
        return error;
      case 'unknown_outcome':
        logEvent('warn', 'connector_unknown_outcome', { connectorId });
        return unknownOutcome(server.title, connectorId);
      case 'forbidden':
        return forbidden(server.title, connectorId);
      case 'refused':
        if (server.auth === 'personal_key' || server.auth === 'oauth') {
          await markCredentialBroken(db, { userId, connectorId, title: server.title, errorCode: 'APP_CONNECTOR_AUTH_FAILED' });
          forget(server.id, userId);
          logEvent('warn', 'connector_auth_failed', { connectorId });
          return accessLost(server.title, connectorId);
        }
        if (server.auth === 'shared_key') {
          await markSharedKeyRefused(db, server.id);
          forget(server.id, null);
          // The admins learn it from the card in «Подключения»; a notification comes with the feature «Уведомления».
          logEvent('error', 'mcp_shared_auth_failed', { connectorId });
          return sharedAuthRefused(server);
        }
        logEvent('warn', 'connector_unavailable', { connectorId, httpStatus: 401 });
        return unavailable(server.title, connectorId);
      case 'unavailable':
        if (server.transport === 'program' && failure.httpStatus === PROGRAM_FELL) {
          await markProgramCrashed(db, server.id);
          forget(server.id, null);
          // The admins learn it from the card in «Подключения»; a notification comes with the feature «Уведомления».
          logEvent('error', 'mcp_program_crashed', { connectorId });
          return unavailable(server.title, connectorId);
        }
        logEvent('warn', 'connector_unavailable', { connectorId, httpStatus: failure.httpStatus ?? null });
        return unavailable(server.title, connectorId, safeCause(error));
    }
  }

  function guarded(server: RunServer, userId: string, tool: AnyTool, name: string): AnyTool {
    const execute = tool.execute!.bind(tool) as (input: unknown, ctx: unknown) => Promise<unknown>;
    return createTool({
      ...tool,
      id: name,
      execute: async (input: unknown, ctx: unknown) => {
        try {
          return await execute(input, ctx);
        } catch (error) {
          throw await failureOf(server, userId, error);
        }
      },
    } as Parameters<typeof createTool>[0]) as AnyTool;
  }

  function forget(serverId: string, userId: string | null): void {
    for (const [key, entry] of clients) {
      if (entry.serverId !== serverId || entry.userId !== userId) continue;
      clearTimeout(entry.timer);
      clients.delete(key);
      void entry.client.disconnect();
    }
  }

  return {
    async toolsFor(userId, agentId) {
      const out: Record<string, AnyTool> = {};
      for (const server of await serversForRun(db, box, userId, agentId)) {
        try {
          const client = await clientOf(server, userId);
          for (const action of server.actions) {
            const tool = await client.toolFromDefinition({ serverName: server.slug, definition: definitionForCalls(action) });
            // The model calls it by the name the snapshot gave; the journal and «Да» know it by the same name.
            out[action.modelName] = applyApprovalPolicy(guarded(server, userId, tool as AnyTool, action.modelName), { readOnly: action.readOnly, db });
            seen.set(action.modelName, describeAction(action));
          }
        } catch (error) {
          if (!isAppError(error)) throw error;
          logEvent('warn', 'connector_unavailable', { connectorId: mcpConnectorId(server.id), code: error.code });
          const tool = statusTool(server, error);
          out[String(tool.id)] = tool;
        }
      }
      return out;
    },

    actionsSeen: () => Object.fromEntries(seen),

    async verify(userId, server) {
      if (!server.checkAction) return 'unverified';
      const connectorId = mcpConnectorId(server.id);
      const client = await clientOf(server, userId);
      const tool = await client.toolFromDefinition({ serverName: server.slug, definition: server.checkAction.definition });
      try {
        await guarded(server, userId, tool as AnyTool, server.checkAction.modelName).execute!({}, {} as never);
        return 'connected';
      } catch (error) {
        // The system answered the call, even with an error of its own: it took the key.
        if (classifyCall(error).kind === 'answered') return 'connected';
        if (isAppError(error) && error.code === 'APP_CONNECTOR_AUTH_FAILED') throw keyRefused(server.title, connectorId);
        return 'unverified';
      }
    },

    forget,

    async close() {
      for (const { client, timer } of clients.values()) {
        clearTimeout(timer);
        await client.disconnect();
      }
      clients.clear();
    },
  };
}
