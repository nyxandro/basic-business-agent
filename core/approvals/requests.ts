// Questions waiting for the employee's "Да"/"Нет" (spec, section 8.4). A Mastra output processor
// records every tool-call approval request of a run here — in the chat and in background tasks —
// so a decision can be applied later, after a page reload or a server restart.
import type { ActionDescription } from '@bba/contracts';
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { summariseArgs } from '../journal/journal.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';

export const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

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
  args: unknown;
  status: ApprovalStatus;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date;
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
  args: unknown;
  status: ApprovalStatus;
  error_code: string | null;
  created_at: Date;
  expires_at: Date;
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
  args: r.args,
  status: r.status,
  errorCode: r.error_code,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

function contextValue(ctx: { get(key: string): unknown } | undefined, key: string): string | null {
  const v = ctx?.get(key);
  return typeof v === 'string' && v ? v : null;
}

// `describe` names the actions of the agent's tools (core/approvals/describe.ts).
export function createApprovalRecorder(db: Db, describe: (toolName: string) => ActionDescription | null) {
  return {
    id: 'bba-approval-recorder',
    async processOutputStream({ part, requestContext }) {
      if (part.type !== 'tool-call-approval') return part;
      const payload = part.payload as { toolCallId: string; toolName: string; args?: unknown };
      const userId = contextValue(requestContext, REQUEST_KEYS.userId);
      const threadId = contextValue(requestContext, REQUEST_KEYS.threadId);
      const runId = (part as { runId?: string }).runId;
      if (!userId || !threadId || !runId) throw new Error('approval request without employee, thread or run in the request context');
      const action = describe(payload.toolName);
      await db.query(
        `INSERT INTO app.approval_requests (user_id, agent_id, task_id, thread_id, run_id, tool_call_id, tool, summary, labels, args, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11) ON CONFLICT (run_id, tool_call_id) DO NOTHING`,
        [
          userId,
          contextValue(requestContext, REQUEST_KEYS.agentId) ?? 'unknown',
          contextValue(requestContext, REQUEST_KEYS.taskId),
          threadId,
          runId,
          payload.toolCallId,
          payload.toolName,
          // A tool unknown here (a connected system not listed yet) is named by its name.
          action?.title ?? payload.toolName,
          JSON.stringify(action?.fields ?? {}),
          JSON.stringify(summariseArgs(payload.args ?? {})),
          new Date(Date.now() + APPROVAL_TTL_MS),
        ],
      );
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

export async function listForUser(db: Db, userId: string): Promise<{ pending: ApprovalRequest[]; failed: ApprovalRequest[] }> {
  const { rows } = await db.query<Row>(
    `SELECT * FROM app.approval_requests WHERE user_id = $1 AND task_id IS NOT NULL
       AND (status = 'pending' OR (status IN ('expired', 'failed') AND decided_at > now() - interval '7 days')) ORDER BY created_at DESC`,
    [userId],
  );
  const all = rows.map(toRequest);
  return { pending: all.filter((r) => r.status === 'pending'), failed: all.filter((r) => r.status !== 'pending') };
}
