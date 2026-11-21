// MCP tools of connected systems for one employee's run (spec, section 8.8; verified at step 0, V7):
// Mastra opens an MCP connection before it knows who asks, so a server with personal access gets
// its own client per (employee, system); our shared server gets one client that signs "who is asking"
// into every request. Tools that are not read-only go through the approval policy like any other.
import type { MyConnection } from '@bba/contracts';
import { MCPClient } from '@mastra/mcp';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ActionDescription } from '@bba/contracts';
import { describeTool } from '../approvals/describe.ts';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import type { AnyTool, McpDefinition } from '../plugins/public/index.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';
import { deleteCredential, loadCredential, saveCredential, setCredentialStatus, type CredentialStatus } from './credentials.ts';
import { authFailed, notConnected, unavailable } from './errors.ts';
import { IDENTITY_HEADER, signIdentity, type Identity } from './identity.ts';
import { classifyCall } from './call-errors.ts';
import { accessToken, pluginTarget, startSignIn, type SignInTarget } from './mcp-auth.ts';
import { createMcpTools, type McpTools } from './mcp-tools.ts';
import { serversOfAgents } from './servers.ts';
import { describeAction } from './snapshot.ts';

export interface ConnectorRuntime {
  id: string;
  title: string;
  mode: 'personal' | 'shared';
  auth: 'oauth' | 'static' | 'identity';
  definition: McpDefinition;
  readOnly: ReadonlySet<string>;
  checkTool?: string;
}

// The shape is read by the web interface («Настройки → Подключения»).
export type ConnectionStatus = MyConnection;

export interface ConnectionManager {
  connectors: ReadonlyMap<string, ConnectorRuntime>;
  // The tools of the systems of one agent's turn: of its plugins (`connectorIds`) and of the MCP servers the admin
  // added for this agent and the person turned on (docs/specs/[20.11.2026]-mcp-connections.md, step 6).
  toolsFor(userId: string, run: { agentId: string; connectorIds: readonly string[] }): Promise<Record<string, AnyTool>>;
  // The actions and the systems of the MCP servers of each agent, whoever the person: the chat's lines.
  mcpCatalog(): Promise<Map<string, { actions: Record<string, ActionDescription>; prefixes: Record<string, string> }>>;
  // The MCP servers the admin added: the employee's actions on them.
  mcp: McpTools;
  // Names of the actions of connected systems listed so far (the same for every employee).
  actionsSeen(): Record<string, ActionDescription>;
  // The person's plugin connections — only of systems their agents use (`connectorIds`).
  statusFor(userId: string, connectorIds: ReadonlySet<string>): Promise<ConnectionStatus[]>;
  saveStatic(userId: string, connectorId: string, fields: Record<string, string>): Promise<CredentialStatus>;
  disconnect(userId: string, connectorId: string): Promise<void>;
  oauthStart(userId: string, connectorId: string): Promise<string>;
  // Whom a plugin's sign-in is for, when the browser comes back from it.
  signInTarget(connectorId: string): SignInTarget;
  close(): Promise<void>;
}

const IDLE_CLOSE_MS = 30 * 60 * 1000;
const IDENTITY_CACHE_MS = 60 * 1000;

export const serverKey = (connectorId: string) => connectorId.replace(/-/g, '_');

function requireConnector(map: ReadonlyMap<string, ConnectorRuntime>, id: string): ConnectorRuntime {
  const c = map.get(id);
  if (!c) throw new Error(`APP_NOT_FOUND: connector ${id} is not installed`);
  return c;
}

// A tool the model sees when the system cannot be used: calling it explains why to the person.
function statusTool(c: ConnectorRuntime, error: () => Error): AnyTool {
  return createTool({
    id: `${serverKey(c.id)}_connection`,
    description: `Система «${c.title}» сейчас недоступна этому сотруднику. Вызови, чтобы сообщить ему, что сделать.`,
    inputSchema: z.object({}),
    execute: () => Promise.reject(error()),
  }) as AnyTool;
}

