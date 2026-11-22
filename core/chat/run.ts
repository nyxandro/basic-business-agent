// Everything that must hold before a chat run starts (spec, scenario 2, sections 8.4 and 10):
// the agent is open to the employee, the conversation is theirs, a pending question is answered
// or cancelled by the new message, limits allow the call, and no other tab runs this conversation.
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { Memory } from '@mastra/memory';
import { decide, expireChatQuestions, expiredOpenForThread, findByCall, markClosed, pendingForThread, termHoursOf, type ApprovalRequest } from '../approvals/requests.ts';
import type { AccessContext } from '../auth/access.ts';
import type { Db } from '../db/pool.ts';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { writeJournal } from '../journal/journal.ts';
import type { Registry } from '../loader/registry.ts';
import { draftResourceId, ensureThread, titleFrom } from '../memory/memory.ts';
import { runProjectOf, runProjectOfWaitingAnswer, type RunProject } from '../projects/access.ts';
import { markSeen } from '../projects/projects.ts';
import { logEvent } from '../server/log.ts';
import { settleSnapshot, takeSnapshot, type ProjectSnapshot } from '../projects/trash.ts';
import { projectArea, userArea } from '../storage/areas.ts';
import type { FileStorage, Release } from '../storage/engine.ts';
import type { MailService } from '../mail/service.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { chooseModels, type ModelChoice } from '../models/resolve.ts';
import { REQUEST_KEYS, type RunKind } from '../runtime/request-keys.ts';
import type { SkillsRuntime } from '../skills-admin/runtime.ts';
import { abilitiesValue, readAbilities } from '../abilities/abilities.ts';
import type { AgentAbilities } from '@bba/contracts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { NamingDeps } from './naming.ts';
import type { Presence } from '../notifications/presence.ts';
import type { Activity } from '../notifications/activity.ts';
import { newRunLife, tellAfterLeaving, type RunLife } from './after-leaving.ts';
import type { ChainService } from '../approvals/chains.ts';

export interface ChatDeps {
  db: Db;
  memory: Memory;
  registry: Registry;
  gateway: Pick<ModelGateway, 'assertWithinBudget' | 'translateError'>;
  editor: EditorDeps;
  workspaceRoot: string;
  // Time zone of the installation: the day of the subscription's daily cap.
  timezone: string;
  skills: Pick<SkillsRuntime, 'skillsFor'>;
  // Names of the actions of connected systems, for the confirmation card.
  connections: Pick<ConnectionManager, 'actionsSeen' | 'mcpCatalog'>;
  // The service call that names a conversation beside the answer (spec, section 8.16).
  naming: NamingDeps;
  // Where the files are kept: a run holds its folder until the agent ends (spec, section 8.23).
  storage: FileStorage;
  // The mailboxes of employees: the chat names their actions (spec, section 8.24).
  mail: MailService;
  // Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md): the mail actions' descriptions need the tools.
  chains: ChainService;
  // Which conversation is on the screen of the person's visible tabs (docs/specs/[20.11.2026]-notifications.md).
  presence: Pick<Presence, 'isWatching'>;
  // Where agents work now: the blue ring of the conversation in the lists (decision of the owner 22.11).
  activity: Pick<Activity, 'start'>;
}

export interface RunInput {
  threadId?: string;
  messages?: { role: string; content?: unknown }[];
  resume?: { interruptId?: string; status?: string; payload?: unknown }[];
}

export interface PreparedRun {
  agentId: string;
  userId: string;
  resourceId: string;
  threadId: string;
  mode: 'published' | 'draft';
  // Project of the conversation: the sandbox works in its files (they live with its creator), the
  // prompt gets its instructions; or why the project is gone for the person (spec, section 8.20).
  projectId: string | null;
  projectOwnerId: string | null;
  lostProject: RunProject['lostProject'];
  // Files of the project remembered before the answer: what it removes goes into the trash.
  snapshot: ProjectSnapshot | null;
  // The agent's run has begun (core/chat/copilot.ts): its trash is settled when the agent itself ends,
  // not when the browser goes away — CopilotKit lets the agent finish without the browser.
  agentStarted: boolean;
  // The models of the run (core/models/resolve.ts); null where no model is called (agent listing).
  models: ModelChoice | null;
  // Folders of the skills the employee gets, fixed for the run.
  skillPaths: string[];
  // What the agent may do (spec, section 8.30), read at the start of the run; null where no model is called
  // (agent listing).
  abilities: AgentAbilities | null;
  // The run's folder held on the disk (spec, section 8.23): let go when the agent ends, after its trash.
  release: Release | null;
  // How the turn went — did the browser leave before the agent ended (docs/specs/[20.11.2026]-notifications.md).
  life: RunLife;
}

