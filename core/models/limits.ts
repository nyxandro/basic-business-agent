// Limits set by the admin (spec, scenario 5 and section 8.1). LiteLLM enforces the monthly
// budgets (employee key, organisation team); the daily subscription cap is checked by the app.
import type { AppConfig } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';

export interface LimitSettings {
  orgMonthlyRub: number | null;
  defaultUserMonthlyRub: number | null;
  defaultDailySubscriptionTokens: number | null;
}

export interface UserLimits {
  monthlyRub: number | null;
  dailySubscriptionTokens: number | null;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

// First start: the admin's starting values come from config/app.ts; later the admin panel owns them.
export async function ensureLimitSettings(db: Db, initial: AppConfig['limits']): Promise<void> {
  await db.query(
    `INSERT INTO app.limit_settings (org_monthly_rub, default_user_monthly_rub, default_daily_subscription_tokens)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [initial.initialOrgMonthlyRub, initial.initialUserMonthlyRub, initial.initialDailySubscriptionTokens],
  );
}

export async function getLimitSettings(db: Db): Promise<LimitSettings> {
  const { rows } = await db.query<{ org: string | null; usr: string | null; daily: string | null }>(
    'SELECT org_monthly_rub AS org, default_user_monthly_rub AS usr, default_daily_subscription_tokens AS daily FROM app.limit_settings',
  );
  const row = rows[0];
  if (!row) throw new Error('APP_CONFIG_INVALID: app.limit_settings is empty: ensureLimitSettings was not called at start-up');
  return { orgMonthlyRub: num(row.org), defaultUserMonthlyRub: num(row.usr), defaultDailySubscriptionTokens: num(row.daily) };
}

// A personal value replaces the default; an absent one (NULL) means "the default applies".
export async function effectiveUserLimits(db: Db, userId: string): Promise<UserLimits> {
  const settings = await getLimitSettings(db);
  const { rows } = await db.query<{ monthly: string | null; daily: string | null }>(
    'SELECT monthly_rub AS monthly, daily_subscription_tokens AS daily FROM app.user_limits WHERE user_id = $1',
    [userId],
  );
  const own = rows[0];
  return {
    monthlyRub: num(own?.monthly ?? null) ?? settings.defaultUserMonthlyRub,
    dailySubscriptionTokens: num(own?.daily ?? null) ?? settings.defaultDailySubscriptionTokens,
  };
}
