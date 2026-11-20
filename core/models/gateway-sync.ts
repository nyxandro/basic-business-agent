// Copies the admin's models into LiteLLM (spec, section 8.1). Our database is the source of truth:
// each enabled model on keys becomes one deployment per key, `model_info.id = <model>:<key>`; each
// enabled subscription model — one deployment per active ChatGPT account, `<model>:<account>`.
// The sync touches only deployments marked with this installation's owner tag, so models an
// operator added to LiteLLM by hand — and, in tests, other test databases — stay untouched.
import { createHash } from 'node:crypto';
import type { ModelConnection, ModelKind, TokenPrices } from '@bba/contracts';
import { AppError } from '../errors/app-error.ts';
import { ERROR_CATALOG } from '../errors/catalog.ts';
import type { DeploymentSpec, LiteLLMClient } from './litellm-client.ts';
import { perMinuteToLiteLLM, pricesToLiteLLM, ZERO_PRICES } from './prices.ts';

// Owner tag of an installation's deployments; one LiteLLM serves one installation.
export const GATEWAY_OWNER = 'bba';
const FINGERPRINT_CHARS = 16;

export interface SyncModel {
  id: string;
  kind: ModelKind;
  connection: ModelConnection;
  providerModel: string;
  apiBase: string | null;
  enabled: boolean;
  prices: TokenPrices | null;
  pricePerMinute: number | null;
  // The longest answer, in tokens (section 8.19): a chat model on a key; null — not known.
  maxOutputTokens: number | null;
}

// A provider key with its secret, opened only to be written into LiteLLM.
export interface SyncKey {
  id: string;
  modelId: string;
  secret: string;
}

// An account LiteLLM may send requests to (not one in «Ошибка доступа»).
export interface SyncAccount {
  id: string;
}

export interface SyncState {
  models: SyncModel[];
  keys: SyncKey[];
  accounts: SyncAccount[];
}

// Where LiteLLM sees the login files of the accounts: the volume chatgpt-auth (compose files).
export const GATEWAY_AUTH_DIR = '/chatgpt-auth';

// How long the gateway waits on a provider (decision of the owner 15.11). A provider may go silent
// with the connection open — mid-answer or before it (neuraldeep and Groq on 15.11) — and that is no
// error to anyone: Mastra would wait the five minutes of one call (MODEL_CALL_MAX_MS) and end the
// answer, LiteLLM held such requests up to 6 000 s. LiteLLM's `stream_timeout` is the read timeout of
// a live stream: no byte for `silenceSeconds`, and the gateway cuts the stream itself and reports it
// as a failure (code 408) — the agent repeats the step like any break (core/runtime/stream-retry.ts).
// `timeout` bounds a request that is not streamed (the naming call, speech).
export interface GatewayTimeouts {
  silenceSeconds: number;
  requestSeconds: number;
}

export const GATEWAY_TIMEOUTS: GatewayTimeouts = { silenceSeconds: 60, requestSeconds: 300 };

function waitParams(kind: ModelKind, timeouts: GatewayTimeouts): Record<string, number> {
  return { timeout: timeouts.requestSeconds, ...(kind === 'chat' ? { stream_timeout: timeouts.silenceSeconds } : {}) };
}

export function deploymentId(modelId: string, keyOrAccountId: string): string {
  return `${modelId}:${keyOrAccountId}`;
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, FINGERPRINT_CHARS);
}

// LiteLLM puts the parameters of a deployment into every request that does not bring its own, so the
// limit and the reasoning format hold for every caller of the model (spec, section 8.19). Groq stops
// an answer at 2 048 tokens without a limit, and some of its models write their reasoning into the
// text of the answer unless asked to keep it apart. The check of a key sends the same (catalog.ts).
export function answerParams(m: Pick<SyncModel, 'kind' | 'maxOutputTokens' | 'providerModel'>): Record<string, string | number> {
  if (m.kind !== 'chat') return {};
  return { ...(m.maxOutputTokens !== null ? { max_tokens: m.maxOutputTokens } : {}), ...(m.providerModel.startsWith('groq/') ? { reasoning_format: 'parsed' } : {}) };
}

