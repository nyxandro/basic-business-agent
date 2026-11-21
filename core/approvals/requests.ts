// Questions waiting for the employee's "Да"/"Нет" (spec, section 8.4). A Mastra output processor
// records every tool-call approval request of a run here — in the chat and in background tasks —
// so a decision can be applied later, after a page reload or a server restart.
import type { ActionDescription } from '@bba/contracts';
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { summariseArgs, writeJournal } from '../journal/journal.ts';
import { notices, type QuestionOrigin } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { REQUEST_KEYS, type RunKind } from '../runtime/request-keys.ts';
import { getApprovalSettings, ttlHoursFor } from './settings.ts';

const HOUR_MS = 60 * 60 * 1000;
const RUN_KINDS: readonly RunKind[] = ['chat', 'background', 'draft'];

export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'failed';

export interface ApprovalRequest {
  id: string;
  userId: string;
  agentId: string;
  taskId: string | null;
  threadId: string;
  runId: string;
  toolCallId: string;
  tool: string;
  // The name of the action and the labels of its fields as they were when asked.
  summary: string;
  labels: Record<string, string>;
  // How the card shows values of fields with a fixed set (core/org-docs/sign-tool.ts), as they were when asked.
  choices: Record<string, Record<string, string>>;
  args: unknown;
  status: ApprovalStatus;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  // The project the waiting answer was started in: it is finished there (spec, section 8.20).
  projectId: string | null;
  runKind: RunKind;
}

interface Row {
  id: string;
  user_id: string;
  agent_id: string;
  task_id: string | null;
  thread_id: string;
  run_id: string;
  tool_call_id: string;
  tool: string;
  summary: string;
  labels: Record<string, string>;
  choices: Record<string, Record<string, string>>;
  args: unknown;
  status: ApprovalStatus;
  error_code: string | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  project_id: string | null;
  run_kind: RunKind;
}

const toRequest = (r: Row): ApprovalRequest => ({
  id: r.id,
  userId: r.user_id,
  agentId: r.agent_id,
  taskId: r.task_id,
  threadId: r.thread_id,
  runId: r.run_id,
  toolCallId: r.tool_call_id,
  tool: r.tool,
  summary: r.summary,
  labels: r.labels,
  choices: r.choices,
  args: r.args,
  status: r.status,
  errorCode: r.error_code,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  projectId: r.project_id,
  runKind: r.run_kind,
});

function contextValue(ctx: { get(key: string): unknown } | undefined, key: string): string | null {
  const v = ctx?.get(key);
  return typeof v === 'string' && v ? v : null;
}

// Where a question came from, for its notification: a task by its title, a conversation by its name.
export async function questionOrigin(db: Db, q: { taskId: string | null; agentId: string; threadId: string }): Promise<QuestionOrigin> {
  if (q.taskId) {
    const { rows } = await db.query<{ title: string }>('SELECT title FROM app.background_tasks WHERE id = $1', [q.taskId]);
    if (rows[0]) return { kind: 'task', taskTitle: rows[0].title };
  }
  const { rows } = await db.query<{ title: string | null }>('SELECT title FROM mastra.mastra_threads WHERE id = $1', [q.threadId]);
  return { kind: 'conversation', agentId: q.agentId, threadId: q.threadId, threadTitle: rows[0]?.title || 'Без названия' };
}

// «Ждёт вашего решения» for a question just asked.
export async function notifyQuestion(db: Db, q: Pick<ApprovalRequest, 'id' | 'userId' | 'taskId' | 'agentId' | 'threadId' | 'summary'>): Promise<void> {
  await notify(db, notices.approvalWaiting({ userId: q.userId, approvalId: q.id, action: q.summary, origin: await questionOrigin(db, q) }));
}

// `describe` names the actions of the agent's tools (core/approvals/describe.ts); a name that depends on settings (the
// stamp of the organisation) is read when the question is asked.
export function createApprovalRecorder(db: Db, describe: (toolName: string) => ActionDescription | null | Promise<ActionDescription | null>) {
  return {
    id: 'bba-approval-recorder',
    async processOutputStream({ part, requestContext }) {
      if (part.type !== 'tool-call-approval') return part;
      const payload = part.payload as { toolCallId: string; toolName: string; args?: unknown };
      const userId = contextValue(requestContext, REQUEST_KEYS.userId);
      const threadId = contextValue(requestContext, REQUEST_KEYS.threadId);
      const runKind = contextValue(requestContext, REQUEST_KEYS.runKind) as RunKind | null;
      const runId = (part as { runId?: string }).runId;
      if (!userId || !threadId || !runId) throw new Error('approval request without employee, thread or run in the request context');
      if (!runKind || !RUN_KINDS.includes(runKind)) throw new Error(`approval request of an unknown kind of run "${runKind}"`);
      const action = await describe(payload.toolName);
      // The term of the question is fixed now: a later change by the admin touches only new questions (F4).
      const ttlHours = ttlHoursFor(await getApprovalSettings(db), runKind);
      const agentId = contextValue(requestContext, REQUEST_KEYS.agentId) ?? 'unknown';
      const taskId = contextValue(requestContext, REQUEST_KEYS.taskId);
      const summary = action?.title ?? payload.toolName;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO app.approval_requests (user_id, agent_id, task_id, thread_id, run_id, tool_call_id, tool, summary, labels, args, status, expires_at, project_id, choices, run_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', now() + make_interval(hours => $11), $12, $13, $14) ON CONFLICT (run_id, tool_call_id) DO NOTHING RETURNING id`,
        [
          userId,
          agentId,
          taskId,
          threadId,
          runId,
          payload.toolCallId,
          payload.toolName,
          // A tool unknown here (a connected system not listed yet) is named by its name.
          summary,
          JSON.stringify(action?.fields ?? {}),
          JSON.stringify(summariseArgs(payload.args ?? {})),
          ttlHours,
          contextValue(requestContext, REQUEST_KEYS.projectId),
          JSON.stringify(action?.choices ?? {}),
          runKind,
        ],
      );
      // Nobody watches a background run: its question is told at once. A conversation's question is told when the
      // person left before the answer ended (core/chat/run.ts, settleRun).
      const id = rows[0]?.id;
      if (id && runKind === 'background') await notifyQuestion(db, { id, userId, taskId, agentId, threadId, summary });
      return part;
    },
  } satisfies Processor;
}

