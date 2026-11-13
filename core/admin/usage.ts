// Spend for the employee («Настройки → Мои расходы», F5) and for the admin («Расходы»),
// read from our ledger app.usage_events (spec, section 8.1), never from LiteLLM's own tables.
import type { ModelConfig } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';
import { effectiveUserLimits, getLimitSettings } from '../models/limits.ts';
import { todaySubscriptionTokens } from '../models/usage.ts';

export type UsageGroup = 'user' | 'agent' | 'model' | 'deployment';

export interface EmployeeUsage {
  month: { spentRub: number; limitRub: number | null; resetsOn: string };
  daily: { usedTokens: number; capTokens: number } | null;
}

export interface UsageRow {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costRub: number;
  lastCallAt: string | null;
}

const MONTH_START = `(date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)`;

function nextMonthStart(timezone: string): string {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  local.setMonth(local.getMonth() + 1, 1);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-01`;
}

export async function employeeUsage(db: Db, userId: string, timezone: string, catalog: ModelConfig[]): Promise<EmployeeUsage> {
  const [{ monthlyRub, dailySubscriptionTokens }, spent] = await Promise.all([
    effectiveUserLimits(db, userId),
    db.query<{ s: string }>(`SELECT coalesce(sum(cost_rub), 0) AS s FROM app.usage_events WHERE user_id = $2 AND at >= ${MONTH_START}`, [timezone, userId]),
  ]);
  const hasSubscription = catalog.some((m) => m.subscription);
  return {
    month: { spentRub: Number(spent.rows[0]?.s ?? 0), limitRub: monthlyRub, resetsOn: nextMonthStart(timezone) },
    daily: hasSubscription && dailySubscriptionTokens !== null ? { usedTokens: await todaySubscriptionTokens(db, userId, timezone), capTokens: dailySubscriptionTokens } : null,
  };
}

const GROUP_COLUMN: Record<UsageGroup, string> = { user: 'e.user_id', agent: 'e.agent_id', model: 'e.model', deployment: 'e.deployment' };

export async function usageReport(
  db: Db,
  input: { from: Date; to: Date; groupBy: UsageGroup; agentNames: ReadonlyMap<string, string>; catalog: ModelConfig[] },
): Promise<{ rows: UsageRow[]; totalRub: number; orgLimitRub: number | null }> {
  const column = GROUP_COLUMN[input.groupBy];
  const { rows } = await db.query<{ key: string | null; user_name: string | null; calls: number; input: string; output: string; cost: string; last: Date | null }>(
    `SELECT ${column} AS key, max(u."name") AS user_name, count(*)::int AS calls, sum(e.input_tokens) AS input, sum(e.output_tokens) AS output,
            sum(e.cost_rub) AS cost, max(e.at) AS last
       FROM app.usage_events e LEFT JOIN app."user" u ON u."id" = e.user_id
      WHERE e.at >= $1 AND e.at < $2
      GROUP BY ${column} ORDER BY sum(e.cost_rub) DESC, count(*) DESC`,
    [input.from, input.to],
  );
  const modelLabels = new Map(input.catalog.map((m) => [m.id, m.label]));
  const label = (key: string | null, userName: string | null): string => {
    if (key === null) return '—';
    if (input.groupBy === 'user') return userName ?? key;
    if (input.groupBy === 'agent') return input.agentNames.get(key) ?? key;
    if (input.groupBy === 'model') return modelLabels.get(key) ?? key;
    return key;
  };
  const out = rows.map((r) => ({
    key: r.key ?? '',
    label: label(r.key, r.user_name),
    calls: r.calls,
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    costRub: Number(r.cost),
    lastCallAt: r.last?.toISOString() ?? null,
  }));
  return { rows: out, totalRub: out.reduce((s, r) => s + r.costRub, 0), orgLimitRub: (await getLimitSettings(db)).orgMonthlyRub };
}
