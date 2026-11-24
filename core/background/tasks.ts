// «Режимы работы» (spec, scenario 4, section 8.6): only the admin creates, changes, pauses and
// removes background tasks. Every change re-syncs the Mastra schedules at once. A task starts by its schedule, on a
// letter or on a message of another system (docs/specs/[20.11.2026]-event-tasks.md, triggers.ts).
import { randomBytes } from 'node:crypto';
import type { AdminTask, MailFilter, MailReachResponse, RunOutcomeName, TaskAccess, TaskCreate, TaskEventOutcome, TaskEventsResponse, TaskFireSummary, TaskRunsResponse, TaskUpdate } from '@bba/contracts';
import { RUN_OUTCOMES } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { mayUseAgentSql } from '../auth/agent-access.ts';
import { checkScope, writeScopeTargets } from '../auth/scope.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { Registry } from '../loader/registry.ts';
import { assertCron, cronOf, scheduleOf } from './schedule.ts';
import type { BackgroundService, TaskRow } from './service.ts';
import { accessOf, assertChangeFits, assertExecutor, cleanMailFilter, executorScope, hookUrl, newHookSecret } from './triggers.ts';

export const TITLE_MAX = 120;
export const PROMPT_MAX = 8000;

export interface TasksDeps {
  db: Db;
  registry: Registry;
  background: Pick<BackgroundService, 'syncSchedules' | 'deleteTask'>;
  timezone: string;
  // The secret of a webhook task's address is kept encrypted and shown to the admin (always visible, «Сменить адрес»).
  box: SecretBox;
  publicUrl: string;
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

type ListedRow = TaskRow & { author: string | null; executor_name: string | null; department_ids: string[]; user_ids: string[]; fired: number; skipped: number };

export async function listTasks(deps: Pick<TasksDeps, 'db' | 'box' | 'publicUrl'>): Promise<AdminTask[]> {
  const { db } = deps;
  const { rows } = await db.query<ListedRow>(
    `SELECT t.*, u."name" AS author, x."name" AS executor_name,
            coalesce(array_agg(DISTINCT s.department_id::text) FILTER (WHERE s.department_id IS NOT NULL), '{}') AS department_ids,
            coalesce(array_agg(DISTINCT s.user_id) FILTER (WHERE s.user_id IS NOT NULL), '{}') AS user_ids,
            (SELECT count(*)::int FROM app.task_events e WHERE e.task_id = t.id AND e.received_at > now() - interval '1 day' AND e.outcome NOT LIKE 'skipped%') AS fired,
            (SELECT count(*)::int FROM app.task_events e WHERE e.task_id = t.id AND e.received_at > now() - interval '1 day' AND e.outcome LIKE 'skipped%') AS skipped
       FROM app.background_tasks t
       LEFT JOIN app.task_scope s ON s.task_id = t.id
       LEFT JOIN app."user" u ON u."id" = t.created_by
       LEFT JOIN app."user" x ON x."id" = t.executor_id
      GROUP BY t.id, u."name", x."name"
      ORDER BY t.title, t.id`,
  );
  const fires = await lastFires(db);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    agentId: r.agent_id,
    trigger: r.trigger,
    access: { scope: r.scope, departmentIds: [...r.department_ids].sort(), userIds: [...r.user_ids].sort() },
    schedule: r.cron ? scheduleOf(r.cron) : null,
    cron: r.cron,
    mailFilter: r.mail_filter,
    executor: r.executor_id ? { id: r.executor_id, name: r.executor_name ?? r.executor_id } : null,
    hookUrl: r.webhook_ciphertext && r.webhook_iv && r.webhook_key_version !== null ? hookUrl(deps.publicUrl, deps.box.open({ ciphertext: r.webhook_ciphertext, iv: r.webhook_iv, keyVersion: r.webhook_key_version })) : null,
    events: r.trigger === 'schedule' ? null : { fired: r.fired, skipped: r.skipped },
    prompt: r.prompt,
    status: r.status,
    pausedReason: r.paused_reason,
    createdBy: r.author,
    // A fire that reached nobody leaves no rows: «Некому выполнять».
    lastFire: r.last_run_at ? (fires.get(r.id) ?? { fireAt: r.last_run_at.toISOString(), total: 0, counts: Object.fromEntries(RUN_OUTCOMES.map((o) => [o, 0])) as TaskFireSummary['counts'] }) : null,
  }));
}

async function taskDto(deps: TasksDeps, id: string): Promise<AdminTask> {
  const task = (await listTasks(deps)).find((t) => t.id === id);
  if (!task) throw notFound(id);
  return task;
}

