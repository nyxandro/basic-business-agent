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
import { loadCredential } from './credentials.ts';
import { authFailed, notConnected, unavailable } from './errors.ts';
import { accessToken, mcpTarget } from './mcp-auth.ts';
import { accessOf, mcpConnectorId, serversForRun, type RunServer } from './servers.ts';
import { CONNECT_TIMEOUT_MS, describeAction } from './snapshot.ts';

// Section 8: a call waits for the system 60 s at most.
const CALL_TIMEOUT_MS = 60_000;
const IDLE_CLOSE_MS = 30 * 60 * 1000;

export interface McpToolsDeps {
  db: Db;
  box: SecretBox;
  publicUrl: string;
}

export interface McpTools {
  toolsFor(userId: string, agentId: string): Promise<Record<string, AnyTool>>;
  // The actions of servers built so far, by the name the model calls them: the card of «Да» names them.
  actionsSeen(): Record<string, ActionDescription>;
  // Calls the action the admin chose to check a personal key with; nothing when there is none.
  verify(userId: string, server: RunServer): Promise<void>;
  // The person's client of a server is rebuilt after their access changed (a new key, «Отключить»).
  forget(serverId: string, userId: string): void;
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
    if (server.auth === 'none') return clientFor(server, null, { url: new URL(server.url), ...base }, server.url);
    if (server.auth === 'shared_key') {
      const access = accessOf({ url: server.url, header_templates: server.headerTemplates, fields: server.fields }, (field) => server.shared![field.key]!);
      return clientFor(server, null, { url: access.url, requestInit: { headers: access.headers }, ...base }, JSON.stringify([access.url, access.headers]));
    }
    const connectorId = mcpConnectorId(server.id);
    const record = await loadCredential(db, box, userId, connectorId, server.title);
    if (!record) throw notConnected(server.title, connectorId);
    if (record.status === 'auth_error') throw authFailed(server.title, connectorId);
    if (server.auth === 'oauth') {
      const target = mcpTarget(deps, { id: server.id, title: server.title, url: server.url, status: server.status, client: undefined });
      // The token is taken, and refreshed ahead of expiry, for every request of this person's client.
      const fetchWithToken = async (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${await accessToken(deps, target, userId)}`);
        return fetch(url, { ...init, headers });
      };
      return clientFor(server, userId, { url: new URL(server.url), fetch: fetchWithToken, ...base }, 'oauth');
    }
    if (record.credential.kind !== 'static') throw notConnected(server.title, connectorId);
    const fields = record.credential.fields;
    const access = accessOf({ url: server.url, header_templates: server.headerTemplates, fields: server.fields }, (field) => {
      const value = fields[field.key];
      if (!value) throw notConnected(server.title, connectorId);
      return value;
    });
    return clientFor(server, userId, { url: access.url, requestInit: { headers: access.headers }, ...base }, JSON.stringify([access.url, access.headers]));
  }

  return {
    async toolsFor(userId, agentId) {
      const out: Record<string, AnyTool> = {};
      for (const server of await serversForRun(db, box, userId, agentId)) {
        try {
          const client = await clientOf(server, userId);
          for (const action of server.actions) {
            const tool = await client.toolFromDefinition({ serverName: server.slug, definition: action.definition });
            // The model calls it by the name the snapshot gave; the journal and «Да» know it by the same name.
            const named = createTool({ ...tool, id: action.modelName } as Parameters<typeof createTool>[0]) as AnyTool;
            out[action.modelName] = applyApprovalPolicy(named, { readOnly: action.readOnly, db });
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
      if (!server.checkAction) return;
      const client = await clientOf(server, userId);
      const tool = await client.toolFromDefinition({ serverName: server.slug, definition: server.checkAction.definition });
      await tool.execute!({}, {} as never);
    },

    forget(serverId, userId) {
      for (const [key, entry] of clients) {
        if (entry.serverId !== serverId || entry.userId !== userId) continue;
        clearTimeout(entry.timer);
        clients.delete(key);
        void entry.client.disconnect();
      }
    },

    async close() {
      for (const { client, timer } of clients.values()) {
        clearTimeout(timer);
        await client.disconnect();
      }
      clients.clear();
    },
  };
}
