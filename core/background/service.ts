// Background tasks (spec, scenario 4, section 8.6; mechanism verified at step 0, V5). A task is a
// row of app.background_tasks with its scope, and a Mastra schedule of the one-step workflow
// "background-run". A fire puts one run per employee of the scope into the queue (queue.ts);
// each run works on behalf of that employee — their access, limits and skills — in the
// conversation "bg:<taskId>:<userId>", and its questions wait on their approvals screen 72 hours.
import { randomUUID } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import type { Memory } from '@mastra/memory';
import { Cron } from 'croner';
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
import type { ModelGateway } from '../models/gateway.ts';
import { chooseModels } from '../models/resolve.ts';
import { runProjectOf, runProjectOfWaitingAnswer } from '../projects/access.ts';
import { settleSnapshot, takeSnapshot } from '../projects/trash.ts';
import { projectArea, userArea } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { optionalContextValue, REQUEST_KEYS } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';
import type { SkillsRuntime } from '../skills-admin/runtime.ts';
import { createRunQueue, enqueueFire, finishRun, recoverRuns, type QueuedRun, type RunQueue } from './queue.ts';
import { fireTimeOf } from './schedule.ts';
import { membersOf } from './scope.ts';
import { abilitiesValue, readAbilities } from '../abilities/abilities.ts';

export const BACKGROUND_WORKFLOW_ID = 'background-run';
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 60 * 1000;
const EXPIRY_SWEEP_MS = 5 * 60 * 1000;
const EXPIRED_REASON = 'Истекло: сотрудник не ответил за 72 часа.';
const DELETED_REASON = 'Задачу удалил администратор.';

export type RunOutcome = 'done' | 'awaiting-approval' | 'failed';
export type FireResult = { status: 'fired'; fireAt: Date; queued: number; skipped: number } | { status: 'not-active' } | { status: 'paused'; reason: string };

export interface TaskRow {
  id: string;
  title: string;
  agent_id: string;
  scope: 'org' | 'departments' | 'users';
  cron: string;
  prompt: string;
  status: 'active' | 'paused';
  paused_reason: string | null;
  created_by: string | null;
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
  skills: Pick<SkillsRuntime, 'skillsFor'>;
  // Employees' folders: what a run removes from a project goes into its trash (spec, section 8.20).
  workspaceRoot: string;
  // Where the files are kept: a run holds its folder (spec, section 8.23).
  storage: Pick<FileStorage, 'hold'>;
}

export interface BackgroundService {
  // A fire of the task: one run per employee of the scope goes into the queue.
  fire(taskId: string, now?: Date): Promise<FireResult>;
  // Runs left by a stopped server go on (only those without a result).
  recover(): Promise<void>;
  // Resolves when the queue is empty (tests, shutdown).
  idle(): Promise<void>;
  startAgentRun(input: { agentId: string; userId: string; prompt: string; title: string }): Promise<{ threadId: string; outcome: RunOutcome }>;
  decide(userId: string, approvalId: string, approved: boolean): Promise<void>;
  expireOverdue(): Promise<number>;
  // Declines the task's waiting questions, then removes it; the conversations stay.
  deleteTask(taskId: string): Promise<void>;
  syncSchedules(): Promise<void>;
  catchUp(now?: Date): Promise<string[]>;
  start(): void;
  stop(): void;
}

export const taskThreadId = (taskId: string, userId: string) => `bg:${taskId}:${userId}`;

