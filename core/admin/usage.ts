// Spend for the employee («Настройки → Мои расходы», F5) and for the admin («Расходы»),
// read from our ledger app.usage_events (spec, section 8.1), never from LiteLLM's own tables.
import type { MyUsage, UsageDay, UsageGroup, UsageRow } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { effectiveUserLimits, getLimitSettings } from '../models/limits.ts';
import { todaySubscriptionTokens } from '../models/usage.ts';

export type { UsageGroup, UsageRow } from '@bba/contracts';

// The shape is read by the web interface («Мои расходы»).
export type EmployeeUsage = MyUsage;


const MONTH_START = `(date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)`;

function nextMonthStart(timezone: string): string {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  local.setMonth(local.getMonth() + 1, 1);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-01`;
}

export async function employeeUsage(db: Db, userId: string, timezone: string): Promise<EmployeeUsage> {
  const [{ monthlyRub, dailySubscriptionTokens }, spent, subscription] = await Promise.all([
    effectiveUserLimits(db, userId),
    db.query<{ s: string }>(`SELECT coalesce(sum(cost_rub), 0) AS s FROM app.usage_events WHERE user_id = $2 AND at >= ${MONTH_START}`, [timezone, userId]),
    db.query("SELECT 1 FROM app.models WHERE connection = 'chatgpt' AND enabled LIMIT 1"),
  ]);
  const hasSubscription = (subscription.rowCount ?? 0) > 0;
  return {
    month: { spentRub: Number(spent.rows[0]?.s ?? 0), limitRub: monthlyRub, resetsOn: nextMonthStart(timezone) },
    daily: hasSubscription && dailySubscriptionTokens !== null ? { usedTokens: await todaySubscriptionTokens(db, userId, timezone), capTokens: dailySubscriptionTokens } : null,
  };
}

const GROUP_COLUMN: Record<UsageGroup, string> = { user: 'e.user_id', agent: 'e.agent_id', model: 'e.model', deployment: 'e.deployment' };

export async function usageReport(
  db: Db,
  // Days of the installation's time zone, both included (docs/specs/[20.11.2026]-feedback-and-value.md, F3): the table
  // counts as the chart and the monthly limit do.
  input: { from: string; to: string; timezone: string; groupBy: UsageGroup; agentNames: ReadonlyMap<string, string> },
): Promise<{ rows: UsageRow[]; totalRub: number; orgLimitRub: number | null }> {
  const column = GROUP_COLUMN[input.groupBy];
  const { rows } = await db.query<{ key: string | null; user_name: string | null; calls: number; input: string; output: string; cost: string; last: Date | null }>(
    `SELECT ${column} AS key, max(u."name") AS user_name, count(*)::int AS calls, sum(e.input_tokens) AS input, sum(e.output_tokens) AS output,
            sum(e.cost_rub) AS cost, max(e.at) AS last
       FROM app.usage_events e LEFT JOIN app."user" u ON u."id" = e.user_id
      WHERE e.at >= ($1::date::timestamp AT TIME ZONE $3) AND e.at < (($2::date + 1)::timestamp AT TIME ZONE $3)
      GROUP BY ${column} ORDER BY sum(e.cost_rub) DESC, count(*) DESC`,
    [input.from, input.to, input.timezone],
  );
  const models = await db.query<{ id: string; label: string }>('SELECT id, label FROM app.models');
  const modelLabels = new Map(models.rows.map((m) => [m.id, m.label]));
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

// «График по дням» (spec, scenario 5): spend of the organisation per day of the installation's time
// zone, every day of the range, zero where nothing was spent.
export async function dailyUsage(db: Db, input: { from: string; to: string; timezone: string }): Promise<UsageDay[]> {
  const { rows } = await db.query<{ day: string; cost: string }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(sum(e.cost_rub), 0) AS cost
       FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
       LEFT JOIN app.usage_events e ON (e.at AT TIME ZONE $3)::date = d.day::date
      GROUP BY d.day ORDER BY d.day`,
    [input.from, input.to, input.timezone],
  );
  return rows.map((r) => ({ day: r.day, costRub: Number(r.cost) }));
}
