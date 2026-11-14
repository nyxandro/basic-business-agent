// The model gateway as the rest of the core sees it (spec, section 8.1):
// every call goes to LiteLLM with the employee's own virtual key, so LiteLLM counts spend per
// employee and per organisation and refuses calls past the monthly budgets before the model runs.
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import type { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { LiteLLMClient } from './litellm-client.ts';
import { effectiveUserLimits, getLimitSettings } from './limits.ts';
import { AGENT_HEADER } from './usage.ts';

export interface ModelCallConfig {
  providerId: string;
  modelId: string;
  url: string;
  apiKey: string;
  headers: Record<string, string>;
}

export interface ModelGateway {
  // The call of a model chosen by resolve.ts, on the employee's own key.
  modelConfig(modelId: string, userId: string, agentId: string): Promise<ModelCallConfig>;
  // Monthly limits by our own ledger: checked before an approved action runs (spec, section 8.4).
  assertWithinBudget(userId: string): Promise<void>;
  translateError(error: unknown, userId: string): Promise<AppError>;
  syncOrgBudget(): Promise<void>;
  syncUserBudget(userId: string): Promise<void>;
  // Removes the employee's LiteLLM key (deletion of an employee).
  forgetUser(userId: string): Promise<void>;
  health(): Promise<boolean>;
}

export interface GatewayDeps {
  db: Db;
  client: LiteLLMClient;
  box: SecretBox;
  timezone: string;
}

const PROVIDER_ID = 'litellm';

interface HttpLikeError {
  statusCode?: number;
  status?: number;
  responseBody?: string;
  message?: string;
  cause?: unknown;
  code?: string;
}

// The AI SDK wraps provider errors; walk the cause chain to the HTTP details.
function httpDetails(error: unknown): { status: number | null; text: string } {
  const texts: string[] = [];
  let status: number | null = null;
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as HttpLikeError;
    status ??= e.statusCode ?? e.status ?? null;
    if (e.responseBody) texts.push(e.responseBody);
    if (e.message) texts.push(e.message);
    if (e.code) texts.push(e.code);
    current = e.cause;
  }
  return { status, text: texts.join(' | ') };
}

function formatResetDate(date: Date | null, timezone: string): string {
  if (!date) return 'в начале следующего месяца';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: timezone }).format(date);
}

