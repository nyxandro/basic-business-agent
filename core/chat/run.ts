// Everything that must hold before a chat run starts (spec, scenario 2, sections 8.4 and 10):
// the agent is open to the employee, the conversation is theirs, a pending question is answered
// or cancelled by the new message, limits allow the call, and no other tab runs this conversation.
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { Memory } from '@mastra/memory';
import { decide, findByCall, pendingForThread, type ApprovalRequest } from '../approvals/requests.ts';
import type { AccessContext } from '../auth/access.ts';
import type { Db } from '../db/pool.ts';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { writeJournal } from '../journal/journal.ts';
import type { Registry } from '../loader/registry.ts';
import { draftResourceId, ensureThread, titleFrom } from '../memory/memory.ts';
import { projectOfThread } from '../projects/projects.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { chooseModels, type ModelChoice } from '../models/resolve.ts';
import { REQUEST_KEYS, type RunKind } from '../runtime/request-keys.ts';
import type { SkillsRuntime } from '../skills-admin/runtime.ts';

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
  // Project of the conversation: the sandbox works in its files, the prompt gets its instructions.
  projectId: string | null;
  // The models of the run (core/models/resolve.ts); null where no model is called (agent listing).
  models: ModelChoice | null;
  // Folders of the skills the employee gets, fixed for the run.
  skillPaths: string[];
}

// A turn ready to run, plus the calls its preparation cancelled: the chat must learn about them.
export interface PreparedTurn extends PreparedRun {
  declinedCalls: { toolCallId: string; tool: string; args: unknown; superseded: boolean }[];
}

export const SAFE_THREAD_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const APPROVAL_PREFIX = 'mastra-approval::';
const SUPERSEDED = 'Отменено: сотрудник написал новое сообщение.';

const busyThreads = new Set<string>();

export function releaseThread(threadId: string): void {
  busyThreads.delete(threadId);
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
  if (run.projectId) rc.set(REQUEST_KEYS.projectId, run.projectId);
  rc.set(REQUEST_KEYS.skillPaths, JSON.stringify(run.skillPaths));
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

// A new message instead of "Да"/"Нет" cancels the waiting action (spec, scenario 2).
async function cancelPending(deps: ChatDeps, run: PreparedRun, agent: Agent): Promise<ApprovalRequest[]> {
  const cancelled: ApprovalRequest[] = [];
  for (const pending of await pendingForThread(deps.db, run.userId, run.threadId)) {
    if (!(await decide(deps.db, pending.id, 'declined', 'APP_CHAT_SUPERSEDED'))) continue;
    cancelled.push(pending);
    const stream = await agent.declineToolCall({
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      reason: SUPERSEDED,
      memory: { thread: run.threadId, resource: run.resourceId },
      requestContext: requestContextFor(run),
    });
    await stream.consumeStream();
    await journalDecline(deps, run, pending.tool, 'APP_CHAT_SUPERSEDED');
  }
  return cancelled;
}

export async function prepareRun(deps: ChatDeps, access: AccessContext, agentId: string, mode: 'published' | 'draft', input: RunInput): Promise<PreparedTurn> {
  assertAgentOpen(deps, access, agentId, mode);
  const threadId = input.threadId ?? '';
  if (!SAFE_THREAD_ID.test(threadId)) throw appError('APP_VALIDATION_FAILED', `bad thread id "${threadId}"`);
  // A draft check of a prompt never belongs to the admin's projects.
  const projectId = mode === 'draft' ? null : await projectOfThread(deps.db, access.userId, threadId);
  const run: PreparedRun = { agentId, userId: access.userId, resourceId: mode === 'draft' ? draftResourceId(access.userId) : access.userId, threadId, mode, projectId, models: null, skillPaths: await deps.skills.skillsFor(access.userId) };
  const firstUser = (input.messages ?? []).find((m) => m.role === 'user');
  await ensureThread(deps.memory, { threadId, resourceId: run.resourceId, agentId, kind: mode === 'draft' ? 'draft' : 'chat', title: titleFrom(textOf(firstUser?.content)) });

  if (busyThreads.has(threadId)) {
    throw new AppError({
      code: 'APP_CHAT_THREAD_BUSY',
      message: `thread ${threadId} already has a run in progress`,
      userMessage: 'В этом разговоре уже идёт ответ в другой вкладке. Дождитесь его и обновите страницу.',
      status: 409,
    });
  }
  busyThreads.add(threadId);
  const declinedCalls: PreparedTurn['declinedCalls'] = [];
  try {
    const resume = input.resume?.[0];
    const call = parseInterrupt(resume?.interruptId);
    const agent = await resolveAgent(deps.editor, agentId, mode);
    const choose = () => chooseModels(deps.db, deps.timezone, run.userId, agentId);

    if (call) {
      const pending = await findByCall(deps.db, run.userId, call.runId, call.toolCallId);
      if (!pending || pending.threadId !== threadId) throw appError('APP_NOT_FOUND', 'unknown approval request', { userMessage: 'Этот вопрос уже не актуален. Обновите страницу.' });
      if (pending.taskId) {
        throw appError('APP_VALIDATION_FAILED', `approval ${pending.id} belongs to background task ${pending.taskId}`, { userMessage: 'На вопросы фоновых задач отвечают на экране «Ждёт подтверждения».' });
      }
      if (pending.status !== 'pending') throw appError('APP_VALIDATION_FAILED', `approval ${pending.id} is ${pending.status}`, { userMessage: 'По этому действию решение уже принято.' });
      if (pending.expiresAt.getTime() < Date.now()) throw appError('APP_NOT_FOUND', `approval ${pending.id} expired`, { userMessage: 'Этот вопрос уже не актуален. Обновите страницу.' });
      const approved = resume?.status === 'resolved' && (resume.payload === true || (resume.payload as { approved?: unknown } | undefined)?.approved === true);
      if (!approved) {
        if (!(await decide(deps.db, pending.id, 'declined'))) throw appError('APP_APPROVAL_DECIDED', `approval ${pending.id} was decided meanwhile`);
        await journalDecline(deps, run, pending.tool, null);
        declinedCalls.push({ toolCallId: pending.toolCallId, tool: pending.tool, args: pending.args, superseded: false });
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
      for (const p of await cancelPending(deps, run, agent)) declinedCalls.push({ toolCallId: p.toolCallId, tool: p.tool, args: p.args, superseded: true });
    }
  } catch (error) {
    busyThreads.delete(threadId);
    throw error;
  }
  return { ...run, declinedCalls };
}
