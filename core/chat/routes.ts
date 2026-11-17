// Chat routes (spec, section 17.5): the agent list, the CopilotKit runtime, conversations,
// and attachments.
import { basename, relative } from 'node:path';
import { COMPUTER_ACTION_TITLES, COMPUTER_COPIES, COMPUTER_SYSTEM, COMPUTER_TOOLS, renameThreadSchema, retryTurnSchema, type AgentListResponse, type RenameThreadResponse, type RetryTurnResponse, type ThreadFileStatus, type ThreadNameResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { AppError } from '../errors/app-error.ts';
import { agentActions, describeTools, subagentCalls } from '../approvals/describe.ts';
import { createMailTools, MAIL_SYSTEM, MAIL_TOOL_NAMES } from '../mail/tools.ts';
import { appError, ERROR_CATALOG } from '../errors/catalog.ts';
import { deleteThread, draftResourceId } from '../memory/memory.ts';
import { renameThread } from '../memory/titles.ts';
import { agentMarks, chatMark, DEFAULT_MARK } from '../interface-settings/agent-marks.ts';
import { threadProjectState, type ThreadProjectState } from '../projects/access.ts';
import { listThreadPage, THREAD_PAGE_MAX } from '../projects/projects.ts';
import { readUploadedFile } from '../projects/routes.ts';
import { fileResponse } from '../workspace/download.ts';
import { areaOf, filesPrefix, type Area } from '../storage/areas.ts';
import { contextRoot, filesRoot, pruneOlderThan, putInFolder, resolveInside, saveFile } from '../workspace/layout.ts';
import { trashedAt } from '../projects/trash.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { startNaming } from './naming.ts';
import { assertAgentOpen, assertNewTurnAllowed, endRun, newMessageOf, prepareRun, SAFE_THREAD_ID, settleRun, type ChatDeps, type RunInput } from './run.ts';
import { connectResponse, declinedCallEvents } from './connect.ts';
import { serverKey } from '../connections/manager.ts';
import { COPILOT_BASE_PATH, type CopilotHandler } from './copilot.ts';
import { toHistory, toolCallArgsOf } from './history.ts';
import { takeBack, turnToAnswerAgain } from './retry.ts';
import { wrapRunResponse, type TranslatedError } from './stream.ts';
import { WORKSPACE_ACTIONS } from '../sandbox/workspace.ts';
import { MEMORY_ACTIONS } from '../memory/tools.ts';

export const DRAFT_HEADER = 'x-bba-draft';
const INFO_PATH = '/info';
const AGENT_PATH = /^\/agent\/([^/]+)\/(run|connect)$/;
const STOP_PATH = /^\/agent\/([^/]+)\/stop\/([^/]+)$/;

const notFound = (message: string) => new AppError({ code: 'APP_NOT_FOUND', message, userMessage: 'Разговор не найден.', status: 404 });

const LOST_FILE_TEXT = {
  access: (name: string) => `Файл лежит в проекте «${name}», к которому у вас больше нет доступа.`,
  archived: (name: string) => `Файл лежит в проекте «${name}», который перенесён в архив.`,
  deleted: (name: string) => `Файл был в проекте «${name}», а проект удалён.`,
} as const;

// «до 16 декабря» in the time zone of the installation.
function dayMonth(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(date);
}

function projectFileLost(name: string, reason: keyof typeof LOST_FILE_TEXT): AppError {
  return appError('APP_PROJECT_ACCESS_LOST', `file of a project gone for the person (${reason})`, { userMessage: LOST_FILE_TEXT[reason](name) });
}

// A copy of a file of the person's computer stays this long after it was brought (spec, section 8.25).
const COMPUTER_COPY_KEEP_MS = 60 * 60 * 1000;

export function registerChatRoutes(app: Hono<AppEnv>, deps: ChatDeps & { copilot: CopilotHandler }): void {
  // The mail actions are the same for every person; the chat line says «Почта · …» (spec, section 8.24).
  const mailActions = describeTools(createMailTools({ db: deps.db, mail: deps.mail, workspaceRoot: deps.workspaceRoot }));
  const mailSystems = Object.fromEntries(MAIL_TOOL_NAMES.map((name) => [name, MAIL_SYSTEM]));
  // The tools of the browser for a folder of the person's computer (spec, section 8.25): read-only.
  const computerActions = Object.fromEntries(Object.entries(COMPUTER_ACTION_TITLES).map(([name, title]) => [name, { title, fields: {}, readOnly: true }]));
  const computerSystems = Object.fromEntries(Object.values(COMPUTER_TOOLS).map((name) => [name, COMPUTER_SYSTEM]));
  // A failure of a run in our code and words: the text of RUN_ERROR, or the failure Mastra kept in
  // a broken answer (spec, section 9.1).
  async function translate(userId: string, failure: unknown): Promise<TranslatedError> {
    const raw = typeof failure === 'string' ? failure : String((failure as { message?: unknown } | null)?.message ?? failure);
    const code = /^(APP_[A-Z0-9_]+):/.exec(raw)?.[1];
    const known = code ? (ERROR_CATALOG as Record<string, { userMessage: string }>)[code] : undefined;
    if (code && known) return { code, message: known.userMessage };
    const error = await deps.gateway.translateError(typeof failure === 'string' ? new Error(failure) : failure, userId);
    return { code: error.code, message: error.userMessage };
  }

  app.get('/app/api/agents', async (c) => {
    const a = access(c);
    const { rows } = await deps.db.query<{ agent_id: string; starters: string[] }>('SELECT agent_id, starters FROM app.agent_overrides WHERE starters IS NOT NULL');
    const ownStarters = new Map(rows.map((r) => [r.agent_id, r.starters]));
    const marks = await agentMarks(deps.db);
    const seen = deps.connections.actionsSeen();
    const agents = deps.registry.agents
      .filter((rt) => a.isSuperadmin || a.agentIds.has(rt.passport.id))
      .map((rt) => ({
        id: rt.passport.id,
        name: rt.passport.name,
        description: rt.passport.description,
        starters: ownStarters.get(rt.passport.id) ?? rt.passport.starters,
        mark: chatMark(marks.get(rt.passport.id) ?? DEFAULT_MARK),
        actions: {
          ...WORKSPACE_ACTIONS,
          ...MEMORY_ACTIONS,
          ...mailActions,
          ...computerActions,
          ...Object.fromEntries(Object.entries(seen).filter(([tool]) => rt.connectorIds.some((id) => tool.startsWith(`${serverKey(id)}_`)))),
          ...agentActions(rt),
          ...subagentCalls(rt),
        },
        systems: {
          tools: { ...mailSystems, ...computerSystems, ...rt.toolSystems },
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
      return connectResponse({ db: deps.db, memory: deps.memory, translate: (failure) => translate(a.userId, failure) }, { userId: a.userId, resourceId, agentId, threadId });
    }
    const input = (await c.req.raw.clone().json()) as RunInput;
    const run = await prepareRun(deps, a, agentId, mode, input);
    try {
      // The name of the conversation is looked for beside the answer (spec, 8.16): started before
      // the turn, so the history it reads does not hold the new message yet.
      const naming = await startNaming(deps.naming, run, newMessageOf(input));
      // Messages whose shown words a repeated model call dropped, for the chat (spec, 9.1).
      const discarded: string[] = [];
      const res = await deps.copilot.handle(c.req.raw, { kind: 'run', run, onMessageDiscarded: (messageId) => discarded.push(messageId), onAgentEnd: () => settleRun(deps, run) });
      // The cancelled call shows the arguments as the model sent them (the database keeps a summary).
      const sent = run.declinedCalls.length > 0 ? await toolCallArgsOf(deps.memory, run.threadId, run.resourceId) : new Map<string, unknown>();
      const afterStart = run.declinedCalls.flatMap((d) => declinedCallEvents({ ...d, args: sent.get(d.toolCallId) ?? d.args }));
      return wrapRunResponse(res, {
        onEnd: () => endRun(deps, run),
        translate: (raw) => translate(a.userId, raw),
        afterStart,
        takeDiscarded: () => discarded.splice(0),
        title: naming ? { threadId: run.threadId, result: naming.result, waitAtEndMs: deps.naming.waitAtEndMs } : null,
      });
    } catch (error) {
      endRun(deps, run);
      settleRun(deps, run);
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
    // Only the mark: Mastra merges it under a row lock and keeps the name (spec, 8.16).
    if (thread.metadata?.unread === true) await deps.memory.updateThread({ id: thread.id, metadata: { unread: false } });
    return c.json({ thread: { id: thread.id, title: thread.title, agentId: thread.metadata?.agentId }, messages: toHistory(messages as never) });
  });

  // The name of one's own conversation for «Переименовать» in its header (spec, 8.16). Unlike
  // …/messages it reads nothing else and leaves the mark «новое» as it is.
  app.get('/app/api/threads/:threadId', async (c) => {
    const thread = await deps.memory.getThreadById({ threadId: c.req.param('threadId') });
    if (!thread || thread.resourceId !== access(c).userId) {
      throw new AppError({ code: 'APP_NOT_FOUND', message: 'foreign or unknown thread', userMessage: 'Разговор не найден.', status: 404 });
    }
    const body: ThreadNameResponse = { thread: { id: thread.id, title: thread.title ?? '' } };
    return c.json(body);
  });

  // The person names their own conversation; the model never names it after that (spec, 8.16).
  app.patch('/app/api/threads/:threadId', async (c) => {
    const threadId = c.req.param('threadId');
    const { title } = await parseJson(c, renameThreadSchema);
    const clean = title.replace(/\s+/g, ' ');
    await renameThread(deps.db, access(c).userId, threadId, clean);
    const body: RenameThreadResponse = { thread: { id: threadId, title: clean } };
    return c.json(body);
  });

  // «Ответить заново» of the person's own conversation or their draft check of an agent's prompt.
  // The turn leaves the conversation only when the question sent again would start a run now.
  app.post('/app/api/threads/:threadId/retry', async (c) => {
    const a = access(c);
    const { questionId } = await parseJson(c, retryTurnSchema);
    const thread = await deps.memory.getThreadById({ threadId: c.req.param('threadId') });
    if (!thread || (thread.resourceId !== a.userId && thread.resourceId !== draftResourceId(a.userId))) throw notFound('answer again in a foreign or unknown thread');
    const turn = await turnToAnswerAgain(
      { db: deps.db, memory: deps.memory, codeOf: async (failure) => (await translate(a.userId, failure)).code },
      { userId: a.userId, threadId: thread.id, resourceId: thread.resourceId, questionId },
    );
    const agentId = thread.metadata?.agentId;
    if (typeof agentId !== 'string') throw new Error(`thread ${thread.id} has no agentId in its metadata`);
    await assertNewTurnAllowed(deps, a, agentId, thread.resourceId === a.userId ? 'published' : 'draft', thread.id);
    const body: RetryTurnResponse = { text: await takeBack(deps.memory, turn) };
    return c.json(body);
  });

  app.delete('/app/api/threads/:threadId', async (c) => {
    const userId = access(c).userId;
    // Files stay: they belong to the files folder, not to the conversation (spec, section 8.9).
    await deleteThread(deps.memory, deps.db, userId, c.req.param('threadId'));
    return c.json({ ok: true });
  });

  // The project of a conversation and where its files are (spec, sections 8.9 and 8.20): the project's
  // folder — with its creator — when the person sees the project, otherwise the person's own. Only the
  // person's own conversation or their draft check of a prompt; a conversation not saved yet (a file
  // attached before the first message) is their own.
  async function threadFolders(userId: string, threadId: string): Promise<{ state: ThreadProjectState; area: Area; folder: () => string; inArea: (path: string) => string }> {
    const thread = await deps.memory.getThreadById({ threadId });
    if (thread && thread.resourceId !== userId && thread.resourceId !== draftResourceId(userId)) {
      throw new AppError({ code: 'APP_NOT_FOUND', message: 'foreign thread', userMessage: 'Разговор не найден.', status: 404 });
    }
    const state = await threadProjectState(deps.db, userId, threadId);
    const area = areaOf(userId, state.state === 'active' ? state.project : null);
    const owner = state.state === 'active' ? state.project.user_id : userId;
    const projectId = state.state === 'active' ? state.project.id : null;
    return {
      state,
      area,
      // Made on first use, so only while the area is held.
      folder: () => contextRoot(deps.workspaceRoot, owner, projectId),
      // A path from the files folder as the path of the area (core/storage).
      inArea: (path: string) => {
        const files = filesRoot(deps.workspaceRoot, owner, projectId);
        return `${filesPrefix(area)}${relative(files, resolveInside(files, path))}`;
      },
    };
  }

  // The folder is on the disk while `work` runs (an S3 bucket keeps the files, spec section 8.23).
  async function inFolder<T>(found: { area: Area; folder: () => string }, how: 'read' | 'write', work: (folder: string) => T | Promise<T>): Promise<T> {
    const release = await deps.storage.hold(found.area, how);
    try {
      return await work(found.folder());
    } finally {
      await release();
    }
  }

  // An attachment goes where the agent of the conversation works: a project gone for the person
  // leaves them their own folder.
  app.post('/app/api/threads/:threadId/files', async (c) => {
    const found = await threadFolders(access(c).userId, c.req.param('threadId'));
    const file = await readUploadedFile(c);
    const data = new Uint8Array(await file.arrayBuffer());
    return c.json(await inFolder(found, 'write', (folder) => saveFile(folder, file.name, data)), 201);
  });

  // A file of the person's computer the agent reads (spec, section 8.25): the browser sends it, it lies in the
  // hidden folder of the conversation's working folder for the skills — not among the project's files, not
  // stored in a bucket. A newer copy of the same path replaces the older.
  app.post('/app/api/threads/:threadId/computer-file', async (c) => {
    const found = await threadFolders(access(c).userId, c.req.param('threadId'));
    const file = await readUploadedFile(c);
    const path = (await c.req.parseBody()).path;
    if (typeof path !== 'string' || !path.trim()) throw appError('APP_VALIDATION_FAILED', 'no path of the computer file', { userMessage: 'Не указан путь файла.' });
    const data = new Uint8Array(await file.arrayBuffer());
    const userId = access(c).userId;
    // Each person's copies apart, and gone an hour later: in a shared project colleagues' agents share the
    // working folder (spec, section 8.25).
    const saved = await inFolder(found, 'write', (folder) => {
      pruneOlderThan(folder, `${COMPUTER_COPIES}/${userId}`, COMPUTER_COPY_KEEP_MS);
      return putInFolder(folder, `${COMPUTER_COPIES}/${userId}`, path, data);
    });
    return c.json(saved, 201);
  });

  // What «Скачать» of a file block will find (spec, sections 8.18 and 8.20): the file; or it was
  // removed and lies in the project's trash (found by its exact path), or is gone; or it is a file of
  // a project gone for the person — a file of their own folder in such a conversation is still theirs.
  async function fileStatus(userId: string, threadId: string, path: string): Promise<ThreadFileStatus> {
    const found = await threadFolders(userId, threadId);
    const { state } = found;
    const inArea = found.inArea(path);
    const full = inArea.slice(filesPrefix(found.area).length);
    const name = basename(full);
    // From the copy, or from the list of the bucket: a check brings nothing to the disk (spec, 8.23).
    if (await deps.storage.exists(found.area, inArea)) return { state: 'ok' };
    if (state.state === 'lost') return { state: 'lost', name, projectName: state.name, reason: state.reason };
    if (state.state === 'active') {
      const trashed = await trashedAt(deps.db, state.project.id, full);
      if (trashed) return { state: 'trash', name, projectId: state.project.id, trashId: trashed.id, expiresAt: trashed.expiresAt.toISOString() };
    }
    return { state: 'deleted', name };
  }

  app.get('/app/api/threads/:threadId/file/status', async (c) => c.json(await fileStatus(access(c).userId, c.req.param('threadId'), c.req.query('path') ?? '')));

  // «Скачать» of the file block a file the agent made (spec, section 8.18).
  app.get('/app/api/threads/:threadId/file', async (c) => {
    const path = c.req.query('path') ?? '';
    const userId = access(c).userId;
    const status = await fileStatus(userId, c.req.param('threadId'), path);
    if (status.state === 'lost') throw projectFileLost(status.projectName, status.reason);
    if (status.state === 'trash') {
      throw appError('APP_FILE_IN_TRASH', 'the file was removed into the project trash', { userMessage: `Файл «${status.name}» удалён из рабочей папки. Он в корзине проекта до ${dayMonth(new Date(status.expiresAt), deps.timezone)}.` });
    }
    if (status.state === 'deleted') throw appError('APP_FILE_DELETED', 'the file is gone', { userMessage: `Файл «${status.name}» удалён из рабочей папки — скачать его нельзя.` });
    const found = await threadFolders(userId, c.req.param('threadId'));
    const inArea = found.inArea(path);
    return fileResponse(await deps.storage.openFile(found.area, inArea), `Файл «${basename(path)}» удалён из рабочей папки — скачать его нельзя.`, basename(inArea));
  });
}
