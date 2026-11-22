// «Ждёт подтверждения» (spec, section 7): questions of background tasks and of conversations (decision of the owner
// 21.11, F4), a question by its id, recent failures. The counters of the bell are core/notifications/routes.ts.
import type { ApprovalsResponse, ApprovalStateResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Memory } from '@mastra/memory';
import { expireChatQuestions, getApproval, listPending } from '../approvals/requests.ts';
import { toolCallArgsOf } from '../chat/history.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { Registry } from '../loader/registry.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import type { BackgroundService } from './service.ts';

const decisionBody = z.object({ approved: z.boolean() });
const FAILURE_WINDOW = "interval '7 days'";

export function registerBackgroundRoutes(app: Hono<AppEnv>, deps: { db: Db; registry: Registry; background: BackgroundService; memory: Memory }): void {
  const { db } = deps;
  const agentName = (id: string) => deps.registry.get(id)?.passport.name ?? id;

  app.get('/app/api/approvals', async (c) => {
    const userId = access(c).userId;
    await deps.background.expireOverdue();
    await expireChatQuestions(db);
    const pending = await listPending(db, userId);
    const argsByThread = new Map<string, Map<string, unknown>>();
    for (const threadId of new Set(pending.map((p) => p.threadId))) argsByThread.set(threadId, await toolCallArgsOf(deps.memory, threadId, userId));
    const titles = new Map(
      (await db.query<{ id: string; title: string }>('SELECT DISTINCT t.id, t.title FROM app.background_tasks t JOIN app.approval_requests a ON a.task_id = t.id WHERE a.user_id = $1', [userId])).rows.map((r) => [r.id, r.title]),
    );
    // A question of a conversation is answered there: the list names the conversation and leads to it.
    const chatThreads = [...new Set(pending.filter((p) => !p.taskId).map((p) => p.threadId))];
    const threadTitles = new Map(
      chatThreads.length === 0 ? [] : (await db.query<{ id: string; title: string | null }>('SELECT id, title FROM mastra.mastra_threads WHERE id = ANY($1)', [chatThreads])).rows.map((r) => [r.id, r.title || 'Без названия']),
    );
    const failures = await db.query<{ at: Date; agent_id: string; task_id: string | null; event: string; tool: string | null; error_code: string | null }>(
      `SELECT at, agent_id, task_id, event, tool, error_code FROM app.action_journal
        WHERE user_id = $1 AND run_kind = 'background' AND at > now() - ${FAILURE_WINDOW}
          AND (result IN ('error', 'expired') OR (event = 'background_skipped'))
        ORDER BY at DESC LIMIT 50`,
      [userId],
    );
    const body: ApprovalsResponse = {
      pending: pending.map((p) => ({
        id: p.id,
        toolCallId: p.toolCallId,
        agent: agentName(p.agentId),
        task: p.taskId ? (titles.get(p.taskId) ?? p.taskId) : null,
        conversation: p.taskId ? null : { threadId: p.threadId, agentId: p.agentId, title: threadTitles.get(p.threadId) ?? 'Без названия' },
        tool: p.tool,
        // A question exists only for an action that changes data.
        action: { title: p.summary, fields: p.labels, readOnly: false, choices: p.choices },
        args: argsByThread.get(p.threadId)?.get(p.toolCallId) ?? p.args,
        createdAt: p.createdAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
      })),
      failed: failures.rows.map((f) => ({
        at: f.at.toISOString(),
        agent: agentName(f.agent_id),
        task: f.task_id ? (titles.get(f.task_id) ?? f.task_id) : null,
        event: f.event,
        tool: f.tool,
        code: f.error_code,
      })),
    };
    return c.json(body);
  });

  app.post('/app/api/approvals/:id/decision', async (c) => {
    const { approved } = await parseJson(c, decisionBody);
    await deps.background.decide(access(c).userId, c.req.param('id'), approved);
    return c.json({ ok: true });
  });

  // Where an old notification leads: the question still waits, or what became of it and when (section 9).
  app.get('/app/api/approvals/:id', async (c) => {
    const id = c.req.param('id');
    const approval = UUID.test(id) ? await getApproval(db, access(c).userId, id) : null;
    if (!approval) throw appError('APP_NOT_FOUND', `approval ${id} not found`, { userMessage: 'Такого вопроса нет.' });
    // A question past its term reads as burnt even before the sweep marked it.
    const burnt = approval.status === 'pending' && approval.expiresAt.getTime() <= Date.now();
    const body: ApprovalStateResponse = {
      id,
      status: burnt ? 'expired' : approval.status,
      action: approval.summary,
      decidedAt: burnt ? approval.expiresAt.toISOString() : (approval.decidedAt?.toISOString() ?? null),
    };
    return c.json(body);
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