export function createBackgroundWorkflow(service: () => BackgroundService) {
  const input = z.object({ taskId: z.string() });
  const output = z.object({ outcome: z.string() });
  const step = createStep({
    id: 'run-background-task',
    inputSchema: input,
    outputSchema: output,
    execute: async ({ inputData }) => ({ outcome: (await service().fire(inputData.taskId)).status }),
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
    await writeJournal(db, { userId: null, agentId: row.agent_id, runKind: 'background', taskId: row.id, event: 'background_skipped', result: 'skipped', errorCode: `APP_TASK_PAUSED_${reason.toUpperCase()}` });
    logEvent('warn', 'background_task_paused', { taskId: row.id, reason });
  }

  // `waiting`: the project of an answer that waited for «Да» — the answer is finished there (spec, 8.20).
  async function contextFor(row: { id: string | null; agent_id: string }, threadId: string, userId: string, waiting?: { projectId: string | null }): Promise<RequestContext> {
    const abilities = await readAbilities(db, row.agent_id);
    const [project, models, skillPaths] = await Promise.all([waiting ? runProjectOfWaitingAnswer(db, waiting.projectId) : runProjectOf(db, userId, threadId), chooseModels(db, deps.timezone, userId, row.agent_id), deps.skills.skillsFor(userId, { documents: abilities.commands })]);
    const rc = new RequestContext();
    rc.set(REQUEST_KEYS.userId, userId);
    rc.set(REQUEST_KEYS.threadId, threadId);
    rc.set(REQUEST_KEYS.agentId, row.agent_id);
    rc.set(REQUEST_KEYS.runKind, 'background');
    if (row.id) rc.set(REQUEST_KEYS.taskId, row.id);
    rc.set(REQUEST_KEYS.modelId, models.primary);
    if (models.fallback) rc.set(REQUEST_KEYS.fallbackModelId, models.fallback);
    if (project.projectId && project.projectOwnerId) {
      rc.set(REQUEST_KEYS.projectId, project.projectId);
      rc.set(REQUEST_KEYS.projectOwnerId, project.projectOwnerId);
    }
    if (project.lostProject) rc.set(REQUEST_KEYS.lostProject, JSON.stringify(project.lostProject));
    rc.set(REQUEST_KEYS.skillPaths, JSON.stringify(skillPaths));
    rc.set(REQUEST_KEYS.abilities, abilitiesValue(abilities));
    return rc;
  }

  // A run holds its folder; in a project its files are remembered before it, and what it removes goes
  // into the trash after it, whatever way it ends (spec, sections 8.20 and 8.23).
  async function inRunFolder<T>(rc: RequestContext, userId: string, threadId: string, work: () => Promise<T>): Promise<T> {
    const projectId = optionalContextValue(rc, REQUEST_KEYS.projectId);
    const ownerId = optionalContextValue(rc, REQUEST_KEYS.projectOwnerId);
    // The run's folder stays on the disk while it runs (an S3 bucket keeps the files, spec section 8.23).
    const release = await deps.storage.hold(projectId && ownerId ? projectArea(projectId, ownerId) : userArea(userId), 'write');
    try {
      if (!projectId || !ownerId) return await work();
      const snapshot = takeSnapshot(deps.workspaceRoot, { projectId, ownerId, userId, threadId });
      rc.set(REQUEST_KEYS.projectSnapshot, snapshot.id);
      try {
        return await work();
      } finally {
        await settleSnapshot(db, deps.workspaceRoot, snapshot).catch((error: unknown) => logEvent('error', 'project_trash_settle_failed', { code: 'APP_INTERNAL', projectId, error }));
      }
    } finally {
      await release();
    }
  }

  // Only the mark: Mastra merges it under a row lock and keeps a name the person gave meanwhile.
  async function markUnread(threadId: string): Promise<void> {
    const thread = await memory.getThreadById({ threadId });
    if (thread) await memory.updateThread({ id: threadId, metadata: { unread: true } });
  }

  // The first line of the employee's conversation of a task: who set it up and who may stop it.
  async function openTaskThread(row: TaskRow, userId: string, threadId: string): Promise<void> {
    if (await memory.getThreadById({ threadId })) return;
    await ensureThread(memory, { threadId, resourceId: userId, agentId: row.agent_id, kind: 'background', title: `Задача: ${row.title}` });
    const { rows } = await db.query<{ name: string }>('SELECT "name" FROM app."user" WHERE "id" = $1', [row.created_by]);
    const author = rows[0] ? `администратор ${rows[0].name}` : 'администратор';
    await memory.saveMessages({
      messages: [
        {
          id: randomUUID(),
          threadId,
          resourceId: userId,
          role: 'assistant',
          createdAt: new Date(),
          content: { format: 2, parts: [{ type: 'text', text: `Задачу «${row.title}» завёл ${author}. Поставить на паузу или удалить её может администратор.` }] },
        },
      ],
    });
  }

  // Runs the agent on behalf of the employee and reads the stream to its end.
  async function execute(row: { id: string | null; agent_id: string; prompt: string }, userId: string, threadId: string): Promise<{ outcome: RunOutcome; code: string | null }> {
    const journalBase = { userId, agentId: row.agent_id, runKind: 'background' as const, taskId: row.id };
    try {
      await deps.gateway.assertWithinBudget(userId);
      const agent = await resolveAgent(deps.editor, row.agent_id, 'published');
      const requestContext = await contextFor(row, threadId, userId);
      await writeJournal(db, { ...journalBase, event: 'background_started', result: 'started' });
      const awaiting = await inRunFolder(requestContext, userId, threadId, async () => {
        const stream = await agent.stream(row.prompt, { memory: { thread: threadId, resource: userId }, requestContext });
        let waits = false;
        for await (const part of stream.fullStream) {
          if (part.type === 'tool-call-approval') waits = true;
          if (part.type === 'error') throw (part.payload as { error: unknown }).error;
        }
        return waits;
      });
      await markUnread(threadId);
      await writeJournal(db, { ...journalBase, event: 'background_finished', result: 'ok' });
      return { outcome: awaiting ? 'awaiting-approval' : 'done', code: null };
    } catch (error) {
      const translated = isAppError(error) ? error : await deps.gateway.translateError(error, userId);
      await writeJournal(db, { ...journalBase, event: 'background_finished', result: 'error', errorCode: translated.code });
      logEvent('error', 'background_run_failed', { taskId: row.id, userId, code: translated.code, error });
      return { outcome: 'failed', code: translated.code };
    }
  }

  // A run taken from the queue: the employee may have lost access or been blocked since the fire.
  async function runQueued(run: QueuedRun): Promise<void> {
    const row = await task(run.taskId);
    if (!row) return;
    const access = await loadAccess(db, run.userId);
    if (!access || access.blocked || (!access.isSuperadmin && !access.agentIds.has(row.agent_id))) {
      await db.query("UPDATE app.background_task_runs SET outcome = 'skipped', reason_code = $2, finished_at = now() WHERE id = $1", [run.id, access?.blocked ? 'blocked' : 'no_access']);
      return;
    }
    const threadId = taskThreadId(row.id, run.userId);
    await openTaskThread(row, run.userId, threadId);
    const result = await execute(row, run.userId, threadId);
    await finishRun(db, run.id, result.outcome, result.code);
  }

  const queue: RunQueue = createRunQueue(db, runQueued);

  // The run of a task waiting for this approval gets its result once the employee decided.
  async function closeRun(approval: ApprovalRequest, outcome: 'done' | 'failed', code: string | null): Promise<void> {
    if (!approval.taskId) return;
    await db.query(
      `UPDATE app.background_task_runs SET outcome = $3, reason_code = $4, finished_at = now(), unread = $5
        WHERE task_id = $1 AND user_id = $2 AND outcome = 'awaiting-approval'`,
      [approval.taskId, approval.userId, outcome, code, outcome === 'done'],
    );
  }

  async function finishApproval(approval: ApprovalRequest, approved: boolean, reason?: string): Promise<void> {
    const row = { id: approval.taskId, agent_id: approval.agentId };
    const agent = await resolveAgent(deps.editor, approval.agentId, 'published');
    const requestContext = await contextFor(row, approval.threadId, approval.userId, approval);
    const options = { runId: approval.runId, toolCallId: approval.toolCallId, memory: { thread: approval.threadId, resource: approval.userId }, requestContext };
    await inRunFolder(requestContext, approval.userId, approval.threadId, async () => {
      const stream = approved ? await agent.approveToolCall(options) : await agent.declineToolCall({ ...options, reason: reason ?? 'Сотрудник отказался.' });
      for await (const part of stream.fullStream) {
        if (part.type === 'error') throw (part.payload as { error: unknown }).error;
      }
    });
    await markUnread(approval.threadId);
  }

  async function declinePending(where: string, params: unknown[], status: 'expired' | 'declined', reason: string, code: string): Promise<number> {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `UPDATE app.approval_requests SET status = $1, decided_at = now(), error_code = $2 WHERE status = 'pending' AND task_id IS NOT NULL AND ${where} RETURNING id, user_id`,
      [status, code, ...params],
    );
    for (const { id, user_id } of rows) {
      const approval = await getApproval(db, user_id, id);
      if (!approval) continue;
      await writeJournal(db, { userId: approval.userId, agentId: approval.agentId, runKind: 'background', taskId: approval.taskId, event: status === 'expired' ? 'approval_expired' : 'tool_declined', tool: approval.tool, result: status, errorCode: code });
      await closeRun(approval, 'failed', code);
      // Close the suspended run, so the conversation has no tool call left without a result.
      await finishApproval(approval, false, reason).catch((error: unknown) => logEvent('warn', 'approval_close_failed', { approvalId: id, error }));
    }
    return rows.length;
  }

  const service: BackgroundService = {
    async fire(taskId, now = new Date()) {
      const row = await task(taskId);
      if (!row || row.status !== 'active') return { status: 'not-active' };
      if (!deps.registry.get(row.agent_id)) {
        await pause(row, 'agent_missing');
        return { status: 'paused', reason: 'agent_missing' };
      }
      const fireAt = fireTimeOf(row.cron, deps.timezone, now);
      const members = await membersOf(db, row.id, row.scope, row.agent_id);
      // A previous run of the employee still waits for a decision: this one is skipped.
      const { rows: waiting } = await db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM app.approval_requests WHERE task_id = $1 AND status = 'pending'", [row.id]);
      const awaiting = new Set(waiting.map((w) => w.user_id));
      const result = await enqueueFire(db, row.id, fireAt, members.map((m) => ({ ...m, awaiting: m.skip === null && awaiting.has(m.userId) })));
      for (const m of members.filter((x) => x.skip === null && awaiting.has(x.userId))) {
        await writeJournal(db, { userId: m.userId, agentId: row.agent_id, runKind: 'background', taskId: row.id, event: 'background_skipped', result: 'skipped', errorCode: 'APP_BACKGROUND_RUN_SKIPPED' });
      }
      await db.query('UPDATE app.background_tasks SET last_run_at = $2 WHERE id = $1', [row.id, fireAt]);
      queue.drain();
      return { status: 'fired', fireAt, ...result };
    },

    async recover() {
      const result = await recoverRuns(db);
      if (result.requeued || result.late) logEvent('info', 'background_runs_recovered', result);
      queue.drain();
    },

    idle: () => queue.idle(),

    async startAgentRun(input) {
      if (!deps.registry.get(input.agentId)) throw appError('APP_NOT_FOUND', `agent ${input.agentId} is not loaded`);
      const access = await loadAccess(db, input.userId);
      if (!access || access.blocked) throw appError('APP_AUTH_BANNED', `user ${input.userId} cannot run agents`);
      const threadId = `ev:${randomUUID()}`;
      await ensureThread(memory, { threadId, resourceId: input.userId, agentId: input.agentId, kind: 'background', title: `Задача: ${input.title}` });
      const { outcome } = await execute({ id: null, agent_id: input.agentId, prompt: input.prompt }, input.userId, threadId);
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
          await closeRun(approval, 'failed', failure.code);
          throw failure;
        }
      }
      if (!(await decideRow(db, approval.id, approved ? 'approved' : 'declined'))) throw appError('APP_APPROVAL_DECIDED', `approval ${approvalId} was decided meanwhile`);
      if (!approved) await writeJournal(db, { userId, agentId: approval.agentId, runKind: 'background', taskId: approval.taskId, event: 'tool_declined', tool: approval.tool, approvedBy: userId, result: 'declined' });
      try {
        await finishApproval(approval, approved);
        await closeRun(approval, 'done', null);
      } catch (error) {
        await closeRun(approval, 'failed', isAppError(error) ? error.code : 'APP_INTERNAL');
        throw error;
      }
    },

    expireOverdue: () => declinePending('expires_at < now()', [], 'expired', EXPIRED_REASON, 'APP_APPROVAL_EXPIRED'),

    async deleteTask(taskId) {
      await declinePending('task_id = $3', [taskId], 'declined', DELETED_REASON, 'APP_TASK_DELETED');
      await db.query('DELETE FROM app.background_tasks WHERE id = $1', [taskId]);
      await service.syncSchedules();
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

    // A fire missed while the server was down: one catch-up when it was less than a day ago.
    async catchUp(now = new Date()) {
      const { rows } = await db.query<TaskRow>("SELECT * FROM app.background_tasks WHERE status = 'active'");
      const fired: string[] = [];
      for (const row of rows) {
        const previous = new Cron(row.cron, { timezone: deps.timezone }).previousRuns(1, now)[0];
        const since = Math.max(row.last_run_at?.getTime() ?? 0, row.created_at.getTime());
        if (!previous || previous.getTime() <= since) continue;
        if (now.getTime() - previous.getTime() < CATCH_UP_WINDOW_MS) {
          await service.fire(row.id, previous);
          fired.push(row.id);
        } else {
          await db.query('UPDATE app.background_tasks SET last_run_at = $2 WHERE id = $1', [row.id, previous]);
          await writeJournal(db, { userId: null, agentId: row.agent_id, runKind: 'background', taskId: row.id, event: 'background_skipped', result: 'skipped', errorCode: 'APP_BACKGROUND_RUN_SKIPPED' });
        }
      }
      return fired;
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
