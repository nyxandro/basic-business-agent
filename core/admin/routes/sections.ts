// Admin sections «Лимиты», «Агенты», «Профиль организации», «Маскирование», «Подключения»,
// «Журнал действий» (spec, scenario 5, section 17.5). Each needs its own right of the role.
import {
  agentModelSchema,
  agentStartersSchema,
  journalQuerySchema,
  limitSettingsSchema,
  maskingSettingsSchema,
  orgProfileSchema,
  promptDraftSchema,
} from '@bba/contracts';
import type { Hono } from 'hono';
import { writeAudit } from '../../audit/audit.ts';
import type { ConnectionManager } from '../../connections/manager.ts';
import type { Db } from '../../db/pool.ts';
import { getPromptState, publishDraft, revertToFile, saveDraft, setAgentModel, type EditorDeps } from '../../editor/prompts.ts';
import { appError } from '../../errors/catalog.ts';
import type { Registry } from '../../loader/registry.ts';
import { getMaskingKinds, setMaskingKinds } from '../../masking/settings.ts';
import type { ModelGateway } from '../../models/gateway.ts';
import { getLimitSettings } from '../../models/limits.ts';
import { requireAnyPermission, requirePermission } from '../../server/guards.ts';
import { access, parseJson, type AppEnv } from '../../server/http.ts';

const JOURNAL_PAGE_SIZE = 100;

export interface SectionDeps {
  db: Db;
  registry: Registry;
  editor: EditorDeps;
  gateway: Pick<ModelGateway, 'syncOrgBudget'>;
  connections: ConnectionManager;
}

