// «Мои расходы» for every employee and «Расходы» for admins with the "usage" right.
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/pool.ts';
import { appError } from '../../errors/catalog.ts';
import type { Registry } from '../../loader/registry.ts';
import { requirePermission } from '../../server/guards.ts';
import { access, type AppEnv } from '../../server/http.ts';
import { dailyUsage, employeeUsage, usageReport } from '../usage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RANGE_MAX_DAYS = 366;

const reportQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  groupBy: z.enum(['user', 'agent', 'model', 'deployment']),
});

export function registerUsageReportRoutes(app: Hono<AppEnv>, deps: { db: Db; registry: Registry; timezone: string }): void {
  app.get('/app/api/me/usage', async (c) => c.json(await employeeUsage(deps.db, access(c).userId, deps.timezone)));

  app.get('/app/api/admin/usage/daily', requirePermission('usage'), async (c) => {
    const parsed = z.object({ from: z.iso.date(), to: z.iso.date() }).safeParse(c.req.query());
    const days = parsed.success ? (Date.parse(parsed.data.to) - Date.parse(parsed.data.from)) / DAY_MS : -1;
    if (!parsed.success || days < 0 || days > DAILY_RANGE_MAX_DAYS) {
      throw appError('APP_VALIDATION_FAILED', `daily usage needs from ≤ to within ${DAILY_RANGE_MAX_DAYS} days`, { userMessage: 'Выберите период не больше года.' });
    }
    return c.json({ days: await dailyUsage(deps.db, { ...parsed.data, timezone: deps.timezone }) });
  });

  app.get('/app/api/admin/usage', requirePermission('usage'), async (c) => {
    const parsed = reportQuery.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', 'from, to (YYYY-MM-DD) and groupBy are required');
    const to = new Date(`${parsed.data.to}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1); // the "to" day is included
    const agentNames = new Map(deps.registry.agents.map((a) => [a.passport.id, a.passport.name]));
    return c.json(await usageReport(deps.db, { from: new Date(`${parsed.data.from}T00:00:00Z`), to, groupBy: parsed.data.groupBy, agentNames }));
  });
}
