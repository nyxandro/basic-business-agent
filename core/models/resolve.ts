// Which model answers for an agent (spec, section 8.1) — the one place that decides it:
//   1. the agent's own model, when «Агенты выбирают модель из каталога» is on and the model is enabled;
//   2. otherwise the organisation's primary model, when enabled;
//   3. otherwise APP_MODEL_NOT_CONFIGURED.
// The fallback model, when set, enabled and different, goes second. A subscription model is
// subject to the employee's daily token cap: a capped primary refuses the request, a capped
// fallback is left out.
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { effectiveUserLimits } from './limits.ts';
import { todaySubscriptionTokens } from './usage.ts';

export interface ModelChoice {
  primary: string;
  fallback: string | null;
}

interface ChoiceRow {
  agents_choose_model: boolean;
  own_id: string | null;
  own_enabled: boolean | null;
  own_kind: string | null;
  own_subscription: boolean | null;
  primary_id: string | null;
  primary_enabled: boolean | null;
  primary_subscription: boolean | null;
  fallback_id: string | null;
  fallback_enabled: boolean | null;
  fallback_subscription: boolean | null;
}

// An installation where no agent can answer yet: no enabled primary model (spec, «Пустая установка»).
export async function modelsConfigured(db: Db): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM app.model_settings s JOIN app.models m ON m.id = s.primary_model_id WHERE m.enabled');
  return (rowCount ?? 0) > 0;
}

export async function chooseModels(db: Db, timezone: string, userId: string, agentId: string): Promise<ModelChoice> {
  const { rows } = await db.query<ChoiceRow>(
    `SELECT s.agents_choose_model,
            own.id AS own_id, own.enabled AS own_enabled, own.kind AS own_kind, own.connection = 'chatgpt' AS own_subscription,
            p.id AS primary_id, p.enabled AS primary_enabled, p.connection = 'chatgpt' AS primary_subscription,
            f.id AS fallback_id, f.enabled AS fallback_enabled, f.connection = 'chatgpt' AS fallback_subscription
       FROM app.model_settings s
       LEFT JOIN app.agent_overrides o ON o.agent_id = $1
       LEFT JOIN app.models own ON own.id = o.model_id
       LEFT JOIN app.models p ON p.id = s.primary_model_id
       LEFT JOIN app.models f ON f.id = s.fallback_model_id`,
    [agentId],
  );
  const r = rows[0];
  if (!r) throw new Error('app.model_settings has no row: migrations were not applied');
  const primary =
    r.agents_choose_model && r.own_id && r.own_enabled && r.own_kind === 'chat'
      ? { id: r.own_id, subscription: Boolean(r.own_subscription) }
      : r.primary_id && r.primary_enabled
        ? { id: r.primary_id, subscription: Boolean(r.primary_subscription) }
        : null;
  if (!primary) throw appError('APP_MODEL_NOT_CONFIGURED', `no enabled model for agent ${agentId}`);
  let fallback = r.fallback_id && r.fallback_enabled && r.fallback_id !== primary.id ? { id: r.fallback_id, subscription: Boolean(r.fallback_subscription) } : null;

  if (primary.subscription || fallback?.subscription) {
    const { dailySubscriptionTokens } = await effectiveUserLimits(db, userId);
    const used = dailySubscriptionTokens === null ? 0 : await todaySubscriptionTokens(db, userId, timezone);
    if (dailySubscriptionTokens !== null && used >= dailySubscriptionTokens) {
      if (primary.subscription) throw appError('APP_USAGE_DAILY_CAP_EXCEEDED', `daily subscription cap reached: ${used} >= ${dailySubscriptionTokens} tokens`);
      fallback = null;
    }
  }
  return { primary: primary.id, fallback: fallback?.id ?? null };
}