// A turn ready to run, plus the calls its preparation cancelled: the chat must learn about them.
export interface PreparedTurn extends PreparedRun {
  // `expiredHours` — a question that burnt unanswered after so many hours (docs/specs/[20.11.2026]-notifications.md, F4).
  declinedCalls: { toolCallId: string; tool: string; args: unknown; superseded: boolean; expiredHours: number | null }[];
}

export const SAFE_THREAD_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const APPROVAL_PREFIX = 'mastra-approval::';
const SUPERSEDED = 'Отменено: сотрудник написал новое сообщение.';

const busyThreads = new Set<string>();
// The turn of each conversation until its agent ends — «Стоп» comes after the browser's stream closed and finds it here.
const liveRuns = new Map<string, PreparedRun>();
// A draft check of a prompt never belongs to the admin's projects.
const NO_PROJECT: RunProject = { projectId: null, projectOwnerId: null, lostProject: null };

function releaseThread(threadId: string): void {
  busyThreads.delete(threadId);
}

// A turn the server starts itself in a conversation — the continuation after an agreed request of multi-step
// approvals (core/approvals/continue.ts): it takes the conversation as a person's turn does, or waits.
export function holdThreadForServer(threadId: string): boolean {
  if (busyThreads.has(threadId)) return false;
  busyThreads.add(threadId);
  return true;
}

export const releaseThreadForServer = releaseThread;

// What the answer removed from its project goes into the trash (spec, section 8.20) — once, when the
// agent itself has ended: finished, stopped by «Стоп» or failed. A failure of the trash is the
// server's to log, not the answer's; the snapshot is left for the start of the server then.
export function settleRun(deps: Pick<ChatDeps, 'db' | 'workspaceRoot' | 'presence'>, run: PreparedRun): void {
  if (liveRuns.get(run.threadId) === run) liveRuns.delete(run.threadId);
  run.life.endActivity();
  if (run.agentStarted && !run.life.ended) {
    run.life.ended = true;
    // Nobody watched the end — the tab closed or hid, or the person went to another conversation or screen (owner,
    // 22.11): they learn how it ended. «Стоп» is pressed at the screen; a draft check of a prompt is the admin's own.
    const away = run.life.browserLeft || !deps.presence.isWatching(run.userId, run.threadId);
    if (away && !run.life.stopped && run.mode === 'published') void tellAfterLeaving(deps.db, run);
  }
  const { snapshot, release } = run;
  run.snapshot = null;
  run.release = null;
  const settled = snapshot
    ? settleSnapshot(deps.db, deps.workspaceRoot, snapshot).catch((error: unknown) => logEvent('error', 'project_trash_settle_failed', { code: 'APP_INTERNAL', projectId: snapshot.projectId, error }))
    : Promise.resolve();
  // The folder is let go after the trash took what the answer removed; a release never fails.
  if (release) void settled.then(release);
}

// The browser's stream of the answer ended (done, closed tab, error). The thread is free; the trash
// waits for the agent, unless the agent never began (the run was refused before it).
// «Стоп» of the person for the conversation's turn under way (core/chat/routes.ts).
export function noteStopped(threadId: string): void {
  const run = liveRuns.get(threadId);
  if (run) run.life.stopped = true;
}

export function endRun(deps: Pick<ChatDeps, 'db' | 'workspaceRoot' | 'presence'>, run: PreparedRun): void {
  if (run.agentStarted && !run.life.ended) run.life.browserLeft = true;
  releaseThread(run.threadId);
  if (!run.agentStarted) settleRun(deps, run);
}

function threadBusy(threadId: string): AppError {
  return new AppError({
    code: 'APP_CHAT_THREAD_BUSY',
    message: `thread ${threadId} already has a run in progress`,
    userMessage: 'В этом разговоре уже идёт ответ в другой вкладке. Дождитесь его и обновите страницу.',
    status: 409,
  });
}

