// Thin client of LiteLLM's admin API (master key): the organisation team, employee keys, balances.
import { AppError } from '../errors/app-error.ts';

export const ORG_TEAM_ID = 'org';
export const BUDGET_DURATION = '30d'; // LiteLLM resets "30d" budgets on the 1st at 00:00 of its configured time zone

export interface Balance {
  spend: number;
  maxBudget: number | null;
  resetAt: Date | null;
}

export interface LiteLLMClient {
  baseUrl: string;
  health(): Promise<boolean>;
  ensureTeam(maxBudget: number | null): Promise<void>;
  updateTeam(maxBudget: number | null): Promise<void>;
  teamBalance(): Promise<Balance>;
  generateKey(userId: string, maxBudget: number | null): Promise<string>;
  updateKey(key: string, maxBudget: number | null): Promise<void>;
  keyBalance(key: string): Promise<Balance>;
}

export function gatewayUnavailable(message: string, cause?: unknown): AppError {
  return new AppError({
    code: 'APP_MODEL_GATEWAY_UNAVAILABLE',
    message,
    userMessage: 'Сервис моделей сейчас не отвечает. Попробуйте через минуту; если повторяется — сообщите администратору код ошибки.',
    status: 503,
    ...(cause !== undefined ? { cause } : {}),
  });
}

interface RawBalance {
  spend?: number | null;
  max_budget?: number | null;
  budget_reset_at?: string | null;
}

function toBalance(raw: RawBalance | undefined): Balance {
  return {
    spend: raw?.spend ?? 0,
    maxBudget: raw?.max_budget ?? null,
    resetAt: raw?.budget_reset_at ? new Date(raw.budget_reset_at) : null,
  };
}

// teamId is ORG_TEAM_ID in an installation; tests pass their own so they never share balances.
export function createLiteLLMClient(baseUrl: string, masterKey: string, teamId: string = ORG_TEAM_ID): LiteLLMClient {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, allow404 = false): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(new URL(path, baseUrl), {
        method,
        headers: { authorization: `Bearer ${masterKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw gatewayUnavailable(`LiteLLM ${method} ${path} failed to connect`, error);
    }
    if (allow404 && (res.status === 404 || res.status === 400)) return null;
    if (!res.ok) throw gatewayUnavailable(`LiteLLM ${method} ${path} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  return {
    baseUrl,
    async health() {
      try {
        return (await fetch(new URL('/health/liveliness', baseUrl))).ok;
      } catch {
        return false;
      }
    },
    async ensureTeam(maxBudget) {
      const existing = await call<{ team_info?: RawBalance }>('GET', `/team/info?team_id=${teamId}`, undefined, true);
      if (existing?.team_info) return this.updateTeam(maxBudget);
      await call('POST', '/team/new', { team_id: teamId, team_alias: 'Организация', max_budget: maxBudget, budget_duration: BUDGET_DURATION });
    },
    async updateTeam(maxBudget) {
      await call('POST', '/team/update', { team_id: teamId, max_budget: maxBudget, budget_duration: BUDGET_DURATION });
    },
    async teamBalance() {
      const res = await call<{ team_info?: RawBalance }>('GET', `/team/info?team_id=${teamId}`);
      return toBalance(res?.team_info);
    },
    async generateKey(userId, maxBudget) {
      const res = await call<{ key: string }>('POST', '/key/generate', {
        user_id: userId,
        team_id: teamId,
        key_alias: `user-${userId}`,
        max_budget: maxBudget,
        budget_duration: BUDGET_DURATION,
      });
      if (!res?.key) throw gatewayUnavailable('LiteLLM /key/generate returned no key');
      return res.key;
    },
    async updateKey(key, maxBudget) {
      await call('POST', '/key/update', { key, max_budget: maxBudget, budget_duration: BUDGET_DURATION });
    },
    async keyBalance(key) {
      const res = await call<{ info?: RawBalance }>('GET', `/key/info?key=${encodeURIComponent(key)}`);
      return toBalance(res?.info);
    },
  };
}
