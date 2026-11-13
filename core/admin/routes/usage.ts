// «Мои расходы» for every employee and «Расходы» for admins with the "usage" right.
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ModelConfig } from '../../config/schemas.ts';
import type { Db } from '../../db/pool.ts';
import { appError } from '../../errors/catalog.ts';
import type { Registry } from '../../loader/registry.ts';
import { requirePermission } from '../../server/guards.ts';
import { access, type AppEnv } from '../../server/http.ts';
import { employeeUsage, usageReport } from '../usage.ts';

const reportQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(['user', 'agent', 'model', 'deployment']),
});

export function registerUsageReportRoutes(app: Hono<AppEnv>, deps: { db: Db; registry: Registry; catalog: ModelConfig[]; timezone: string }): void {
  app.get('/app/api/me/usage', async (c) => c.json(await employeeUsage(deps.db, access(c).userId, deps.timezone, deps.catalog)));

  app.get('/app/api/admin/usage', requirePermission('usage'), async (c) => {
    const parsed = reportQuery.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', 'from, to (YYYY-MM-DD) and groupBy are required');
    const to = new Date(`${parsed.data.to}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1); // the "to" day is included
    const agentNames = new Map(deps.registry.agents.map((a) => [a.passport.id, a.passport.name]));
    return c.json(await usageReport(deps.db, { from: new Date(`${parsed.data.from}T00:00:00Z`), to, groupBy: parsed.data.groupBy, agentNames, catalog: deps.catalog }));
  });
}
