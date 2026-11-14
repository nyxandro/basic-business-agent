// «Ждёт подтверждения» (spec, section 7): questions of background tasks, recent failures, counters.
import type { ApprovalsResponse, NotificationsResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Memory } from '@mastra/memory';
import { listForUser } from '../approvals/requests.ts';
import { toolCallArgsOf } from '../chat/history.ts';
import type { Db } from '../db/pool.ts';
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
    const { pending } = await listForUser(db, userId);
    const argsByThread = new Map<string, Map<string, unknown>>();
    for (const threadId of new Set(pending.map((p) => p.threadId))) argsByThread.set(threadId, await toolCallArgsOf(deps.memory, threadId, userId));
    const titles = new Map((await db.query<{ id: string; title: string }>('SELECT id, title FROM app.background_tasks WHERE owner_user_id = $1', [userId])).rows.map((r) => [r.id, r.title]));
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
        agent: agentName(p.agentId),
        task: p.taskId ? (titles.get(p.taskId) ?? p.taskId) : null,
        tool: p.tool,
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

  app.get('/app/api/me/notifications', async (c) => {
    const userId = access(c).userId;
    const { rows } = await db.query<{ approvals: number; unread: number }>(
      `SELECT (SELECT count(*)::int FROM app.approval_requests WHERE user_id = $1 AND task_id IS NOT NULL AND status = 'pending' AND expires_at > now()) AS approvals,
              (SELECT count(*)::int FROM app.background_tasks WHERE owner_user_id = $1 AND unread_result) AS unread`,
      [userId],
    );
    const body: NotificationsResponse = { pendingApprovals: rows[0]?.approvals ?? 0, unreadResults: rows[0]?.unread ?? 0 };
    return c.json(body);
  });

  app.post('/app/api/tasks/:id/read', async (c) => {
    await db.query('UPDATE app.background_tasks SET unread_result = false WHERE id = $1 AND owner_user_id = $2', [c.req.param('id'), access(c).userId]);
    return c.json({ ok: true });
  });
}