export function registerAdminSections(app: Hono<AppEnv>, deps: SectionDeps): void {
  const { db } = deps;

  app.get('/app/api/admin/limits', requirePermission('limits'), async (c) => c.json(await getLimitSettings(db)));
  app.put('/app/api/admin/limits', requirePermission('limits'), async (c) => {
    const input = await parseJson(c, limitSettingsSchema);
    await db.query(
      `UPDATE app.limit_settings SET org_monthly_rub = $1, default_user_monthly_rub = $2, default_daily_subscription_tokens = $3, updated_by = $4, updated_at = now()`,
      [input.orgMonthlyRub, input.defaultUserMonthlyRub, input.defaultDailySubscriptionTokens, access(c).userId],
    );
    await deps.gateway.syncOrgBudget();
    await writeAudit(db, { actorUserId: access(c).userId, action: 'limits.update', target: null, details: input });
    return c.json({ ok: true });
  });

  app.get('/app/api/admin/limits/users', requirePermission('limits'), async (c) => {
    const { rows } = await db.query<{ user_id: string; monthly_rub: string | null; daily_subscription_tokens: string | null }>(
      'SELECT user_id, monthly_rub, daily_subscription_tokens FROM app.user_limits ORDER BY user_id',
    );
    const toNumber = (v: string | null) => (v === null ? null : Number(v));
    // Only personal values: null means the default from «Лимиты» applies.
    return c.json({ users: rows.map((r) => ({ userId: r.user_id, monthlyRub: toNumber(r.monthly_rub), dailySubscriptionTokens: toNumber(r.daily_subscription_tokens) })) });
  });

  const agents = requirePermission('agents');
  app.get('/app/api/admin/agents', requireAnyPermission('agents', 'departments'), async (c) => {
    const { rows } = await db.query<{ agent_id: string; names: string[] }>(
      'SELECT da.agent_id, array_agg(d.name ORDER BY d.name) AS names FROM app.department_agents da JOIN app.departments d ON d.id = da.department_id GROUP BY da.agent_id ORDER BY da.agent_id',
    );
    const departments = new Map(rows.map((r) => [r.agent_id, r.names]));
    const own = await db.query<{ agent_id: string; model_id: string | null; starters: string[] | null; published_version_id: string | null }>(
      'SELECT agent_id, model_id, starters, published_version_id FROM app.agent_overrides',
    );
    const override = new Map(own.rows.map((r) => [r.agent_id, r]));
    const known = deps.registry.ids();
    return c.json({
      agents: deps.registry.agents.map((a) => {
        const o = override.get(a.passport.id);
        return {
          id: a.passport.id,
          name: a.passport.name,
          description: a.passport.description,
          modelId: o?.model_id ?? null,
          departmentNames: departments.get(a.passport.id) ?? [],
          starters: o?.starters ?? a.passport.starters,
          startersCustom: o?.starters !== null && o?.starters !== undefined,
          promptChanged: Boolean(o?.published_version_id),
        };
      }),
      // Departments still pointing at agents removed from the installation (spec, section 10).
      missingAgents: rows.map((r) => r.agent_id).filter((id) => !known.has(id)),
    });
  });
  app.get('/app/api/admin/agents/:id/prompt', agents, async (c) => c.json(await getPromptState(deps.editor, c.req.param('id'))));
  app.put('/app/api/admin/agents/:id/prompt/draft', agents, async (c) => {
    const input = await parseJson(c, promptDraftSchema);
    return c.json({ draftVersionId: await saveDraft(deps.editor, access(c).userId, c.req.param('id'), input) });
  });
  app.post('/app/api/admin/agents/:id/prompt/publish', agents, async (c) => {
    await publishDraft(deps.editor, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/app/api/admin/agents/:id/prompt/revert', agents, async (c) => {
    await revertToFile(deps.editor, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });
  // The admin's starter questions instead of the passport's; null brings the passport's back.
  app.put('/app/api/admin/agents/:id/starters', agents, async (c) => {
    const id = c.req.param('id');
    if (!deps.registry.get(id)) throw appError('APP_NOT_FOUND', `agent ${id} is not loaded`);
    const { starters } = await parseJson(c, agentStartersSchema);
    await db.query('INSERT INTO app.agent_overrides (agent_id, starters) VALUES ($1, $2) ON CONFLICT (agent_id) DO UPDATE SET starters = EXCLUDED.starters', [id, starters]);
    await writeAudit(db, { actorUserId: access(c).userId, action: 'agent.starters', target: id, details: { starters } });
    return c.json({ ok: true });
  });

  app.put('/app/api/admin/agents/:id/model', agents, async (c) => {
    const { modelId } = await parseJson(c, agentModelSchema);
    await setAgentModel(deps.editor, access(c).userId, c.req.param('id'), modelId);
    return c.json({ ok: true });
  });
  const org = requirePermission('org_profile');
  // The row exists from the first start of the server (ensureOrgName).
  app.get('/app/api/admin/org-profile', org, async (c) => {
    const { rows } = await db.query<{ name: string; tone: string; requisites: string; industry: string }>('SELECT name, tone, requisites, industry FROM app.org_profile');
    if (!rows[0]) throw new Error('app.org_profile has no row: ensureOrgName runs at the start of the server');
    return c.json(rows[0]);
  });
  app.put('/app/api/admin/org-profile', org, async (c) => {
    const input = await parseJson(c, orgProfileSchema);
    await db.query('UPDATE app.org_profile SET name = $1, tone = $2, requisites = $3, industry = $4, updated_by = $5, updated_at = now()', [
      input.name,
      input.tone,
      input.requisites,
      input.industry,
      access(c).userId,
    ]);
    await writeAudit(db, { actorUserId: access(c).userId, action: 'org_profile.update', target: null });
    return c.json({ ok: true });
  });

  const masking = requirePermission('masking');
  app.get('/app/api/admin/masking', masking, async (c) => c.json({ kinds: [...(await getMaskingKinds(db))] }));
  app.put('/app/api/admin/masking', masking, async (c) => {
    const { kinds } = await parseJson(c, maskingSettingsSchema);
    await setMaskingKinds(db, access(c).userId, kinds);
    return c.json({ ok: true });
  });

  app.get('/app/api/admin/connections', requirePermission('connections'), async (c) => {
    const { rows } = await db.query<{ connector_id: string; status: string; n: number }>(
      'SELECT connector_id, status, count(*)::int AS n FROM app.connector_credentials GROUP BY connector_id, status',
    );
    const total = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id" WHERE p.blocked_at IS NULL AND p.deletion_started_at IS NULL`,
    );
    const connections = [...deps.connections.connectors.values()].map((conn) => ({
      id: conn.id,
      title: conn.title,
      mode: conn.mode,
      auth: conn.auth,
      employees: Object.fromEntries(rows.filter((r) => r.connector_id === conn.id).map((r) => [r.status, r.n])),
    }));
    return c.json({ connections, employeesTotal: total.rows[0]!.n });
  });

  app.get('/app/api/admin/journal', requirePermission('journal'), async (c) => {
    const parsed = journalQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', 'journal needs from and to (YYYY-MM-DD)');
    const q = parsed.data;
    const to = new Date(`${q.to}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    const { rows } = await db.query<{ id: string; at: Date; user_name: string | null; agent_id: string | null; run_kind: string; event: string; tool: string | null; args_summary: unknown; approved_by: string | null; result: string; error_code: string | null }>(
      `SELECT j.id, j.at, u."name" AS user_name, j.agent_id, j.run_kind, j.event, j.tool, j.args_summary, j.approved_by, j.result, j.error_code
         FROM app.action_journal j LEFT JOIN app."user" u ON u."id" = j.user_id
        WHERE j.at >= $1 AND j.at < $2 AND ($3::text IS NULL OR j.user_id = $3) AND ($4::text IS NULL OR j.agent_id = $4)
        ORDER BY j.at DESC LIMIT $5 OFFSET $6`,
      [new Date(`${q.from}T00:00:00Z`), to, q.userId ?? null, q.agentId ?? null, JOURNAL_PAGE_SIZE, (q.page - 1) * JOURNAL_PAGE_SIZE],
    );
    const agentName = (id: string | null) => (id ? (deps.registry.get(id)?.passport.name ?? id) : null);
    return c.json({
      entries: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), user: r.user_name, agent: agentName(r.agent_id), runKind: r.run_kind, event: r.event, tool: r.tool, args: r.args_summary, approvedBy: r.approved_by, result: r.result, errorCode: r.error_code })),
      pageSize: JOURNAL_PAGE_SIZE,
    });
  });
}
