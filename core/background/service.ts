// Background tasks (spec, scenario 4, section 8.6; verified at step 0, V5). Each task is a row of
// app.background_tasks (the source of truth) and a Mastra schedule of the one-step workflow
// "background-run". A run works on behalf of the owner — their access, limits, conversation
// "bg:<taskId>" — and its questions wait on the approvals screen for up to 72 hours.
import { RequestContext } from '@mastra/core/request-context';
import type { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { Memory } from '@mastra/memory';
import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decide as decideRow, getApproval, type ApprovalRequest } from '../approvals/requests.ts';
import { loadAccess } from '../auth/access.ts';
import type { Db } from '../db/pool.ts';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { writeJournal } from '../journal/journal.ts';
import type { Registry } from '../loader/registry.ts';
import { ensureThread } from '../memory/memory.ts';
import { projectOfThread } from '../projects/projects.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { chooseModels, type ModelChoice } from '../models/resolve.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';

export const BACKGROUND_WORKFLOW_ID = 'background-run';
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 60 * 1000;
const EXPIRY_SWEEP_MS = 5 * 60 * 1000;
const EXPIRED_REASON = 'Истекло: сотрудник не ответил за 72 часа.';

export type RunOutcome = 'done' | 'awaiting-approval' | 'skipped' | 'failed' | 'paused';

export interface TaskInput {
  id: string;
  title: string;
  agentId: string;
  ownerUserId: string;
  cron: string;
  prompt: string;
}

interface TaskRow {
  id: string;
  title: string;
  agent_id: string;
  owner_user_id: string | null;
  cron: string;
  prompt: string;
  status: 'active' | 'paused';
  thread_id: string;
  last_run_at: Date | null;
  created_at: Date;
}

export interface BackgroundDeps {
  db: Db;
  memory: Memory;
  registry: Registry;
  gateway: Pick<ModelGateway, 'assertWithinBudget' | 'translateError'>;
  editor: EditorDeps;
  timezone: string;
}

export interface BackgroundService {
  runTask(taskId: string, reason: 'schedule' | 'catch-up' | 'manual'): Promise<RunOutcome>;
  startAgentRun(input: { agentId: string; userId: string; prompt: string; title: string }): Promise<{ threadId: string; outcome: RunOutcome }>;
  decide(userId: string, approvalId: string, approved: boolean): Promise<void>;
  expireOverdue(): Promise<number>;
  syncSchedules(): Promise<void>;
  catchUp(now?: Date): Promise<string[]>;
  createTask(input: TaskInput): Promise<void>;
  start(): void;
  stop(): void;
}

const TASK_ID = /^[a-z0-9][a-z0-9-]{1,60}$/;

export function createBackgroundWorkflow(service: () => BackgroundService) {
  const input = z.object({ taskId: z.string() });
  const output = z.object({ outcome: z.string() });
  const step = createStep({
    id: 'run-background-task',
    inputSchema: input,
    outputSchema: output,
    execute: async ({ inputData }) => ({ outcome: await service().runTask(inputData.taskId, 'schedule') }),
  });
  return createWorkflow({ id: BACKGROUND_WORKFLOW_ID, inputSchema: input, outputSchema: output }).then(step).commit();
}