export function createModelGateway(deps: GatewayDeps): ModelGateway {
  const { db, client, box, timezone } = deps;

  async function storedKey(userId: string): Promise<string | null> {
    const { rows } = await db.query<{ c: Buffer; iv: Buffer; v: number }>(
      'SELECT litellm_key_ciphertext AS c, iv, key_version AS v FROM app.model_keys WHERE user_id = $1',
      [userId],
    );
    return rows[0] ? box.open({ ciphertext: rows[0].c, iv: rows[0].iv, keyVersion: rows[0].v }) : null;
  }

  async function userKey(userId: string): Promise<string> {
    const existing = await storedKey(userId);
    if (existing) return existing;
    // Serialise the first request of one employee so parallel requests do not create two keys.
    return inTransaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('model_key:' || $1))", [userId]);
      const again = await storedKey(userId);
      if (again) return again;
      const { monthlyRub } = await effectiveUserLimits(db, userId);
      const key = await client.generateKey(userId, monthlyRub);
      const sealed = box.seal(key);
      await c.query('INSERT INTO app.model_keys (user_id, litellm_key_ciphertext, iv, key_version) VALUES ($1, $2, $3, $4)', [
        userId,
        sealed.ciphertext,
        sealed.iv,
        sealed.keyVersion,
      ]);
      return key;
    });
  }

  return {
    async modelConfig(modelId, userId, agentId) {
      return {
        providerId: PROVIDER_ID,
        modelId,
        url: new URL('/v1', client.baseUrl).toString(),
        apiKey: await userKey(userId),
        headers: { [AGENT_HEADER]: agentId },
      };
    },

    async assertWithinBudget(userId) {
      const [{ monthlyRub }, settings] = await Promise.all([effectiveUserLimits(db, userId), getLimitSettings(db)]);
      const monthStart = `(date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1)`;
      const nextMonth = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
      nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
      const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(nextMonth);
      if (monthlyRub !== null) {
        const { rows } = await db.query<{ s: string }>(`SELECT coalesce(sum(cost_rub), 0) AS s FROM app.usage_events WHERE user_id = $2 AND at >= ${monthStart}`, [timezone, userId]);
        if (Number(rows[0]?.s) >= monthlyRub) {
          throw appError('APP_USAGE_LIMIT_EXCEEDED', `employee spent ${rows[0]?.s} of ${monthlyRub} RUB this month`, {
            userMessage: `Ваш лимит расходов на этот месяц исчерпан. Новый лимит начнётся ${date}. Если нужно раньше — обратитесь к администратору.`,
          });
        }
      }
      if (settings.orgMonthlyRub !== null) {
        const { rows } = await db.query<{ s: string }>(`SELECT coalesce(sum(cost_rub), 0) AS s FROM app.usage_events WHERE at >= ${monthStart}`, [timezone]);
        if (Number(rows[0]?.s) >= settings.orgMonthlyRub) {
          throw appError('APP_USAGE_ORG_LIMIT_EXCEEDED', `organisation spent ${rows[0]?.s} of ${settings.orgMonthlyRub} RUB this month`, {
            userMessage: `Лимит расходов организации на этот месяц исчерпан. Новый лимит начнётся ${date}. Обратитесь к администратору.`,
          });
        }
      }
    },

    async translateError(error, userId) {
      const { status, text } = httpDetails(error);
      const lower = text.toLowerCase();
      if (lower.includes('budget') && lower.includes('exceeded')) {
        // LiteLLM names the exhausted budget in its refusal ("Key=…" or "Team=…") at the moment it refuses;
        // the balances it reports are written with a delay, so they decide only when the refusal says nothing.
        const key = await storedKey(userId);
        const [own, org] = await Promise.all([key ? client.keyBalance(key) : null, client.teamBalance()]);
        const named = text.includes('Team=') ? 'org' : text.includes('Key=') ? 'user' : null;
        const ownSpent = named ? named === 'user' : own !== null && own.maxBudget !== null && own.spend >= own.maxBudget;
        if (ownSpent && own) {
          const date = formatResetDate(own.resetAt, timezone);
          return appError('APP_USAGE_LIMIT_EXCEEDED', `employee budget exhausted: ${text.slice(0, 200)}`, {
            cause: error,
            userMessage: `Ваш лимит расходов на этот месяц исчерпан. Новый лимит начнётся ${date}. Если нужно раньше — обратитесь к администратору.`,
          });
        }
        const date = formatResetDate(org.resetAt, timezone);
        return appError('APP_USAGE_ORG_LIMIT_EXCEEDED', `organisation budget exhausted: ${text.slice(0, 200)}`, {
          cause: error,
          userMessage: `Лимит расходов организации на этот месяц исчерпан. Новый лимит начнётся ${date}. Обратитесь к администратору.`,
        });
      }
      if (status === null && /econnrefused|fetch failed|cannot connect|socket hang up|enotfound/.test(lower)) {
        return appError('APP_MODEL_GATEWAY_UNAVAILABLE', `LiteLLM unreachable: ${text.slice(0, 300)}`, { cause: error });
      }
      if (lower.includes('context') && (lower.includes('length') || lower.includes('window'))) {
        return appError('APP_MODEL_CONTEXT_EXCEEDED', text.slice(0, 300), { cause: error });
      }
      if (status === 429 || /rate.?limit|too many requests|\b429\b/i.test(text)) return appError('APP_MODEL_RATE_LIMITED', text.slice(0, 300), { cause: error });
      // In the chat stream the error arrives as text only: LiteLLM names the provider's refusal of the key.
      const keyRefused = /authenticationerror|authentication_error|permissiondeniederror|incorrect api key|invalid api key/.test(lower);
      if (status === 401 || status === 403 || keyRefused) return appError('APP_MODEL_AUTH_FAILED', text.slice(0, 300), { cause: error });
      return appError('APP_MODEL_UNAVAILABLE', `model call failed (${status ?? 'no status'}): ${text.slice(0, 300)}`, { cause: error });
    },

    async syncOrgBudget() {
      const settings = await getLimitSettings(db);
      await client.ensureTeam(settings.orgMonthlyRub);
    },

    async syncUserBudget(userId) {
      const key = await storedKey(userId);
      if (!key) return; // the key gets the current limit when it is created on the first request
      const { monthlyRub } = await effectiveUserLimits(db, userId);
      await client.updateKey(key, monthlyRub);
    },

    async forgetUser(userId) {
      const key = await storedKey(userId);
      if (key) await client.deleteKey(key);
      await db.query('DELETE FROM app.model_keys WHERE user_id = $1', [userId]);
    },

    health: () => client.health(),
  };
}