export async function createTask(deps: TasksDeps, actorUserId: string, input: TaskCreate): Promise<AdminTask> {
  const id = `t-${randomBytes(4).toString('hex')}`;
  const cron = input.trigger === 'schedule' ? cronOf(input.schedule) : null;
  if (cron) assertCron(cron, deps.timezone);
  const mailFilter: MailFilter | null = input.trigger === 'mail' ? cleanMailFilter(input.mailFilter) : null;
  if (input.trigger === 'webhook') await assertExecutor(deps.db, input.executorId);
  const hook = input.trigger === 'webhook' ? newHookSecret(deps.box) : null;
  const title = cleanTitle(input.title);
  const prompt = cleanPrompt(input.prompt);
  const agentId = checkAgent(deps, input.agentId);
  await inTransaction(deps.db, async (c) => {
    const access = await checkScope(c, accessOf(input));
    await c.query(
      `INSERT INTO app.background_tasks (id, title, agent_id, scope, trigger, cron, mail_filter, webhook_ciphertext, webhook_iv, webhook_key_version, webhook_secret_hash,
                                         executor_mode, executor_id, prompt, status, created_by, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', $15, now())`,
      [id, title, agentId, access.scope, input.trigger, cron, mailFilter, hook?.ciphertext ?? null, hook?.iv ?? null, hook?.keyVersion ?? null, hook?.hash ?? null, input.trigger === 'webhook' ? 'fixed' : null, input.trigger === 'webhook' ? input.executorId : null, prompt, actorUserId],
    );
    await writeScopeTargets(c, id, access);
    await writeAudit(c, { actorUserId, action: 'task.create', target: id, details: { title, agentId, trigger: input.trigger, cron, mailFilter, executorId: input.trigger === 'webhook' ? input.executorId : null, access } });
  });
  await deps.background.syncSchedules();
  return taskDto(deps, id);
}

export async function updateTask(deps: TasksDeps, actorUserId: string, id: string, change: TaskUpdate): Promise<AdminTask> {
  const row = await taskRow(deps.db, id);
  assertChangeFits(row.trigger, change);
  const cron = change.schedule ? cronOf(change.schedule) : row.cron;
  if (cron) assertCron(cron, deps.timezone);
  const mailFilter = change.mailFilter ? cleanMailFilter(change.mailFilter) : row.mail_filter;
  if (change.executorId) await assertExecutor(deps.db, change.executorId);
  const executorId = change.executorId ?? row.executor_id;
  const title = change.title === undefined ? row.title : cleanTitle(change.title);
  const prompt = change.prompt === undefined ? row.prompt : cleanPrompt(change.prompt);
  const agentId = change.agentId === undefined ? row.agent_id : checkAgent(deps, change.agentId);
  await inTransaction(deps.db, async (c) => {
    const scopeChange = change.access ?? (change.executorId ? executorScope(change.executorId) : null);
    const access = scopeChange ? await checkScope(c, scopeChange) : null;
    // A task stopped for a missing agent or an empty scope goes on once that is fixed.
    const fixed = (row.paused_reason === 'agent_missing' && change.agentId !== undefined) || (row.paused_reason === 'scope_empty' && access !== null);
    await c.query(
      `UPDATE app.background_tasks SET title = $2, agent_id = $3, cron = $4, prompt = $5, scope = COALESCE($6, scope), mail_filter = $8, executor_id = $9,
              status = CASE WHEN $7 THEN 'active' ELSE status END, paused_reason = CASE WHEN $7 THEN NULL ELSE paused_reason END,
              activated_at = CASE WHEN $7 THEN now() ELSE activated_at END, updated_at = now()
        WHERE id = $1`,
      [id, title, agentId, cron, prompt, access?.scope ?? null, fixed, mailFilter, executorId],
    );
    if (access) await writeScopeTargets(c, id, access);
    await writeAudit(c, { actorUserId, action: 'task.update', target: id, details: { ...change } });
  });
  await deps.background.syncSchedules();
  return taskDto(deps, id);
}

// «Сменить адрес»: a new secret; the old address stops working at once.
export async function renewHook(deps: TasksDeps, actorUserId: string, id: string): Promise<AdminTask> {
  const row = await taskRow(deps.db, id);
  if (row.trigger !== 'webhook') throw appError('APP_VALIDATION_FAILED', `task ${id} has no address`, { userMessage: 'Адрес есть только у задачи «Сообщение от другой системы».' });
  const hook = newHookSecret(deps.box);
  await deps.db.query('UPDATE app.background_tasks SET webhook_ciphertext = $2, webhook_iv = $3, webhook_key_version = $4, webhook_secret_hash = $5, updated_at = now() WHERE id = $1', [id, hook.ciphertext, hook.iv, hook.keyVersion, hook.hash]);
  await writeAudit(deps.db, { actorUserId, action: 'task.hook_renew', target: id });
  return taskDto(deps, id);
}

