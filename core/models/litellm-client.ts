// Thin client of LiteLLM's admin API (master key): the organisation team, employee keys, balances,
// the deployments of the admin's models and the check of a provider key.
import { AppError } from '../errors/app-error.ts';

export const ORG_TEAM_ID = 'org';
export const BUDGET_DURATION = '30d'; // LiteLLM resets "30d" budgets on the 1st at 00:00 of its configured time zone

export interface Balance {
  spend: number;
  maxBudget: number | null;
  resetAt: Date | null;
}

// A deployment of a model in LiteLLM's database: model_info.id is ours (`<model>:<key>`), and
// model_info carries which installation wrote it and a fingerprint of its parameters.
export interface DeploymentSpec {
  id: string;
  modelName: string;
  params: Record<string, string | number | boolean>;
  info: Record<string, string | number | boolean>;
}

export interface StoredDeployment {
  id: string;
  modelName: string;
  info: Record<string, unknown>;
  // Written into the database through the API; deployments of the configuration file are not.
  inDatabase: boolean;
}

export type ConnectionCheck = { ok: true } | { ok: false; error: string };
export type CheckMode = 'chat' | 'audio_transcription';

export interface LiteLLMClient {
  baseUrl: string;
  health(): Promise<boolean>;
  ensureTeam(maxBudget: number | null): Promise<void>;
  updateTeam(maxBudget: number | null): Promise<void>;
  teamBalance(): Promise<Balance>;
  generateKey(userId: string, maxBudget: number | null): Promise<string>;
  updateKey(key: string, maxBudget: number | null): Promise<void>;
  keyBalance(key: string): Promise<Balance>;
  deleteKey(key: string): Promise<void>;
  listDeployments(): Promise<StoredDeployment[]>;
  addDeployment(spec: DeploymentSpec): Promise<void>;
  updateDeployment(spec: DeploymentSpec): Promise<void>;
  deleteDeployment(id: string): Promise<void>;
  // LiteLLM's own probe of a provider with these parameters: nothing is stored. The probe asks for 16
  // tokens of answer unless `probeMaxTokens` says how many (`model_info.health_check_max_tokens`).
  // LiteLLM 1.109.1 takes the probe's model_info from a deployment of the same provider model when one
  // exists, and then the number given here is not used.
  checkConnection(params: Record<string, string | number | boolean>, mode: CheckMode, probeMaxTokens?: number): Promise<ConnectionCheck>;
  // LiteLLM's model map, about 3 MB (model-map.ts reads it): asked when a model is added, when the admin empties the
  // size of its context and at start for models without a limit of an answer or a size of the context.
  modelMap(): Promise<Record<string, unknown>>;
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

const DEPLOYMENTS_PAGE_SIZE = 200;

interface RawDeployment {
  model_name: string;
  model_info?: Record<string, unknown> & { id?: string; db_model?: boolean };
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
  async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, allow404 = false): Promise<T | null> {
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
    async deleteKey(key) {
      // Deleting a key that is already gone is fine: removal of an employee repeats safely.
      await call('POST', '/key/delete', { keys: [key] }, true);
    },
    async keyBalance(key) {
      const res = await call<{ info?: RawBalance }>('GET', `/key/info?key=${encodeURIComponent(key)}`);
      return toBalance(res?.info);
    },
    async listDeployments() {
      const all: StoredDeployment[] = [];
      for (let page = 1; ; page++) {
        const res = await call<{ data: RawDeployment[]; total_pages: number }>('GET', `/v2/model/info?page=${page}&size=${DEPLOYMENTS_PAGE_SIZE}`);
        for (const d of res?.data ?? []) {
          if (!d.model_info?.id) continue;
          all.push({ id: d.model_info.id, modelName: d.model_name, info: d.model_info, inDatabase: d.model_info.db_model === true });
        }
        if (!res || page >= res.total_pages) return all;
      }
    },
    async addDeployment(spec) {
      await call('POST', '/model/new', { model_name: spec.modelName, litellm_params: spec.params, model_info: { ...spec.info, id: spec.id } });
    },
    async updateDeployment(spec) {
      // PATCH replaces model_info too; POST /model/update keeps the old model_info (checked, V17).
      await call('PATCH', `/model/${encodeURIComponent(spec.id)}/update`, { model_name: spec.modelName, litellm_params: spec.params, model_info: { ...spec.info, id: spec.id } });
    },
    async deleteDeployment(id) {
      await call('POST', '/model/delete', { id }, true);
    },
    async checkConnection(params, mode, probeMaxTokens) {
      const modelInfo = probeMaxTokens === undefined ? {} : { model_info: { health_check_max_tokens: probeMaxTokens } };
      const res = await call<{ status: string; result?: { error?: string } }>('POST', '/health/test_connection', { litellm_params: params, mode, ...modelInfo });
      if (res?.status === 'success') return { ok: true };
      return { ok: false, error: res?.result?.error ?? `LiteLLM answered status ${res?.status ?? 'none'}` };
    },
    async modelMap() {
      const map = await call<Record<string, unknown>>('GET', '/public/litellm_model_cost_map');
      if (!map) throw gatewayUnavailable('LiteLLM GET /public/litellm_model_cost_map answered nothing');
      return map;
    },
  };
}
