// Chat routes (spec, section 17.5): the agent list, the CopilotKit runtime, conversations,
// personal memory and attachments.
import type { AgentListResponse, MemoryResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors/app-error.ts';
import { agentActions, subagentCalls } from '../approvals/describe.ts';
import { appError, ERROR_CATALOG } from '../errors/catalog.ts';
import { deleteThread, draftResourceId, forgetAll, isBlankMemory, readMemory, writeMemory } from '../memory/memory.ts';
import { listThreadPage, projectOfThread, THREAD_PAGE_MAX } from '../projects/projects.ts';
import { readUploadedFile } from '../projects/routes.ts';
import { contextRoot, saveFile } from '../workspace/layout.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { assertAgentOpen, prepareRun, releaseThread, SAFE_THREAD_ID, type ChatDeps, type RunInput } from './run.ts';
import { connectResponse, declinedCallEvents } from './connect.ts';
import { serverKey } from '../connections/manager.ts';
import { COPILOT_BASE_PATH, type CopilotHandler } from './copilot.ts';
import { toHistory, toolCallArgsOf } from './history.ts';
import { wrapRunResponse, type TranslatedError } from './stream.ts';
import { WORKSPACE_ACTIONS } from '../sandbox/workspace.ts';

export const DRAFT_HEADER = 'x-bba-draft';
const INFO_PATH = '/info';
const AGENT_PATH = /^\/agent\/([^/]+)\/(run|connect)$/;
const STOP_PATH = /^\/agent\/([^/]+)\/stop\/([^/]+)$/;

const notFound = (message: string) => new AppError({ code: 'APP_NOT_FOUND', message, userMessage: 'Разговор не найден.', status: 404 });
const memoryBody = z.object({ text: z.string().max(20_000) });

export function registerChatRoutes(app: Hono<AppEnv>, deps: ChatDeps & { copilot: CopilotHandler }): void {
  async function translate(userId: string, raw: string): Promise<TranslatedError> {
    const code = /^(APP_[A-Z0-9_]+):/.exec(raw)?.[1];
    const known = code ? (ERROR_CATALOG as Record<string, { userMessage: string }>)[code] : undefined;
    if (code && known) return { code, message: known.userMessage };
    const error = await deps.gateway.translateError(new Error(raw), userId);
    return { code: error.code, message: error.userMessage };
  }

  app.get('/app/api/agents', async (c) => {
    const a = access(c);
    const { rows } = await deps.db.query<{ agent_id: string; starters: string[] }>('SELECT agent_id, starters FROM app.agent_overrides WHERE starters IS NOT NULL');
    const ownStarters = new Map(rows.map((r) => [r.agent_id, r.starters]));
    const seen = deps.connections.actionsSeen();
    const agents = deps.registry.agents
      .filter((rt) => a.isSuperadmin || a.agentIds.has(rt.passport.id))
      .map((rt) => ({
        id: rt.passport.id,
        name: rt.passport.name,
        description: rt.passport.description,
        starters: ownStarters.get(rt.passport.id) ?? rt.passport.starters,
        actions: {
          ...WORKSPACE_ACTIONS,
          ...Object.fromEntries(Object.entries(seen).filter(([tool]) => rt.connectorIds.some((id) => tool.startsWith(`${serverKey(id)}_`)))),
          ...agentActions(rt),
          ...subagentCalls(rt),
        },
        systems: {
          tools: rt.toolSystems,
          prefixes: Object.fromEntries(
            deps.registry.connectors.filter((conn) => rt.connectorIds.includes(conn.id)).map((conn) => [`${serverKey(conn.id)}_`, conn.title]),
          ),
        },
      }));
    const body: AgentListResponse = { agents };
    return c.json(body);
  });

  // Only the addresses the chat window calls in CopilotKit's REST transport (web: useSingleEndpoint
  // false). Everything else of the runtime — its thread listing, events, state, the single endpoint,
  // any prefixed path its router would still resolve — stays closed: those know no owner.
  app.all(`${COPILOT_BASE_PATH}/*`, async (c) => {
    const a = access(c);
    // The admin's draft check: CopilotKit adds headers to its requests but not query parameters.
    const mode = c.req.query('draft') === '1' || c.req.header(DRAFT_HEADER) === '1' ? 'draft' : 'published';
    const resourceId = mode === 'draft' ? draftResourceId(a.userId) : a.userId;
    const path = c.req.path.slice(COPILOT_BASE_PATH.length);
    const method = c.req.method;

    if (method === 'GET' && path === INFO_PATH) {
      const agentIds = deps.registry.agents.map((rt) => rt.passport.id).filter((id) => a.isSuperadmin || a.agentIds.has(id));
      if (agentIds.length === 0) return c.json({ agents: {} });
      return deps.copilot.handle(c.req.raw, { kind: 'listing', userId: a.userId, agentIds, mode });
    }

    const stop = method === 'POST' ? STOP_PATH.exec(path) : null;
    if (stop) {
      const [, agentId, threadId] = stop as unknown as [string, string, string];
      assertAgentOpen(deps, a, agentId, mode);
      const thread = await deps.memory.getThreadById({ threadId: decodeURIComponent(threadId) });
      if (!thread || thread.resourceId !== resourceId) throw notFound('stop of a foreign or unknown thread');
      return deps.copilot.handle(c.req.raw, { kind: 'listing', userId: a.userId, agentIds: [agentId], mode });
    }

    const match = method === 'POST' ? AGENT_PATH.exec(path) : null;
    if (!match) throw notFound(`CopilotKit address ${method} ${path} is not served`);
    const [, agentId, action] = match as unknown as [string, string, 'run' | 'connect'];
    assertAgentOpen(deps, a, agentId, mode);
    if (action === 'connect') {
      const { threadId } = (await c.req.raw.clone().json()) as { threadId?: string };
      if (!threadId || !SAFE_THREAD_ID.test(threadId)) throw appError('APP_VALIDATION_FAILED', `bad thread id "${threadId}"`);
      return connectResponse(deps, { userId: a.userId, resourceId, agentId, threadId });
    }
    const input = (await c.req.raw.clone().json()) as RunInput;
    const run = await prepareRun(deps, a, agentId, mode, input);
    try {
      // Messages whose shown words a repeated model call dropped, for the chat (spec, 9.1).
      const discarded: string[] = [];
      const res = await deps.copilot.handle(c.req.raw, { kind: 'run', run, onMessageDiscarded: (messageId) => discarded.push(messageId) });
      // The cancelled call shows the arguments as the model sent them (the database keeps a summary).
      const sent = run.declinedCalls.length > 0 ? await toolCallArgsOf(deps.memory, run.threadId, run.resourceId) : new Map<string, unknown>();
      const afterStart = run.declinedCalls.flatMap((d) => declinedCallEvents({ ...d, args: sent.get(d.toolCallId) ?? d.args }));
      return wrapRunResponse(res, { onEnd: () => releaseThread(run.threadId), translate: (raw) => translate(a.userId, raw), afterStart, takeDiscarded: () => discarded.splice(0) });
    } catch (error) {
      releaseThread(run.threadId);
      throw error;
    }
  });

  app.get('/app/api/agents/:agentId/threads', async (c) => {
    assertAgentOpen(deps, access(c), c.req.param('agentId'), 'published');
    const page = await listThreadPage(deps, access(c).userId, { agentId: c.req.param('agentId'), limit: THREAD_PAGE_MAX });
    return c.json({ threads: page.threads });
  });

  app.get('/app/api/threads/:threadId/messages', async (c) => {
    const thread = await deps.memory.getThreadById({ threadId: c.req.param('threadId') });
    if (!thread || thread.resourceId !== access(c).userId) {
      throw new AppError({ code: 'APP_NOT_FOUND', message: 'foreign or unknown thread', userMessage: 'Разговор не найден.', status: 404 });
    }
    const { messages } = await deps.memory.recall({ threadId: thread.id, resourceId: thread.resourceId, perPage: false });
    if (thread.metadata?.unread === true) await deps.memory.updateThread({ id: thread.id, title: thread.title ?? '', metadata: { ...thread.metadata, unread: false } });
    return c.json({ thread: { id: thread.id, title: thread.title, agentId: thread.metadata?.agentId }, messages: toHistory(messages as never) });
  });

  app.delete('/app/api/threads/:threadId', async (c) => {
    const userId = access(c).userId;
    // Files stay: they belong to the files folder, not to the conversation (spec, section 8.9).
    await deleteThread(deps.memory, deps.db, userId, c.req.param('threadId'));
    return c.json({ ok: true });
  });

  app.get('/app/api/me/memory', async (c) => {
    const text = await readMemory(deps.memory, access(c).userId);
    const body: MemoryResponse = { text, empty: isBlankMemory(text) };
    return c.json(body);
  });
  app.put('/app/api/me/memory', async (c) => {
    const { text } = await parseJson(c, memoryBody);
    await writeMemory(deps.memory, access(c).userId, text);
    return c.json({ ok: true });
  });
  app.delete('/app/api/me/memory', async (c) => {
    await forgetAll(deps.memory, access(c).userId);
    return c.json({ ok: true });
  });

  app.post('/app/api/threads/:threadId/files', async (c) => {
    const userId = access(c).userId;
    const threadId = c.req.param('threadId');
    const thread = await deps.memory.getThreadById({ threadId });
    // The person's own conversation, or their draft check of an agent's prompt.
    if (thread && thread.resourceId !== userId && thread.resourceId !== draftResourceId(userId)) {
      throw new AppError({ code: 'APP_NOT_FOUND', message: 'foreign thread', userMessage: 'Разговор не найден.', status: 404 });
    }
    const file = await readUploadedFile(c);
    // A file attached in a project conversation becomes a file of the project (spec, section 8.9).
    const root = contextRoot(deps.workspaceRoot, userId, await projectOfThread(deps.db, userId, threadId));
    return c.json(saveFile(root, file.name, new Uint8Array(await file.arrayBuffer())), 201);
  });
}