export async function setTaskStatus(deps: TasksDeps, actorUserId: string, id: string, status: 'active' | 'paused'): Promise<AdminTask> {
  const row = await taskRow(deps.db, id);
  if (status === 'active' && !deps.registry.get(row.agent_id)) throw appError('APP_VALIDATION_FAILED', `agent ${row.agent_id} is not loaded`, { userMessage: 'Агента этой задачи больше нет. Выберите другого агента.' });
  // Letters that came during a pause are not handled after it: the task takes events from the moment it goes on.
  await deps.db.query(`UPDATE app.background_tasks SET status = $2, paused_reason = NULL, activated_at = CASE WHEN $2 = 'active' AND status <> 'active' THEN now() ELSE activated_at END, updated_at = now() WHERE id = $1`, [id, status]);
  await writeAudit(deps.db, { actorUserId, action: status === 'active' ? 'task.resume' : 'task.pause', target: id });
  await deps.background.syncSchedules();
  return taskDto(deps, id);
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

// «Последние события» of an event task (docs/specs/[20.11.2026]-event-tasks.md, section 7): the 20 latest — a system's
// message with its first characters, a letter with only whose mailbox it came to (the mail is the employee's).
export const EVENTS_SHOWN = 20;

export async function taskEvents(db: Db, id: string): Promise<TaskEventsResponse> {
  await taskRow(db, id);
  const { rows } = await db.query<{ id: string; received_at: Date; summary: string | null; name: string | null; kind: string | null; outcome: TaskEventOutcome; reason_code: string | null }>(
    `SELECT e.id, e.received_at, e.summary, u."name", t.trigger AS kind, e.outcome, e.reason_code
       FROM app.task_events e JOIN app.background_tasks t ON t.id = e.task_id LEFT JOIN app."user" u ON u."id" = e.user_id
      WHERE e.task_id = $1 ORDER BY e.received_at DESC, e.id DESC LIMIT ${EVENTS_SHOWN}`,
    [id],
  );
  const rejects = await db.query<{ reason: string; n: number }>(`SELECT reason, sum(count)::int AS n FROM app.task_event_rejects WHERE task_id = $1 AND day >= current_date - 1 GROUP BY reason`, [id]);
  const rejected = (reason: string) => rejects.rows.find((r) => r.reason === reason)?.n ?? 0;
  return {
    events: rows.map((r) => ({ id: String(r.id), receivedAt: r.received_at.toISOString(), summary: r.kind === 'mail' ? null : r.summary, user: r.kind === 'mail' ? r.name : null, outcome: r.outcome, reasonCode: r.reason_code })),
    rejected: { tooLarge: rejected('too_large'), badFormat: rejected('bad_format') },
  };
}

// «Сработает у N из M»: of the people of the scope who may use the agent, how many have a mailbox connected.
export async function mailReach(deps: Pick<TasksDeps, 'db' | 'registry'>, agentId: string, access: TaskAccess): Promise<MailReachResponse> {
  checkAgent(deps as TasksDeps, agentId);
  const { rows } = await deps.db.query<{ total: number; with_mail: number }>(
    `WITH people AS (
       SELECT u."id" AS user_id FROM app."user" u WHERE $1 = 'org'
       UNION SELECT dm.user_id FROM app.department_members dm WHERE $1 = 'departments' AND dm.department_id::text = ANY($2)
       UNION SELECT u."id" FROM app."user" u WHERE $1 = 'users' AND u."id" = ANY($3)
     ), able AS (
       SELECT p.user_id FROM people p LEFT JOIN app.user_profiles pr ON pr.user_id = p.user_id
        WHERE pr.blocked_at IS NULL AND pr.deletion_started_at IS NULL
          AND ${mayUseAgentSql('p.user_id', '$4')}
     )
     SELECT count(*)::int AS total, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.mail_accounts m WHERE m.user_id = able.user_id AND m.status = 'connected'))::int AS with_mail FROM able`,
    [access.scope, access.departmentIds, access.userIds, agentId],
  );
  return { total: rows[0]?.total ?? 0, withMail: rows[0]?.with_mail ?? 0 };
}