// What a new message of the person must pass before it starts a run — checked without starting one,
// e.g. before «Ответить заново» takes the broken turn out (spec, section 9.1).
export async function assertNewTurnAllowed(deps: ChatDeps, access: AccessContext, agentId: string, mode: 'published' | 'draft', threadId: string): Promise<void> {
  assertAgentOpen(deps, access, agentId, mode);
  if (busyThreads.has(threadId)) throw threadBusy(threadId);
  await deps.gateway.assertWithinBudget(access.userId);
  await chooseModels(deps.db, deps.timezone, access.userId, agentId);
}

export function agentAccessError(agentId: string): AppError {
  return new AppError({
    code: 'APP_AGENT_ACCESS_DENIED',
    message: `agent ${agentId} is not open to the employee`,
    userMessage: 'У вас нет доступа к этому агенту. Если он нужен для работы, обратитесь к администратору.',
    status: 403,
  });
}

// Superadmins see every agent; everyone else sees the agents of their departments (spec, 8.2).
export function assertAgentOpen(deps: Pick<ChatDeps, 'registry'>, access: AccessContext, agentId: string, mode: 'published' | 'draft'): void {
  if (!deps.registry.get(agentId)) {
    throw new AppError({ code: 'APP_AGENT_NOT_FOUND', message: `agent ${agentId} is not loaded`, userMessage: 'Этот агент больше не доступен. Разговор можно прочитать, но не продолжить.', status: 404 });
  }
  if (mode === 'draft') {
    if (!access.permissions.has('agents')) throw appError('APP_ADMIN_FORBIDDEN', 'draft check needs the agents section');
    return;
  }
  if (!access.isSuperadmin && !access.agentIds.has(agentId)) throw agentAccessError(agentId);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
}

// The message the person sent with this turn; empty for an answer to a question («Да» or «Нет»),
// which comes with the conversation as it was.
export function newMessageOf(input: RunInput): string {
  if ((input.resume ?? []).length > 0) return '';
  return textOf((input.messages ?? []).findLast((m) => m.role === 'user')?.content);
}

export function requestContextFor(run: PreparedRun): RequestContext {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, run.userId);
  rc.set(REQUEST_KEYS.threadId, run.threadId);
  rc.set(REQUEST_KEYS.agentId, run.agentId);
  rc.set(REQUEST_KEYS.runKind, (run.mode === 'draft' ? 'draft' : 'chat') satisfies RunKind);
  if (run.models) {
    rc.set(REQUEST_KEYS.modelId, run.models.primary);
    if (run.models.fallback) rc.set(REQUEST_KEYS.fallbackModelId, run.models.fallback);
  }
  if (run.projectId && run.projectOwnerId) {
    rc.set(REQUEST_KEYS.projectId, run.projectId);
    rc.set(REQUEST_KEYS.projectOwnerId, run.projectOwnerId);
  }
  if (run.lostProject) rc.set(REQUEST_KEYS.lostProject, JSON.stringify(run.lostProject));
  if (run.snapshot && run.snapshot.projectId === run.projectId) rc.set(REQUEST_KEYS.projectSnapshot, run.snapshot.id);
  rc.set(REQUEST_KEYS.skillPaths, JSON.stringify(run.skillPaths));
  if (run.abilities) rc.set(REQUEST_KEYS.abilities, abilitiesValue(run.abilities));
  return rc;
}

function parseInterrupt(id: string | undefined): { runId: string; toolCallId: string } | null {
  if (!id?.startsWith(APPROVAL_PREFIX)) return null;
  const [runId, toolCallId] = id.slice(APPROVAL_PREFIX.length).split('::');
  return runId && toolCallId ? { runId, toolCallId } : null;
}

async function journalDecline(deps: ChatDeps, run: PreparedRun, tool: string, errorCode: string | null): Promise<void> {
  await writeJournal(deps.db, { userId: run.userId, agentId: run.agentId, runKind: 'chat', event: 'tool_declined', tool, approvedBy: run.userId, result: 'declined', errorCode });
}

const expiredReason = (q: ApprovalRequest) => `Истекло: сотрудник не ответил за ${termHoursOf(q)} ч.`;

