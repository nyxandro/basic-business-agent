// «Израсходовано 80 % лимита» and «Лимит исчерпан» (docs/specs/[20.11.2026]-notifications.md): after the gateway reports
// a paid call, the employee's spend of the month (by the time zone of the installation) is set against their personal
// monthly limit. Each notice comes once a month. LiteLLM itself stops the calls at the limit; this only tells.
import type { Db } from '../db/pool.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { effectiveUserLimits } from './limits.ts';

export const LIMIT_NEAR_SHARE = 0.8;

export async function noticeLimits(db: Db, userId: string, timezone: string): Promise<void> {
  const { monthlyRub } = await effectiveUserLimits(db, userId);
  if (monthlyRub === null || monthlyRub <= 0) return;
  const { rows } = await db.query<{ spent: string; month: string }>(
    `SELECT coalesce(sum(cost_rub), 0) AS spent, to_char(now() AT TIME ZONE $2, 'YYYY-MM') AS month FROM app.usage_events
      WHERE user_id = $1 AND at >= (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [userId, timezone],
  );
  const spent = Number(rows[0]?.spent ?? 0);
  const month = rows[0]!.month;
  if (spent >= monthlyRub) {
    await notify(db, notices.limitExhausted({ userId, month, limitRub: monthlyRub }));
    return;
  }
  if (spent >= monthlyRub * LIMIT_NEAR_SHARE) {
    await notify(db, notices.limitNear({ userId, month, percent: Math.floor((spent / monthlyRub) * 100), spentRub: spent, limitRub: monthlyRub }));
  }
}
