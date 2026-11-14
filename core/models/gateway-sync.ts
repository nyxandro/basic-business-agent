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

export function deploymentId(modelId: string, keyOrAccountId: string): string {
  return `${modelId}:${keyOrAccountId}`;
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, FINGERPRINT_CHARS);
}

function priceParams(m: SyncModel): Record<string, number> {
  if (m.prices) return pricesToLiteLLM(m.prices);
  if (m.pricePerMinute !== null) return perMinuteToLiteLLM(m.pricePerMinute);
  throw new Error(`APP_CONFIG_INVALID: model ${m.id} on a key has no prices`);
}

export function deploymentsOf(state: SyncState, owner: string): DeploymentSpec[] {
  const out: DeploymentSpec[] = [];
  for (const m of state.models) {
    if (!m.enabled) continue;
    if (m.connection === 'chatgpt') {
      for (const a of state.accounts) {
        // A subscription costs nothing per token: its tokens count against the daily cap only.
        const params = { model: m.providerModel, chatgpt_auth_file: `${GATEWAY_AUTH_DIR}/${a.id}.json`, ...pricesToLiteLLM(ZERO_PRICES) };
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
      const visible = { model: m.providerModel, ...(m.apiBase ? { api_base: m.apiBase } : {}), ...priceParams(m) };
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
