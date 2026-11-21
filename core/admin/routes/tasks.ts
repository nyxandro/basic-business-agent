// «Режимы работы» (spec, scenario 4, section 17.5): background tasks of the organisation.
// Under the right "agents", like the agents themselves.
import { approvalSettingsSchema, taskCreateSchema, taskStatusSchema, taskUpdateSchema } from '@bba/contracts';
import type { Hono } from 'hono';
import { getApprovalSettings, setApprovalSettings } from '../../approvals/settings.ts';
import { writeAudit } from '../../audit/audit.ts';
import { createTask, listTasks, removeTask, setTaskStatus, taskRuns, updateTask, type TasksDeps } from '../../background/tasks.ts';
import { requirePermission } from '../../server/guards.ts';
import { access, parseJson, type AppEnv } from '../../server/http.ts';

export function registerTaskRoutes(app: Hono<AppEnv>, deps: TasksDeps): void {
  const agents = requirePermission('agents');

  app.get('/app/api/admin/tasks', agents, async (c) => c.json({ tasks: await listTasks(deps.db) }));

  app.post('/app/api/admin/tasks', agents, async (c) => {
    const input = await parseJson(c, taskCreateSchema);
    return c.json(await createTask(deps, access(c).userId, input), 201);
  });

  app.put('/app/api/admin/tasks/:id', agents, async (c) => {
    const change = await parseJson(c, taskUpdateSchema);
    return c.json(await updateTask(deps, access(c).userId, c.req.param('id'), change));
  });

  app.put('/app/api/admin/tasks/:id/status', agents, async (c) => {
    const { status } = await parseJson(c, taskStatusSchema);
    return c.json(await setTaskStatus(deps, access(c).userId, c.req.param('id'), status));
  });

  app.delete('/app/api/admin/tasks/:id', agents, async (c) => {
    await removeTask(deps, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/app/api/admin/tasks/:id/runs', agents, async (c) => c.json(await taskRuns(deps.db, c.req.param('id'), c.req.query('fireAt') ?? null)));

  // «Подтверждения»: how long a question «Да» waits (docs/specs/[20.11.2026]-notifications.md, F4).
  app.get('/app/api/admin/approval-settings', agents, async (c) => c.json(await getApprovalSettings(deps.db)));

  app.put('/app/api/admin/approval-settings', agents, async (c) => {
    const next = await parseJson(c, approvalSettingsSchema);
    await setApprovalSettings(deps.db, next);
    await writeAudit(deps.db, { actorUserId: access(c).userId, action: 'approvals.settings', target: null, details: { ...next } });
    return c.json(await getApprovalSettings(deps.db));
  });
}
