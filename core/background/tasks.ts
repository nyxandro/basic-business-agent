// «Режимы работы» (spec, scenario 4, section 8.6): only the admin creates, changes, pauses and
// removes background tasks. Every change re-syncs the Mastra schedules at once.
import { randomBytes } from 'node:crypto';
import type { AdminTask, RunOutcomeName, TaskCreate, TaskFireSummary, TaskRunsResponse, TaskUpdate } from '@bba/contracts';
import { RUN_OUTCOMES } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { checkScope, writeScopeTargets } from '../auth/scope.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { Registry } from '../loader/registry.ts';
import { assertCron, cronOf, scheduleOf } from './schedule.ts';
import type { BackgroundService, TaskRow } from './service.ts';

export const TITLE_MAX = 120;
export const PROMPT_MAX = 8000;

export interface TasksDeps {
  db: Db;
  registry: Registry;
  background: Pick<BackgroundService, 'syncSchedules' | 'deleteTask'>;
  timezone: string;
}

const notFound = (id: string) => appError('APP_NOT_FOUND', `task ${id} not found`, { userMessage: 'Задача не найдена. Обновите страницу.' });

function cleanTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > TITLE_MAX) throw appError('APP_VALIDATION_FAILED', `task title of ${clean.length} chars`, { userMessage: `Название задачи — от 1 до ${TITLE_MAX} символов.` });
  return clean;
}

function cleanPrompt(prompt: string): string {
  const clean = prompt.trim();
  if (clean.length < 1 || clean.length > PROMPT_MAX) throw appError('APP_VALIDATION_FAILED', `task prompt of ${clean.length} chars`, { userMessage: `Поручение — от 1 до ${PROMPT_MAX} символов.` });
  return clean;
}

function checkAgent(deps: TasksDeps, agentId: string): string {
  if (!deps.registry.get(agentId)) throw appError('APP_VALIDATION_FAILED', `agent ${agentId} is not loaded`, { userMessage: 'Такого агента нет в установке.' });
  return agentId;
}

async function taskRow(db: Db, id: string): Promise<TaskRow> {
  const { rows } = await db.query<TaskRow>('SELECT * FROM app.background_tasks WHERE id = $1', [id]);
  if (!rows[0]) throw notFound(id);
  return rows[0];
}

async function lastFires(db: Db): Promise<Map<string, TaskFireSummary>> {
  const { rows } = await db.query<{ task_id: string; fire_at: Date; outcome: RunOutcomeName; n: number }>(
    `SELECT r.task_id, r.fire_at, r.outcome, count(*)::int AS n
       FROM app.background_task_runs r JOIN app.background_tasks t ON t.id = r.task_id AND r.fire_at = t.last_run_at
      GROUP BY r.task_id, r.fire_at, r.outcome`,
  );
  const out = new Map<string, TaskFireSummary>();
  for (const r of rows) {
    const summary = out.get(r.task_id) ?? { fireAt: r.fire_at.toISOString(), total: 0, counts: Object.fromEntries(RUN_OUTCOMES.map((o) => [o, 0])) as TaskFireSummary['counts'] };
    summary.counts[r.outcome] += r.n;
    summary.total += r.n;
    out.set(r.task_id, summary);
  }
  return out;
}

export async function listTasks(db: Db): Promise<AdminTask[]> {
  const { rows } = await db.query<TaskRow & { author: string | null; department_ids: string[]; user_ids: string[] }>(
    `SELECT t.*, u."name" AS author,
            coalesce(array_agg(s.department_id::text) FILTER (WHERE s.department_id IS NOT NULL), '{}') AS department_ids,
            coalesce(array_agg(s.user_id) FILTER (WHERE s.user_id IS NOT NULL), '{}') AS user_ids
       FROM app.background_tasks t
       LEFT JOIN app.task_scope s ON s.task_id = t.id
       LEFT JOIN app."user" u ON u."id" = t.created_by
      GROUP BY t.id, u."name"
      ORDER BY t.title, t.id`,
  );
  const fires = await lastFires(db);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    agentId: r.agent_id,
    access: { scope: r.scope, departmentIds: [...r.department_ids].sort(), userIds: [...r.user_ids].sort() },
    schedule: scheduleOf(r.cron),
    cron: r.cron,
    prompt: r.prompt,
    status: r.status,
    pausedReason: r.paused_reason,
    createdBy: r.author,
    // A fire that reached nobody leaves no rows: «Некому выполнять».
    lastFire: r.last_run_at ? (fires.get(r.id) ?? { fireAt: r.last_run_at.toISOString(), total: 0, counts: Object.fromEntries(RUN_OUTCOMES.map((o) => [o, 0])) as TaskFireSummary['counts'] }) : null,
  }));
}

async function taskDto(db: Db, id: string): Promise<AdminTask> {
  const task = (await listTasks(db)).find((t) => t.id === id);
  if (!task) throw notFound(id);
  return task;
}

