// Chat routes (spec, section 17.5): the agent list, the CopilotKit runtime, conversations,
// personal memory and attachments.
import type { AgentListResponse, MemoryResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors/app-error.ts';
import { appError, ERROR_CATALOG } from '../errors/catalog.ts';
import { deleteThread, draftResourceId, forgetAll, isBlankMemory, listThreads, readMemory, writeMemory } from '../memory/memory.ts';
import { deleteThreadUploads, MAX_UPLOAD_BYTES, saveUpload } from '../sandbox/uploads.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { assertAgentOpen, prepareRun, releaseThread, SAFE_THREAD_ID, type ChatDeps, type RunInput } from './run.ts';
import { connectResponse, declinedCallEvents } from './connect.ts';
import { serverKey } from '../connections/manager.ts';
import { COPILOT_BASE_PATH, type CopilotHandler } from './copilot.ts';
import { toHistory } from './history.ts';
import { wrapRunResponse, type TranslatedError } from './stream.ts';

export const DRAFT_HEADER = 'x-bba-draft';
const RUN_PATH = /^\/agent\/([^/]+)\/(run|connect|stop)/;
const memoryBody = z.object({ text: z.string().max(20_000) });
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function registerChatRoutes(app: Hono<AppEnv>, deps: ChatDeps & { copilot: CopilotHandler }): void {
  async function translate(userId: string, raw: string): Promise<TranslatedError> {
    const code = /^(APP_[A-Z0-9_]+):/.exec(raw)?.[1];
    const known = code ? (ERROR_CATALOG as Record<string, { userMessage: string }>)[code] : undefined;
    if (code && known) return { code, message: known.userMessage };
    const error = await deps.gateway.translateError(new Error(raw), userId);
    return { code: error.code, message: error.userMessage };
  }

  app.get('/app/api/agents', (c) => {
    const a = access(c);
    const agents = deps.registry.agents
      .filter((rt) => a.isSuperadmin || a.agentIds.has(rt.passport.id))
      .map((rt) => ({
        id: rt.passport.id,
        name: rt.passport.name,
        description: rt.passport.description,
        starters: rt.passport.starters,
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

  app.all(`${COPILOT_BASE_PATH}/*`, async (c) => {
    const a = access(c);
    // The admin's draft check: CopilotKit adds headers to its requests but not query parameters.
    const mode = c.req.query('draft') === '1' || c.req.header(DRAFT_HEADER) === '1' ? 'draft' : 'published';
    const match = RUN_PATH.exec(c.req.path.slice(COPILOT_BASE_PATH.length));
    if (!match) {
      const agentIds = deps.registry.agents.map((rt) => rt.passport.id).filter((id) => a.isSuperadmin || a.agentIds.has(id));
      if (agentIds.length === 0) return c.json({ agents: {} });
      return deps.copilot.handle(c.req.raw, { kind: 'listing', userId: a.userId, agentIds, mode });
    }
    const [, agentId, action] = match as unknown as [string, string, string];
    assertAgentOpen(deps, a, agentId, mode);
    if (action === 'connect') {
      const { threadId } = (await c.req.raw.clone().json()) as { threadId?: string };
      if (!threadId || !SAFE_THREAD_ID.test(threadId)) throw appError('APP_VALIDATION_FAILED', `bad thread id "${threadId}"`);
      return connectResponse(deps, { userId: a.userId, resourceId: mode === 'draft' ? draftResourceId(a.userId) : a.userId, agentId, threadId });
    }
    if (action !== 'run') {
      return deps.copilot.handle(c.req.raw, { kind: 'listing', userId: a.userId, agentIds: [agentId], mode });
    }
    const input = (await c.req.raw.clone().json()) as RunInput;
    const run = await prepareRun(deps, a, agentId, mode, input);
    try {
      const res = await deps.copilot.handle(c.req.raw, { kind: 'run', run });
      const afterStart = run.declinedCalls.flatMap((d) => declinedCallEvents(d));
      return wrapRunResponse(res, { onEnd: () => releaseThread(run.threadId), translate: (raw) => translate(a.userId, raw), afterStart });
    } catch (error) {
      releaseThread(run.threadId);
      throw error;
    }
  });

  app.get('/app/api/agents/:agentId/threads', async (c) => {
    assertAgentOpen(deps, access(c), c.req.param('agentId'), 'published');
    return c.json({ threads: await listThreads(deps.memory, access(c).userId, c.req.param('agentId')) });
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
    await deleteThread(deps.memory, deps.db, userId, c.req.param('threadId'));
    deleteThreadUploads(deps.workspaceRoot, userId, c.req.param('threadId'));
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

  app.post('/app/api/threads/:threadId/uploads', async (c) => {
    const userId = access(c).userId;
    const threadId = c.req.param('threadId');
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
      throw new AppError({ code: 'APP_UPLOAD_TOO_LARGE', message: 'request body over the upload limit', userMessage: ERROR_CATALOG.APP_UPLOAD_TOO_LARGE.userMessage, status: 413 });
    }
    const thread = await deps.memory.getThreadById({ threadId });
    if (thread && thread.resourceId !== userId) throw new AppError({ code: 'APP_NOT_FOUND', message: 'foreign thread', userMessage: 'Разговор не найден.', status: 404 });
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new AppError({ code: 'APP_VALIDATION_FAILED', message: 'no file field', userMessage: 'Файл не получен. Попробуйте прикрепить его ещё раз.', status: 400 });
    return c.json(saveUpload(deps.workspaceRoot, { userId, threadId, fileName: file.name, data: new Uint8Array(await file.arrayBuffer()) }), 201);
  });
}