// A question past its term: «Вопрос истёк», with its term.
function questionExpired(q: ApprovalRequest): AppError {
  return appError('APP_APPROVAL_EXPIRED', `approval ${q.id} expired`, { userMessage: `Вопрос истёк: вы не ответили за ${termHoursOf(q)} ч. Действие не выполнено.` });
}

// A new message instead of "Да"/"Нет" cancels the waiting action (spec, scenario 2); a question that burnt meanwhile
// gets its refusal now — the sweep only marked it (docs/specs/[20.11.2026]-notifications.md, F4).
async function cancelPending(deps: ChatDeps, run: PreparedRun, agent: Agent): Promise<PreparedTurn['declinedCalls']> {
  const cancelled: PreparedTurn['declinedCalls'] = [];
  await expireChatQuestions(deps.db);
  const toClose = [
    ...(await expiredOpenForThread(deps.db, run.userId, run.threadId)).map((q) => ({ q, expired: true })),
    ...(await pendingForThread(deps.db, run.userId, run.threadId)).map((q) => ({ q, expired: false })),
  ];
  for (const { q: pending, expired } of toClose) {
    // Marked before the refusal, as a superseded question is declined before it: a refusal that keeps failing (the run
    // is gone in Mastra) must not lock the conversation for every next message; `expired` already runs nothing.
    if (expired) await markClosed(deps.db, pending.id);
    else if (!(await decide(deps.db, pending.id, 'declined', 'APP_CHAT_SUPERSEDED'))) continue;
    cancelled.push({ toolCallId: pending.toolCallId, tool: pending.tool, args: pending.args, superseded: !expired, expiredHours: expired ? termHoursOf(pending) : null });
    // The waiting answer goes on in its own project: one other than the new message's gets its own
    // snapshot, so what the agent removes after «отменено» reaches that project's trash too.
    const waiting = await runProjectOfWaitingAnswer(deps.db, pending.projectId);
    const otherProject = waiting.projectId && waiting.projectOwnerId && waiting.projectId !== run.projectId ? { projectId: waiting.projectId, ownerId: waiting.projectOwnerId } : null;
    const releaseOther = otherProject ? await deps.storage.hold(projectArea(otherProject.projectId, otherProject.ownerId), 'write') : null;
    const other = otherProject ? takeSnapshot(deps.workspaceRoot, { ...otherProject, userId: run.userId, threadId: run.threadId }) : null;
    try {
      const stream = await agent.declineToolCall({
        runId: pending.runId,
        toolCallId: pending.toolCallId,
        reason: expired ? expiredReason(pending) : SUPERSEDED,
        memory: { thread: run.threadId, resource: run.resourceId },
        requestContext: requestContextFor({ ...run, ...waiting, ...(other ? { snapshot: other } : {}) }),
      });
      await stream.consumeStream();
    } finally {
      if (other) await settleSnapshot(deps.db, deps.workspaceRoot, other).catch((error: unknown) => logEvent('error', 'project_trash_settle_failed', { code: 'APP_INTERNAL', projectId: other.projectId, error }));
      if (releaseOther) await releaseOther();
    }
    // An expired question was journalled when it burnt.
    if (!expired) await journalDecline(deps, run, pending.tool, 'APP_CHAT_SUPERSEDED');
  }
  return cancelled;
}