export async function createTask(deps: TasksDeps, actorUserId: string, input: TaskCreate): Promise<AdminTask> {
  const id = `t-${randomBytes(4).toString('hex')}`;
  const cron = cronOf(input.schedule);
  assertCron(cron, deps.timezone);
  const title = cleanTitle(input.title);
  const prompt = cleanPrompt(input.prompt);
  const agentId = checkAgent(deps, input.agentId);
  await inTransaction(deps.db, async (c) => {
    const access = await checkScope(c, input.access);
    await c.query(`INSERT INTO app.background_tasks (id, title, agent_id, scope, cron, prompt, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`, [
      id,
      title,
      agentId,
      access.scope,
      cron,
      prompt,
      actorUserId,
    ]);
    await writeScopeTargets(c, 'task', id, access);
    await writeAudit(c, { actorUserId, action: 'task.create', target: id, details: { title, agentId, cron, access } });
  });
  await deps.background.syncSchedules();
  return taskDto(deps.db, id);
}

export async function updateTask(deps: TasksDeps, actorUserId: string, id: string, change: TaskUpdate): Promise<AdminTask> {
  const row = await taskRow(deps.db, id);
  const cron = change.schedule ? cronOf(change.schedule) : row.cron;
  assertCron(cron, deps.timezone);
  const title = change.title === undefined ? row.title : cleanTitle(change.title);
  const prompt = change.prompt === undefined ? row.prompt : cleanPrompt(change.prompt);
  const agentId = change.agentId === undefined ? row.agent_id : checkAgent(deps, change.agentId);
  await inTransaction(deps.db, async (c) => {
    const access = change.access ? await checkScope(c, change.access) : null;
    // A task stopped for a missing agent or an empty scope goes on once that is fixed.
    const fixed = (row.paused_reason === 'agent_missing' && change.agentId !== undefined) || (row.paused_reason === 'scope_empty' && access !== null);
    await c.query(
      `UPDATE app.background_tasks SET title = $2, agent_id = $3, cron = $4, prompt = $5, scope = COALESCE($6, scope),
              status = CASE WHEN $7 THEN 'active' ELSE status END, paused_reason = CASE WHEN $7 THEN NULL ELSE paused_reason END, updated_at = now()
        WHERE id = $1`,
      [id, title, agentId, cron, prompt, access?.scope ?? null, fixed],
    );
    if (access) await writeScopeTargets(c, 'task', id, access);
    await writeAudit(c, { actorUserId, action: 'task.update', target: id, details: { ...change } });
  });
  await deps.background.syncSchedules();
  return taskDto(deps.db, id);
}

export async function setTaskStatus(deps: TasksDeps, actorUserId: string, id: string, status: 'active' | 'paused'): Promise<AdminTask> {
  const row = await taskRow(deps.db, id);
  if (status === 'active' && !deps.registry.get(row.agent_id)) throw appError('APP_VALIDATION_FAILED', `agent ${row.agent_id} is not loaded`, { userMessage: 'Агента этой задачи больше нет. Выберите другого агента.' });
  await deps.db.query('UPDATE app.background_tasks SET status = $2, paused_reason = NULL, updated_at = now() WHERE id = $1', [id, status]);
  await writeAudit(deps.db, { actorUserId, action: status === 'active' ? 'task.resume' : 'task.pause', target: id });
  await deps.background.syncSchedules();
  return taskDto(deps.db, id);
}

export async function removeTask(deps: TasksDeps, actorUserId: string, id: string): Promise<void> {
  await taskRow(deps.db, id);
  await deps.background.deleteTask(id);
  await writeAudit(deps.db, { actorUserId, action: 'task.delete', target: id });
}

// The people of one fire of the task (the last one by default) and how it went for each.
export async function taskRuns(db: Db, id: string, fireAt: string | null): Promise<TaskRunsResponse> {
  const row = await taskRow(db, id);
  const at = fireAt ? new Date(fireAt) : row.last_run_at;
  if (at && Number.isNaN(at.getTime())) throw appError('APP_VALIDATION_FAILED', `bad fireAt "${fireAt}"`);
  if (!at) return { fireAt: null, runs: [] };
  const { rows } = await db.query<{ user_id: string; name: string; outcome: RunOutcomeName; reason_code: string | null; started_at: Date | null; finished_at: Date | null }>(
    `SELECT r.user_id, u."name", r.outcome, r.reason_code, r.started_at, r.finished_at
       FROM app.background_task_runs r JOIN app."user" u ON u."id" = r.user_id
      WHERE r.task_id = $1 AND r.fire_at = $2 ORDER BY u."name", r.user_id`,
    [id, at],
  );
  return {
    fireAt: at.toISOString(),
    runs: rows.map((r) => ({ userId: r.user_id, name: r.name, outcome: r.outcome, reasonCode: r.reason_code, startedAt: r.started_at?.toISOString() ?? null, finishedAt: r.finished_at?.toISOString() ?? null })),
  };
}