export function createConnectionManager(deps: { db: Db; box: SecretBox; publicUrl: string; connectors: ConnectorRuntime[] }): ConnectionManager {
  const { db, box } = deps;
  const connectors = new Map(deps.connectors.map((c) => [c.id, c]));
  const clients = new Map<string, { client: MCPClient; timer: NodeJS.Timeout }>();
  const identities = new Map<string, { identity: Identity; until: number }>();
  const authDeps = { db, box, publicUrl: deps.publicUrl };
  const targetOf = (c: ConnectorRuntime) => pluginTarget({ id: c.id, title: c.title, url: c.definition.url, oauth: c.definition.oauth! });

  function remember(key: string, client: MCPClient): MCPClient {
    const existing = clients.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      clients.delete(key);
      void client.disconnect();
    }, IDLE_CLOSE_MS);
    timer.unref();
    clients.set(key, { client, timer });
    return client;
  }

  async function identityOf(userId: string): Promise<Identity> {
    const cached = identities.get(userId);
    if (cached && cached.until > Date.now()) return cached.identity;
    const { rows } = await db.query<{ email: string; departments: string[] | null }>(
      `SELECT u."email" AS email, (SELECT array_agg(d.name) FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = u."id") AS departments
         FROM app."user" u WHERE u."id" = $1`,
      [userId],
    );
    const identity = { userId, email: rows[0]?.email ?? '', departments: rows[0]?.departments ?? [] };
    identities.set(userId, { identity, until: Date.now() + IDENTITY_CACHE_MS });
    return identity;
  }

  function sharedClient(c: ConnectorRuntime): MCPClient {
    const key = `shared:${c.id}`;
    const existing = clients.get(key);
    if (existing) return remember(key, existing.client);
    const secret = c.definition.identitySecret!;
    return remember(
      key,
      new MCPClient({
        id: key,
        servers: {
          [serverKey(c.id)]: {
            url: new URL(c.definition.url),
            fetch: async (url: string | URL, init?: RequestInit, requestContext?: { get(k: string): unknown } | null) => {
              const headers = new Headers(init?.headers);
              const userId = requestContext?.get(REQUEST_KEYS.userId);
              if (typeof userId === 'string' && userId) headers.set(IDENTITY_HEADER, signIdentity(await identityOf(userId), secret));
              return fetch(url, { ...init, headers });
            },
          },
        },
      }),
    );
  }

  async function personalClient(c: ConnectorRuntime, userId: string): Promise<MCPClient> {
    const key = `${userId}:${c.id}`;
    const existing = clients.get(key);
    if (existing) return remember(key, existing.client);
    const record = await loadCredential(db, box, userId, c.id, c.title);
    if (!record) throw notConnected(c.title, c.id);
    if (record.status === 'auth_error') throw authFailed(c.title, c.id);
    const definition = c.definition;
    const server =
      record.credential.kind === 'static'
        ? { url: new URL(definition.url), requestInit: { headers: definition.headers!({ kind: 'static', fields: record.credential.fields }) } }
        : {
            url: new URL(definition.url),
            // The access token is refreshed ahead of expiry before every request, under a lock.
            fetch: async (url: string | URL, init?: RequestInit) => {
              const token = await accessToken(authDeps, targetOf(c), userId);
              const headers = new Headers(init?.headers);
              for (const [k, v] of Object.entries(definition.headers ? definition.headers({ kind: 'oauth', accessToken: token }) : { Authorization: `Bearer ${token}` })) headers.set(k, v);
              return fetch(url, { ...init, headers });
            },
          };
    return remember(key, new MCPClient({ id: key, servers: { [serverKey(c.id)]: server } }));
  }

  function forget(userId: string, connectorId: string): void {
    const key = `${userId}:${connectorId}`;
    const entry = clients.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    clients.delete(key);
    void entry.client.disconnect();
  }

  function wrapPersonal(c: ConnectorRuntime, userId: string, tool: AnyTool): AnyTool {
    const execute = tool.execute!.bind(tool) as (input: unknown, ctx: unknown) => Promise<unknown>;
    return createTool({
      ...tool,
      execute: async (input: unknown, ctx: unknown) => {
        try {
          return await execute(input, ctx);
        } catch (error) {
          // Only a 401 breaks the access (step 7): a 403 on one record, or a word in an error's text, does not.
          if (classifyCall(error).kind !== 'refused') throw error;
          await setCredentialStatus(db, userId, c.id, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
          forget(userId, c.id);
          throw authFailed(c.title, c.id, error);
        }
      },
    } as Parameters<typeof createTool>[0]) as AnyTool;
  }

  // Tool definitions of a system do not depend on the employee: the last listing is kept.
  const seen = new Map<string, ActionDescription>();
  const mcp = createMcpTools(authDeps);

  return {
    connectors,
    mcp,
    actionsSeen: () => ({ ...Object.fromEntries(seen), ...mcp.actionsSeen() }),
    async mcpCatalog() {
      const out = new Map<string, { actions: Record<string, ActionDescription>; prefixes: Record<string, string> }>();
      for (const server of await serversOfAgents(db, box)) {
        for (const agentId of server.agents) {
          const entry = out.get(agentId) ?? { actions: {}, prefixes: {} };
          for (const action of server.actions) entry.actions[action.modelName] = describeAction(action);
          entry.prefixes[`${server.slug}_`] = server.title;
          out.set(agentId, entry);
        }
      }
      return out;
    },
    async toolsFor(userId, run) {
      const out: Record<string, AnyTool> = await mcp.toolsFor(userId, run.agentId);
      for (const id of run.connectorIds) {
        const c = requireConnector(connectors, id);
        const prefix = `${serverKey(c.id)}_`;
        try {
          const client = c.mode === 'shared' ? sharedClient(c) : await personalClient(c, userId);
          const tools = (await client.listTools()) as Record<string, AnyTool>;
          if (Object.keys(tools).length === 0) throw unavailable(c.title, c.id);
          for (const [name, tool] of Object.entries(tools)) {
            const raw = name.startsWith(prefix) ? name.slice(prefix.length) : name;
            const guarded = c.mode === 'personal' ? wrapPersonal(c, userId, tool) : tool;
            out[name] = applyApprovalPolicy(guarded, { readOnly: c.readOnly.has(raw), db });
            seen.set(name, describeTool(out[name]));
          }
        } catch (error) {
          const shown = isAppError(error) ? error : unavailable(c.title, c.id, error);
          if (!isAppError(error)) logEvent('warn', 'connector_unavailable', { connectorId: c.id, code: shown.code, error });
          if (c.mode === 'personal') forget(userId, c.id);
          const tool = statusTool(c, () => shown);
          out[String(tool.id)] = tool;
        }
      }
      return out;
    },

    async statusFor(userId, connectorIds) {
      const out: ConnectionStatus[] = [];
      for (const c of connectors.values()) {
        if (c.mode !== 'personal' || !connectorIds.has(c.id)) continue;
        const { rows } = await db.query<{ status: CredentialStatus; checked_at: Date | null }>(
          'SELECT status, checked_at FROM app.connector_credentials WHERE user_id = $1 AND connector_id = $2',
          [userId, c.id],
        );
        out.push({
          id: c.id,
          title: c.title,
          auth: c.auth,
          fields: c.definition.staticFields ?? [],
          status: rows[0]?.status ?? 'not_connected',
          checkedAt: rows[0]?.checked_at?.toISOString() ?? null,
        });
      }
      return out;
    },

    async saveStatic(userId, connectorId, fields) {
      const c = requireConnector(connectors, connectorId);
      if (c.auth !== 'static') throw new Error(`APP_VALIDATION_FAILED: ${connectorId} does not take a personal key`);
      forget(userId, connectorId);
      await saveCredential(db, box, { userId, connectorId, credential: { kind: 'static', fields }, status: 'unverified' });
      // Check with a safe read-only request when the plugin names one (spec, scenario 3).
      if (!c.checkTool) return 'unverified';
      try {
        const client = await personalClient(c, userId);
        const tools = (await client.listTools()) as Record<string, AnyTool>;
        const check = tools[`${serverKey(c.id)}_${c.checkTool}`];
        if (!check) throw new Error(`check tool ${c.checkTool} is not offered by the server`);
        await check.execute!({}, {} as never);
        await setCredentialStatus(db, userId, connectorId, 'connected', null);
        return 'connected';
      } catch (error) {
        forget(userId, connectorId);
        await setCredentialStatus(db, userId, connectorId, 'auth_error', 'APP_CONNECTOR_AUTH_FAILED');
        throw authFailed(c.title, c.id, error);
      }
    },

    async disconnect(userId, connectorId) {
      requireConnector(connectors, connectorId);
      forget(userId, connectorId);
      await deleteCredential(db, userId, connectorId);
    },

    oauthStart(userId, connectorId) {
      const c = requireConnector(connectors, connectorId);
      if (c.auth !== 'oauth' || !c.definition.oauth) throw new Error(`APP_VALIDATION_FAILED: ${connectorId} has no sign-in on the site`);
      // A new sign-in replaces the client built with the previous token.
      forget(userId, connectorId);
      return startSignIn(authDeps, targetOf(c), { userId, purpose: 'connect' });
    },

    signInTarget(connectorId) {
      const c = requireConnector(connectors, connectorId);
      if (c.auth !== 'oauth' || !c.definition.oauth) throw new Error(`APP_VALIDATION_FAILED: ${connectorId} has no sign-in on the site`);
      return targetOf(c);
    },

    async close() {
      for (const { client, timer } of clients.values()) {
        clearTimeout(timer);
        await client.disconnect();
      }
      clients.clear();
      await mcp.close();
    },
  };
}