export async function prepareRun(deps: ChatDeps, access: AccessContext, agentId: string, mode: 'published' | 'draft', input: RunInput): Promise<PreparedTurn> {
  assertAgentOpen(deps, access, agentId, mode);
  const threadId = input.threadId ?? '';
  if (!SAFE_THREAD_ID.test(threadId)) throw appError('APP_VALIDATION_FAILED', `bad thread id "${threadId}"`);
  const project = mode === 'draft' ? NO_PROJECT : await runProjectOf(deps.db, access.userId, threadId);
  const abilities = await readAbilities(deps.db, agentId);
  const skillPaths = await deps.skills.skillsFor(access.userId, { documents: abilities.commands });
  const run: PreparedRun = { agentId, userId: access.userId, resourceId: mode === 'draft' ? draftResourceId(access.userId) : access.userId, threadId, mode, ...project, snapshot: null, agentStarted: false, models: null, skillPaths, abilities, release: null, life: newRunLife() };
  const firstUser = (input.messages ?? []).find((m) => m.role === 'user');
  await ensureThread(deps.memory, { threadId, resourceId: run.resourceId, agentId, kind: mode === 'draft' ? 'draft' : 'chat', title: titleFrom(textOf(firstUser?.content)) });
  // Working in a project shared to the person takes its «новое» off.
  if (run.projectId) await markSeen(deps.db, access.userId, run.projectId);

  if (busyThreads.has(threadId)) throw threadBusy(threadId);
  busyThreads.add(threadId);
  liveRuns.set(threadId, run);
  // The conversation shows its blue ring from now to the end of the agent (or of the refused run: settleRun).
  if (mode === 'published') run.life.endActivity = deps.activity.start(run.userId, threadId);
  const declinedCalls: PreparedTurn['declinedCalls'] = [];
  try {
    const resume = input.resume?.[0];
    const call = parseInterrupt(resume?.interruptId);
    const agent = await resolveAgent(deps.editor, agentId, mode);
    const choose = () => chooseModels(deps.db, deps.timezone, run.userId, agentId);
    // Once the run's folder is known: it is held on the disk for the answer (spec, 8.23), and a project's
    // files are remembered as they were before it (8.20).
    const remember = async () => {
      run.release = await deps.storage.hold(run.projectId && run.projectOwnerId ? projectArea(run.projectId, run.projectOwnerId) : userArea(run.userId), 'write');
      if (run.projectId && run.projectOwnerId) run.snapshot = takeSnapshot(deps.workspaceRoot, { projectId: run.projectId, ownerId: run.projectOwnerId, userId: run.userId, threadId });
    };

    if (call) {
      const pending = await findByCall(deps.db, run.userId, call.runId, call.toolCallId);
      if (!pending || pending.threadId !== threadId) throw appError('APP_NOT_FOUND', 'unknown approval request', { userMessage: 'Этот вопрос уже не актуален. Обновите страницу.' });
      if (pending.taskId) {
        throw appError('APP_VALIDATION_FAILED', `approval ${pending.id} belongs to background task ${pending.taskId}`, { userMessage: 'На вопросы фоновых задач отвечают на экране «Ждёт подтверждения».' });
      }
      if (pending.status === 'expired') throw questionExpired(pending);
      if (pending.status !== 'pending') throw appError('APP_VALIDATION_FAILED', `approval ${pending.id} is ${pending.status}`, { userMessage: 'По этому действию решение уже принято.' });
      // «Да» or «Нет» goes on with the answer that waited: it is finished in the project it began in.
      Object.assign(run, await runProjectOfWaitingAnswer(deps.db, pending.projectId));
      await remember();
      if (pending.expiresAt.getTime() < Date.now()) {
        await expireChatQuestions(deps.db);
        throw questionExpired(pending);
      }
      const approved = resume?.status === 'resolved' && (resume.payload === true || (resume.payload as { approved?: unknown } | undefined)?.approved === true);
      if (!approved) {
        if (!(await decide(deps.db, pending.id, 'declined'))) throw appError('APP_APPROVAL_DECIDED', `approval ${pending.id} was decided meanwhile`);
        await journalDecline(deps, run, pending.tool, null);
        declinedCalls.push({ toolCallId: pending.toolCallId, tool: pending.tool, args: pending.args, superseded: false, expiredHours: null });
        // The agent goes on after "Нет": a refusal is recorded even when no model can answer now.
        run.models = await choose();
      } else {
        // The approved action runs only if access and limits still hold now (spec, section 8.4).
        try {
          await deps.gateway.assertWithinBudget(run.userId);
          run.models = await choose();
        } catch (error) {
          await decide(deps.db, pending.id, 'failed', error instanceof AppError ? error.code : 'APP_INTERNAL');
          throw error;
        }
        if (!(await decide(deps.db, pending.id, 'approved'))) throw appError('APP_APPROVAL_DECIDED', `approval ${pending.id} was decided meanwhile`);
      }
    } else {
      await deps.gateway.assertWithinBudget(run.userId);
      run.models = await choose();
      await remember();
      declinedCalls.push(...(await cancelPending(deps, run, agent)));
    }
  } catch (error) {
    endRun(deps, run);
    throw error;
  }
  return { ...run, declinedCalls };
}