function priceParams(m: SyncModel): Record<string, number> {
  if (m.prices) return pricesToLiteLLM(m.prices);
  if (m.pricePerMinute !== null) return perMinuteToLiteLLM(m.pricePerMinute);
  throw new Error(`APP_CONFIG_INVALID: model ${m.id} on a key has no prices`);
}

export function deploymentsOf(state: SyncState, owner: string, timeouts: GatewayTimeouts): DeploymentSpec[] {
  const out: DeploymentSpec[] = [];
  for (const m of state.models) {
    if (!m.enabled) continue;
    if (m.connection === 'chatgpt') {
      for (const a of state.accounts) {
        // A subscription costs nothing per token: its tokens count against the daily cap only.
        const params = { model: m.providerModel, chatgpt_auth_file: `${GATEWAY_AUTH_DIR}/${a.id}.json`, ...pricesToLiteLLM(ZERO_PRICES), ...waitParams(m.kind, timeouts) };
        out.push({
          id: deploymentId(m.id, a.id),
          modelName: m.id,
          params,
          info: { bba_owner: owner, bba_fingerprint: fingerprintOf({ params, kind: m.kind }), mode: 'chat' },
        });
      }
      continue;
    }
    for (const k of state.keys.filter((key) => key.modelId === m.id)) {
      const visible = { model: m.providerModel, ...(m.apiBase ? { api_base: m.apiBase } : {}), ...priceParams(m), ...answerParams(m), ...waitParams(m.kind, timeouts) };
      // Keys never change in place (a new key is a new row), so the key id stands for the secret.
      const fingerprint = fingerprintOf({ visible, key: k.id, kind: m.kind });
      out.push({
        id: deploymentId(m.id, k.id),
        modelName: m.id,
        params: { ...visible, api_key: k.secret },
        info: { bba_owner: owner, bba_fingerprint: fingerprint, mode: m.kind === 'transcription' ? 'audio_transcription' : 'chat' },
      });
    }
  }
  return out;
}

export function syncFailed(message: string, cause: unknown): AppError {
  return new AppError({ code: 'APP_GATEWAY_SYNC_FAILED', message, userMessage: ERROR_CATALOG.APP_GATEWAY_SYNC_FAILED.userMessage, status: 502, cause });
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
}

// Brings LiteLLM to exactly the desired deployments of this owner. What goes away goes first: a
// refusal of LiteLLM to take another model's deployment must not keep a removed key or a revoked
// account in it.
export async function reconcile(client: LiteLLMClient, owner: string, desired: DeploymentSpec[]): Promise<SyncResult> {
  const result: SyncResult = { added: [], updated: [], removed: [] };
  try {
    const current = new Map((await client.listDeployments()).filter((d) => d.inDatabase && d.info.bba_owner === owner).map((d) => [d.id, d]));
    const wanted = new Set(desired.map((d) => d.id));
    for (const id of current.keys()) {
      if (wanted.has(id)) continue;
      await client.deleteDeployment(id);
      result.removed.push(id);
    }
    for (const spec of desired) {
      const existing = current.get(spec.id);
      if (!existing) {
        await client.addDeployment(spec);
        result.added.push(spec.id);
      } else if (existing.info.bba_fingerprint !== spec.info.bba_fingerprint || existing.modelName !== spec.modelName) {
        await client.updateDeployment(spec);
        result.updated.push(spec.id);
      }
    }
  } catch (error) {
    throw syncFailed(`gateway sync failed after ${JSON.stringify(result)}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  return result;
}

// Models whose deployments in LiteLLM differ from ours (missing, extra or with old parameters).
export function pendingModels(desired: DeploymentSpec[], current: { id: string; modelName: string; info: Record<string, unknown> }[]): string[] {
  const pending = new Set<string>();
  const have = new Map(current.map((d) => [d.id, d]));
  for (const spec of desired) {
    if (have.get(spec.id)?.info.bba_fingerprint !== spec.info.bba_fingerprint) pending.add(spec.modelName);
    have.delete(spec.id);
  }
  for (const d of have.values()) pending.add(d.modelName);
  return [...pending].sort();
}