export function createBackgroundService(deps: BackgroundDeps): BackgroundService {
  const { db, memory } = deps;
  const mastra = (): Mastra => deps.editor.mastra;
  const timers: NodeJS.Timeout[] = [];

  async function task(taskId: string): Promise<TaskRow | null> {
    const { rows } = await db.query<TaskRow>('SELECT * FROM app.background_tasks WHERE id = $1', [taskId]);
    return rows[0] ?? null;
  }

  async function pause(row: TaskRow, reason: string): Promise<void> {
    await db.query("UPDATE app.background_tasks SET status = 'paused', paused_reason = $2, updated_at = now() WHERE id = $1", [row.id, reason]);
    await writeJournal(db, { userId: row.owner_user_id, agentId: row.agent_id, runKind: 'background', taskId: row.id, event: 'background_skipped', result: 'skipped', errorCode: `APP_TASK_PAUSED_${reason.toUpperCase()}` });
    logEvent('warn', 'background_task_paused', { taskId: row.id, reason });
  }

  async function contextFor(row: { id: string | null; agent_id: string; thread_id: string }, userId: string, models: ModelChoice): Promise<RequestContext> {
    const projectId = await projectOfThread(db, userId, row.thread_id);
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, userId);
    rc.set(REQUEST_KEYS.threadId, row.thread_id);
    rc.set(REQUEST_KEYS.agentId, row.agent_id);
    rc.set(REQUEST_KEYS.runKind, 'background');
    if (row.id) rc.set(REQUEST_KEYS.taskId, row.id);
    rc.set(REQUEST_KEYS.modelId, models.primary);
    if (models.fallback) rc.set(REQUEST_KEYS.fallbackModelId, models.fallback);
    if (projectId) rc.set(REQUEST_KEYS.projectId, projectId);
    return rc;
  }

  async function markUnread(threadId: string, taskId: string | null): Promise<void> {
    if (taskId) await db.query('UPDATE app.background_tasks SET unread_result = true WHERE id = $1', [taskId]);
    const thread = await memory.getThreadById({ threadId });
    if (thread) await memory.updateThread({ id: threadId, title: thread.title ?? '', metadata: { ...(thread.metadata ?? {}), unread: true } });
  }

  // Runs the agent on behalf of the owner and reads the stream to its end.
  async function execute(row: { id: string | null; agent_id: string; thread_id: string; prompt: string; title: string }, userId: string): Promise<RunOutcome> {
    const journalBase = { userId, agentId: row.agent_id, runKind: 'background' as const, taskId: row.id };
    try {
      await deps.gateway.assertWithinBudget(userId);
      const agent = await resolveAgent(deps.editor, row.agent_id, 'published');
      const models = await chooseModels(db, deps.timezone, userId, row.agent_id);
      await ensureThread(memory, { threadId: row.thread_id, resourceId: userId, agentId: row.agent_id, kind: 'background', title: `Задача: ${row.title}` });
      await writeJournal(db, { ...journalBase, event: 'background_started', result: 'started' });
      const stream = await agent.stream(row.prompt, { memory: { thread: row.thread_id, resource: userId }, requestContext: await contextFor(row, userId, models) });
      let awaiting = false;
      for await (const part of stream.fullStream) {
        if (part.type === 'tool-call-approval') awaiting = true;
        if (part.type === 'error') throw (part.payload as { error: unknown }).error;
      }
      await markUnread(row.thread_id, row.id);
      await writeJournal(db, { ...journalBase, event: 'background_finished', result: 'ok' });
      return awaiting ? 'awaiting-approval' : 'done';
    } catch (error) {
      const translated = isAppError(error) ? error : await deps.gateway.translateError(error, userId);
      await writeJournal(db, { ...journalBase, event: 'background_finished', result: 'error', errorCode: translated.code });
      logEvent('error', 'background_run_failed', { taskId: row.id, code: translated.code, error });
      return 'failed';
    }
  }

  async function ownerCanRun(row: TaskRow): Promise<string | null> {
    if (!row.owner_user_id) return 'owner_missing';
    if (!deps.registry.get(row.agent_id)) return 'agent_missing';
    const access = await loadAccess(db, row.owner_user_id);
    if (!access || access.blocked) return 'owner_blocked';
    if (!access.isSuperadmin && !access.agentIds.has(row.agent_id)) return 'owner_lost_access';
    return null;
  }

  async function finishApproval(approval: ApprovalRequest, approved: boolean, reason?: string): Promise<void> {
    const row = { id: approval.taskId, agent_id: approval.agentId, thread_id: approval.threadId };
    const agent = await resolveAgent(deps.editor, approval.agentId, 'published');
    const models = await chooseModels(db, deps.timezone, approval.userId, approval.agentId);
    const options = { runId: approval.runId, toolCallId: approval.toolCallId, memory: { thread: approval.threadId, resource: approval.userId }, requestContext: await contextFor(row, approval.userId, models) };
    const stream = approved
      ? await agent.approveToolCall(options)
      : await agent.declineToolCall({ ...options, reason: reason ?? 'Сотрудник отказался.' });
    for await (const part of stream.fullStream) {
      if (part.type === 'error') throw (part.payload as { error: unknown }).error;
    }
    await markUnread(approval.threadId, approval.taskId);
  }

  const service: BackgroundService = {
    async runTask(taskId) {
      const row = await task(taskId);
      if (!row || row.status !== 'active') return 'skipped';
      await db.query('UPDATE app.background_tasks SET last_run_at = now() WHERE id = $1', [taskId]);
      const blocker = await ownerCanRun(row);
      if (blocker) {
        await pause(row, blocker);
        return 'paused';
      }
      const { rowCount } = await db.query("SELECT 1 FROM app.approval_requests WHERE task_id = $1 AND status = 'pending'", [taskId]);
      if (rowCount) {
        // Runs do not pile up behind an unanswered question (spec, section 8.6).
        await writeJournal(db, { userId: row.owner_user_id, agentId: row.agent_id, runKind: 'background', taskId, event: 'background_skipped', result: 'skipped', errorCode: 'APP_BACKGROUND_RUN_SKIPPED' });
        return 'skipped';
      }
      return execute(row, row.owner_user_id!);
    },

    async startAgentRun(input) {
      if (!deps.registry.get(input.agentId)) throw appError('APP_NOT_FOUND', `agent ${input.agentId} is not loaded`);
      const access = await loadAccess(db, input.userId);
      if (!access || access.blocked) throw appError('APP_AUTH_BANNED', `user ${input.userId} cannot run agents`);
      const threadId = `ev:${randomUUID()}`;
      const outcome = await execute({ id: null, agent_id: input.agentId, thread_id: threadId, prompt: input.prompt, title: input.title }, input.userId);
      return { threadId, outcome };
    },

    async decide(userId, approvalId, approved) {
      const approval = await getApproval(db, userId, approvalId);
      if (!approval || !approval.taskId) throw appError('APP_NOT_FOUND', `approval ${approvalId} not found`, { userMessage: 'Такого вопроса нет.' });
      if (approval.status !== 'pending') throw appError('APP_APPROVAL_DECIDED', `approval ${approvalId} is ${approval.status}`);
      if (approval.expiresAt.getTime() < Date.now()) {
        await service.expireOverdue();
        throw appError('APP_APPROVAL_EXPIRED', `approval ${approvalId} expired`);
      }
      if (approved) {
        // Access and limits are checked again when the employee says "Да" (spec, scenario 4).
        const access = await loadAccess(db, userId);
        let failure: AppError | null = null;
        if (!access || access.blocked || (!access.isSuperadmin && !access.agentIds.has(approval.agentId))) {
          failure = new AppError({ code: 'APP_AGENT_ACCESS_DENIED', message: 'owner lost access before approving', userMessage: 'Действие не выполнено: у вас больше нет доступа к этому агенту.', status: 403 });
        } else {
          try {
            await deps.gateway.assertWithinBudget(userId);
            await chooseModels(db, deps.timezone, userId, approval.agentId);
          } catch (error) {
            if (!isAppError(error)) throw error;
            const spent = error.code.startsWith('APP_USAGE_');
            failure = new AppError({ code: error.code, message: error.message, userMessage: spent ? 'Действие не выполнено: лимит расходов исчерпан.' : `Действие не выполнено: ${error.userMessage}`, status: error.status, cause: error });
          }
        }
        if (failure) {
          await decideRow(db, approval.id, 'failed', failure.code);
          throw failure;
        }
      }
      if (!(await decideRow(db, approval.id, approved ? 'approved' : 'declined'))) throw appError('APP_APPROVAL_DECIDED', `approval ${approvalId} was decided meanwhile`);
      if (!approved) await writeJournal(db, { userId, agentId: approval.agentId, runKind: 'background', taskId: approval.taskId, event: 'tool_declined', tool: approval.tool, approvedBy: userId, result: 'declined' });
      await finishApproval(approval, approved);
    },

    async expireOverdue() {
      const { rows } = await db.query<{ id: string }>(
        "UPDATE app.approval_requests SET status = 'expired', decided_at = now() WHERE status = 'pending' AND task_id IS NOT NULL AND expires_at < now() RETURNING id",
      );
      for (const { id } of rows) {
        const { rows: found } = await db.query<{ user_id: string }>('SELECT user_id FROM app.approval_requests WHERE id = $1', [id]);
        const approval = await getApproval(db, found[0]!.user_id, id);
        if (!approval) continue;
        await writeJournal(db, { userId: approval.userId, agentId: approval.agentId, runKind: 'background', taskId: approval.taskId, event: 'approval_expired', tool: approval.tool, result: 'expired', errorCode: 'APP_APPROVAL_EXPIRED' });
        // Close the suspended run, so the conversation has no tool call left without a result.
        await finishApproval(approval, false, EXPIRED_REASON).catch((error: unknown) => logEvent('warn', 'expired_approval_close_failed', { approvalId: id, error }));
      }
      return rows.length;
    },

    async syncSchedules() {
      const { rows } = await db.query<TaskRow>('SELECT * FROM app.background_tasks');
      const schedules = mastra().schedules;
      type ScheduleView = { id: string; workflowId?: string; cron?: string; status?: string; inputData?: { taskId?: string } };
      const existing = (await schedules.list()) as unknown as ScheduleView[];
      const byTask = new Map<string | undefined, ScheduleView>(existing.filter((s) => s.workflowId === BACKGROUND_WORKFLOW_ID).map((s) => [s.inputData?.taskId, s]));
      for (const row of rows) {
        let schedule = byTask.get(row.id);
        if (!schedule) {
          schedule = (await schedules.create({ id: row.id, workflowId: BACKGROUND_WORKFLOW_ID, cron: row.cron, timezone: deps.timezone, inputData: { taskId: row.id } })) as unknown as ScheduleView;
          await db.query('UPDATE app.background_tasks SET schedule_id = $2 WHERE id = $1', [row.id, schedule.id]);
        } else if (schedule.cron !== row.cron) {
          await schedules.update(schedule.id, { cron: row.cron, timezone: deps.timezone });
        }
        if (row.status === 'paused' && schedule.status === 'active') await schedules.pause(schedule.id);
        if (row.status === 'active' && schedule.status === 'paused') await schedules.resume(schedule.id);
        byTask.delete(row.id);
      }
      for (const orphan of byTask.values()) await schedules.delete(orphan.id);
    },

    async catchUp(now = new Date()) {
      const { rows } = await db.query<TaskRow>("SELECT * FROM app.background_tasks WHERE status = 'active'");
      const ran: string[] = [];
      for (const row of rows) {
        const previous = new Cron(row.cron, { timezone: deps.timezone }).previousRuns(1, now)[0];
        const since = Math.max(row.last_run_at?.getTime() ?? 0, row.created_at.getTime());
        if (!previous || previous.getTime() <= since) continue;
        if (now.getTime() - previous.getTime() < CATCH_UP_WINDOW_MS) {
          await service.runTask(row.id, 'catch-up');
          ran.push(row.id);
        } else {
          await db.query('UPDATE app.background_tasks SET last_run_at = now() WHERE id = $1', [row.id]);
          await writeJournal(db, { userId: row.owner_user_id, agentId: row.agent_id, runKind: 'background', taskId: row.id, event: 'background_skipped', result: 'skipped', errorCode: 'APP_BACKGROUND_RUN_SKIPPED' });
        }
      }
      return ran;
    },

    async createTask(input) {
      if (!TASK_ID.test(input.id)) throw appError('APP_VALIDATION_FAILED', `task id "${input.id}" must be 2–61 lowercase letters, digits and dashes`);
      if (!deps.registry.get(input.agentId)) throw appError('APP_VALIDATION_FAILED', `agent ${input.agentId} is not loaded`);
      new Cron(input.cron, { timezone: deps.timezone, paused: true }); // throws on a malformed expression
      await db.query(
        `INSERT INTO app.background_tasks (id, title, agent_id, owner_user_id, cron, prompt, status, thread_id) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [input.id, input.title, input.agentId, input.ownerUserId, input.cron, input.prompt, `bg:${input.id}`],
      );
    },

    start() {
      const every = (ms: number, fn: () => Promise<unknown>, event: string) => {
        const timer = setInterval(() => void fn().catch((error: unknown) => logEvent('error', event, { error })), ms);
        timer.unref();
        timers.push(timer);
      };
      every(SYNC_INTERVAL_MS, () => service.syncSchedules(), 'background_sync_failed');
      every(EXPIRY_SWEEP_MS, () => service.expireOverdue(), 'approval_expiry_failed');
    },

    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
  };
  return service;
}