// Questions the chat answers: a background task's questions are answered on «Ждёт подтверждения»
// (they resume the task's run and expire there), even when its conversation is open in the chat.
export async function pendingForThread(db: Db, userId: string, threadId: string): Promise<ApprovalRequest[]> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM app.approval_requests WHERE user_id = $1 AND thread_id = $2 AND status = 'pending' AND task_id IS NULL ORDER BY created_at",
    [userId, threadId],
  );
  return rows.map(toRequest);
}

// Calls of a conversation cancelled by a new message instead of an answer (spec, scenario 2).
export async function supersededCallsOfThread(db: Db, userId: string, threadId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ tool_call_id: string }>(
    "SELECT tool_call_id FROM app.approval_requests WHERE user_id = $1 AND thread_id = $2 AND status = 'declined' AND error_code = 'APP_CHAT_SUPERSEDED'",
    [userId, threadId],
  );
  return new Set(rows.map((r) => r.tool_call_id));
}

export async function findByCall(db: Db, userId: string, runId: string, toolCallId: string): Promise<ApprovalRequest | null> {
  const { rows } = await db.query<Row>('SELECT * FROM app.approval_requests WHERE user_id = $1 AND run_id = $2 AND tool_call_id = $3', [userId, runId, toolCallId]);
  return rows[0] ? toRequest(rows[0]) : null;
}

export async function getApproval(db: Db, userId: string, id: string): Promise<ApprovalRequest | null> {
  const { rows } = await db.query<Row>('SELECT * FROM app.approval_requests WHERE user_id = $1 AND id = $2', [userId, id]);
  return rows[0] ? toRequest(rows[0]) : null;
}

// Marks a pending question decided; returns false when someone (another tab) decided it first.
export async function decide(db: Db, id: string, status: Exclude<ApprovalStatus, 'pending'>, errorCode: string | null = null): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE app.approval_requests SET status = $2, error_code = $3, decided_at = now() WHERE id = $1 AND status = 'pending'", [id, status, errorCode]);
  return (rowCount ?? 0) > 0;
}

// «Ждёт подтверждения»: questions of background tasks and of conversations (decision of the owner 21.11, F4); a draft
// check of a prompt is the admin's own and is not listed.
export async function listPending(db: Db, userId: string): Promise<ApprovalRequest[]> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM app.approval_requests WHERE user_id = $1 AND status = 'pending' AND expires_at > now() AND run_kind <> 'draft' ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toRequest);
}

// Questions of conversations whose term ran out (F4): they burn here — no model is called; the waiting answer gets
// its refusal at the next message of the conversation (cancelPending in core/chat/run.ts). Questions of background
// runs burn in the background sweep (core/background/service.ts), which closes their run at once.
export async function expireChatQuestions(db: Db): Promise<number> {
  const { rows } = await db.query<Row>(
    `UPDATE app.approval_requests SET status = 'expired', decided_at = now(), error_code = 'APP_APPROVAL_EXPIRED'
      WHERE status = 'pending' AND task_id IS NULL AND run_kind IN ('chat', 'draft') AND expires_at < now() RETURNING *`,
  );
  for (const r of rows.map(toRequest)) {
    await writeJournal(db, { userId: r.userId, agentId: r.agentId, runKind: 'chat', event: 'approval_expired', tool: r.tool, result: 'expired', errorCode: 'APP_APPROVAL_EXPIRED' });
  }
  return rows.length;
}

// Burnt questions of a conversation whose waiting answer has not had its refusal yet.
export async function expiredOpenForThread(db: Db, userId: string, threadId: string): Promise<ApprovalRequest[]> {
  const { rows } = await db.query<Row>(
    "SELECT * FROM app.approval_requests WHERE user_id = $1 AND thread_id = $2 AND status = 'expired' AND task_id IS NULL AND run_kind IN ('chat', 'draft') AND closed_at IS NULL ORDER BY created_at",
    [userId, threadId],
  );
  return rows.map(toRequest);
}

export async function markClosed(db: Db, id: string): Promise<void> {
  await db.query('UPDATE app.approval_requests SET closed_at = now() WHERE id = $1', [id]);
}

// Calls of a conversation whose question burnt, with the term it had: the chat shows «Вопрос истёк: вы не ответили за N ч».
export async function expiredCallsOfThread(db: Db, userId: string, threadId: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ tool_call_id: string; hours: number }>(
    `SELECT tool_call_id, round(extract(epoch FROM expires_at - created_at) / 3600)::int AS hours FROM app.approval_requests
      WHERE user_id = $1 AND thread_id = $2 AND status = 'expired' AND task_id IS NULL`,
    [userId, threadId],
  );
  return new Map(rows.map((r) => [r.tool_call_id, r.hours]));
}

export const termHoursOf = (q: Pick<ApprovalRequest, 'createdAt' | 'expiresAt'>) => Math.round((q.expiresAt.getTime() - q.createdAt.getTime()) / HOUR_MS);
