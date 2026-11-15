// The admin's catalog of models (spec, scenario 9, section 8.1): models, provider keys and the
// organisation's choice, kept in our database and copied into LiteLLM.
// Every change goes to LiteLLM first and to our database second: if LiteLLM refuses, nothing is
// saved and «Попробуйте ещё раз» means exactly that; if our write fails after LiteLLM took the
// change, LiteLLM is only ahead (an extra or newer deployment) and the next full copy fixes it.
// A removed key leaves LiteLLM before it leaves our database, so it is never used after removal.
import { randomBytes } from 'node:crypto';
import type { ModelCreate, ModelDto, ModelKeyDto, ModelKind, ModelSettings, ModelsResponse, ModelUpdate, TokenPrices, TokenPricesInput } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../server/log.ts';
import type { ChatGptAccounts } from './chatgpt-accounts.ts';
import { pendingModels, type SyncModel, type SyncResult } from './gateway-sync.ts';
import type { GatewayWriter } from './gateway-writer.ts';
import type { LiteLLMClient } from './litellm-client.ts';
import { num, pricesOf, type ModelRow } from './model-rows.ts';
import { outputLimitIn } from './output-limit.ts';

export const LABEL_MAX = 80;
const KEY_MAX = 500;
const KEY_TAIL = 4;
// LiteLLM's way of naming a model: the provider, a slash, the provider's model.
const PROVIDER_MODEL = /^[a-z0-9][a-z0-9_-]*\/\S{1,190}$/;
// A model of the ChatGPT subscription: LiteLLM's provider chatgpt, e.g. chatgpt/gpt-5.4.
const SUBSCRIPTION_MODEL = /^chatgpt\/\S{1,190}$/;
// Errors of LiteLLM's probe that mean the provider did not answer rather than refused the key.
const NO_ANSWER = /timeout|timed out|connection error|connecterror|connection refused|econnrefused|unreachable|name resolution|nodename/i;

const PRICES_MISSING = 'Укажите все цены в рублях — без них расход посчитается неверно.';
const NO_VISION = 'Эта модель не видит картинки — агенты перестанут читать сканы. Выберите модель с картинками.';

export interface CatalogDeps {
  db: Db;
  box: SecretBox;
  client: LiteLLMClient;
  writer: GatewayWriter;
  accounts: ChatGptAccounts;
  agentName(agentId: string): string;
}

export interface ModelCatalog {
  list(): Promise<ModelsResponse>;
  create(actorUserId: string, input: ModelCreate): Promise<ModelDto>;
  update(actorUserId: string, modelId: string, change: ModelUpdate): Promise<ModelDto>;
  remove(actorUserId: string, modelId: string): Promise<void>;
  addKey(actorUserId: string, modelId: string, key: string): Promise<ModelKeyDto>;
  removeKey(actorUserId: string, modelId: string, keyId: string): Promise<void>;
  updateSettings(actorUserId: string, input: ModelSettings): Promise<ModelSettings>;
  // The full copy into LiteLLM, at the start of the server; models without a limit of an answer get
  // it from the gateway's model map first (section 8.19).
  sync(): Promise<SyncResult>;
}

interface KeyRow {
  id: string;
  model_id: string;
  key_ciphertext: Buffer;
  key_iv: Buffer;
  key_version: number;
  key_last4: string;
  created_at: Date;
}

interface SettingsRow {
  primary_model_id: string | null;
  fallback_model_id: string | null;
  transcription_model_id: string | null;
  agents_choose_model: boolean;
}

const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;
const invalid = (message: string, userMessage: string) => appError('APP_VALIDATION_FAILED', message, { userMessage });
const notFound = (what: string) => appError('APP_NOT_FOUND', `${what} not found`, { userMessage: 'Модель не найдена. Обновите страницу.' });

function cleanLabel(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > LABEL_MAX) throw invalid(`model label of ${clean.length} chars`, `Название модели — от 1 до ${LABEL_MAX} символов.`);
  return clean;
}

function cleanKey(key: string): string {
  const clean = key.trim();
  if (clean.length < KEY_TAIL + 1 || clean.length > KEY_MAX || /\s/.test(clean)) throw invalid('provider key is empty or malformed', 'Вставьте ключ провайдера целиком, без пробелов.');
  return clean;
}

// Token prices complete, or (recognition only) a price per minute: never a half-filled form.
function checkPrices(kind: ModelKind, prices: TokenPricesInput | null, perMinute: number | null): { prices: TokenPrices | null; perMinute: number | null } {
  const values = prices ? Object.values(prices) : [];
  const complete = prices !== null && values.every((v) => v !== null);
  const empty = values.every((v) => v === null);
  if (complete && perMinute === null) return { prices: prices as TokenPrices, perMinute: null };
  if (kind === 'transcription' && empty && perMinute !== null) return { prices: null, perMinute };
  throw invalid(`incomplete prices for a ${kind} model`, PRICES_MISSING);
}

function redact(text: string, key: string): string {
  return text.split(key).join(`…${key.slice(-KEY_TAIL)}`).split('\n')[0]!.slice(0, 300);
}

export function createModelCatalog(deps: CatalogDeps): ModelCatalog {
  const { db, box, client, writer } = deps;
  const serial = writer.serial;
  const syncState = writer.state;
  const apply = writer.apply;

  async function rows(): Promise<{ models: ModelRow[]; keys: KeyRow[] }> {
    const [models, keys] = await Promise.all([
      db.query<ModelRow>('SELECT * FROM app.models ORDER BY created_at, id'),
      db.query<KeyRow>('SELECT * FROM app.model_provider_keys ORDER BY created_at, id'),
    ]);
    return { models: models.rows, keys: keys.rows };
  }

  async function settingsRow(): Promise<SettingsRow> {
    const { rows: s } = await db.query<SettingsRow>('SELECT primary_model_id, fallback_model_id, transcription_model_id, agents_choose_model FROM app.model_settings');
    if (!s[0]) throw new Error('app.model_settings has no row: migrations were not applied');
    return s[0];
  }

  async function modelRow(modelId: string): Promise<ModelRow> {
    const { rows: found } = await db.query<ModelRow>('SELECT * FROM app.models WHERE id = $1', [modelId]);
    if (!found[0]) throw notFound(`model ${modelId}`);
    return found[0];
  }

  async function agentsOf(modelId: string): Promise<string[]> {
    const { rows: refs } = await db.query<{ agent_id: string }>('SELECT agent_id FROM app.agent_overrides WHERE model_id = $1 ORDER BY agent_id', [modelId]);
    return refs.map((r) => r.agent_id);
  }

  async function checkKey(m: { providerModel: string; apiBase: string | null; kind: ModelKind }, key: string): Promise<void> {
    const res = await client.checkConnection({ model: m.providerModel, api_key: key, ...(m.apiBase ? { api_base: m.apiBase } : {}) }, m.kind === 'transcription' ? 'audio_transcription' : 'chat');
    if (res.ok) return;
    const error = redact(res.error, key);
    logEvent('warn', 'model_check_failed', { providerModel: m.providerModel, keyLast4: key.slice(-KEY_TAIL), error });
    throw appError('APP_MODEL_CHECK_FAILED', `provider check of ${m.providerModel} failed: ${error}`, NO_ANSWER.test(error) ? { userMessage: 'Провайдер не ответил. Попробуйте ещё раз.' } : {});
  }

  // The admin's limit, or the one the gateway knows; none — the admin is asked for it (section 8.19).
  async function outputLimit(input: Extract<ModelCreate, { connection: 'api_key' }>, providerModel: string): Promise<number | null> {
    if (input.kind === 'transcription') {
      if (input.maxOutputTokens !== null) throw invalid('a recognition model with a limit of an answer', 'У модели распознавания речи нет длины ответа — оставьте поле пустым.');
      return null;
    }
    if (input.maxOutputTokens !== null) return input.maxOutputTokens;
    const known = outputLimitIn(await client.modelMap(), providerModel);
    if (known === null) throw appError('APP_MODEL_OUTPUT_LIMIT_REQUIRED', `the gateway does not know the limit of an answer of ${providerModel}`);
    return known;
  }

  // Models added before 15.11.2026 have no limit: the gateway's model map gives what it knows.
  async function fillOutputLimits(): Promise<void> {
    const missing = (await syncState()).models.filter((m) => m.connection === 'api_key' && m.kind === 'chat' && m.maxOutputTokens === null);
    if (missing.length === 0) return;
    let map: Record<string, unknown>;
    try {
      map = await client.modelMap();
    } catch (error) {
      // These models keep their deployments as they were (section 8.19); the start goes on bringing
      // the gateway in line, and the next start looks for their limits again.
      logEvent('error', 'model_output_limits_unavailable', { code: isAppError(error) ? error.code : 'APP_MODEL_GATEWAY_UNAVAILABLE', modelIds: missing.map((m) => m.id), error });
      return;
    }
    for (const m of missing) {
      const limit = outputLimitIn(map, m.providerModel);
      if (limit === null) {
        logEvent('error', 'model_output_limit_unknown', { modelId: m.id, providerModel: m.providerModel });
        continue;
      }
      await db.query('UPDATE app.models SET max_output_tokens = $2, updated_at = now() WHERE id = $1 AND max_output_tokens IS NULL', [m.id, limit]);
      logEvent('info', 'model_output_limit_filled', { modelId: m.id, providerModel: m.providerModel, maxOutputTokens: limit });
    }
  }

  function toDto(r: ModelRow, keys: KeyRow[], agentIds: string[]): ModelDto {
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      connection: r.connection,
      providerModel: r.provider_model,
      apiBase: r.api_base,
      vision: r.vision,
      enabled: r.enabled,
      prices: pricesOf(r),
      pricePerMinute: num(r.price_per_minute),
      maxOutputTokens: r.max_output_tokens,
      keys: keys.filter((k) => k.model_id === r.id).map((k) => ({ id: k.id, last4: k.key_last4, createdAt: k.created_at.toISOString() })),
      agentIds,
    };
  }

  async function dtoOf(modelId: string): Promise<ModelDto> {
    const [row, keys, agentIds] = await Promise.all([modelRow(modelId), db.query<KeyRow>('SELECT * FROM app.model_provider_keys WHERE model_id = $1 ORDER BY created_at, id', [modelId]), agentsOf(modelId)]);
    return toDto(row, keys.rows, agentIds);
  }

  async function createOnKey(actorUserId: string, input: Extract<ModelCreate, { connection: 'api_key' }>): Promise<ModelDto> {
    const label = cleanLabel(input.label);
    const providerModel = input.providerModel.trim();
    if (!PROVIDER_MODEL.test(providerModel)) throw invalid(`provider model "${providerModel}"`, 'Укажите провайдера и модель через косую черту, например openai/gpt-4.1-mini.');
    const apiBase = input.apiBase?.trim() || null;
    if (apiBase !== null && !URL.canParse(apiBase)) throw invalid(`api base "${apiBase}"`, 'Адрес провайдера — ссылка вида https://…');
    const { prices, perMinute } = checkPrices(input.kind, input.prices, input.pricePerMinute);
    const key = cleanKey(input.key);
    // Before the provider is called: a model without a known limit waits for the admin's number.
    const maxOutputTokens = await outputLimit(input, providerModel);
    const model: SyncModel = { id: newId('m'), kind: input.kind, connection: 'api_key', providerModel, apiBase, enabled: true, prices, pricePerMinute: perMinute, maxOutputTokens };
    await checkKey(model, key);
    const keyId = newId('k');
    const state = await syncState();
    await apply({ ...state, models: [...state.models, model], keys: [...state.keys, { id: keyId, modelId: model.id, secret: key }] });
    const sealed = box.seal(key);
    const vision = input.kind === 'chat' && input.vision;
    await inTransaction(db, async (c) => {
      await c.query(
        `INSERT INTO app.models (id, kind, label, connection, provider_model, api_base, vision, price_input, price_output, price_cache_read,
                                 price_cache_write, price_reasoning, price_image, price_per_minute, max_output_tokens, created_by)
         VALUES ($1, $2, $3, 'api_key', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [model.id, model.kind, label, providerModel, apiBase, vision, prices?.input ?? null, prices?.output ?? null, prices?.cacheRead ?? null, prices?.cacheWrite ?? null, prices?.reasoning ?? null, prices?.image ?? null, perMinute, maxOutputTokens, actorUserId],
      );
      await c.query('INSERT INTO app.model_provider_keys (id, model_id, key_ciphertext, key_iv, key_version, key_last4, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
        keyId,
        model.id,
        sealed.ciphertext,
        sealed.iv,
        sealed.keyVersion,
        key.slice(-KEY_TAIL),
        actorUserId,
      ]);
      await writeAudit(c, { actorUserId, action: 'model.create', target: model.id, details: { label, kind: model.kind, providerModel, maxOutputTokens, keyLast4: key.slice(-KEY_TAIL) } });
    });
    return dtoOf(model.id);
  }

  // A subscription model: no key and no prices; LiteLLM gets one deployment per active account.
  async function createSubscription(actorUserId: string, input: Extract<ModelCreate, { connection: 'chatgpt' }>): Promise<ModelDto> {
    const label = cleanLabel(input.label);
    const providerModel = input.providerModel.trim();
    if (!SUBSCRIPTION_MODEL.test(providerModel)) throw invalid(`subscription model "${providerModel}"`, 'Модель подписки пишется как chatgpt/ и название модели, например chatgpt/gpt-5.4.');
    const model: SyncModel = { id: newId('m'), kind: 'chat', connection: 'chatgpt', providerModel, apiBase: null, enabled: true, prices: null, pricePerMinute: null, maxOutputTokens: null };
    const state = await syncState();
    await apply({ ...state, models: [...state.models, model] });
    await inTransaction(db, async (c) => {
      await c.query(`INSERT INTO app.models (id, kind, label, connection, provider_model, vision, created_by) VALUES ($1, 'chat', $2, 'chatgpt', $3, $4, $5)`, [
        model.id,
        label,
        providerModel,
        input.vision,
        actorUserId,
      ]);
      await writeAudit(c, { actorUserId, action: 'model.create', target: model.id, details: { label, kind: 'chat', providerModel, connection: 'chatgpt' } });
    });
    return dtoOf(model.id);
  }

  return {
    async list() {
      const [r, settings, refs, accounts] = await Promise.all([
        rows(),
        settingsRow(),
        db.query<{ agent_id: string; model_id: string }>('SELECT agent_id, model_id FROM app.agent_overrides WHERE model_id IS NOT NULL ORDER BY agent_id'),
        deps.accounts.list(),
      ]);
      const checkedAt = new Date().toISOString();
      let gateway: ModelsResponse['gateway'];
      try {
        const current = (await client.listDeployments()).filter((d) => d.inDatabase && d.info.bba_owner === writer.owner);
        gateway = { reachable: true, checkedAt, pendingModelIds: pendingModels(writer.desired(await syncState()), current) };
      } catch (error) {
        logEvent('warn', 'gateway_unreachable', { error });
        gateway = { reachable: false, checkedAt, pendingModelIds: [] };
      }
      return {
        models: r.models.map((m) => toDto(m, r.keys, refs.rows.filter((x) => x.model_id === m.id).map((x) => x.agent_id))),
        settings: {
          primaryModelId: settings.primary_model_id,
          fallbackModelId: settings.fallback_model_id,
          transcriptionModelId: settings.transcription_model_id,
          agentsChooseModel: settings.agents_choose_model,
        },
        gateway,
        accounts,
      };
    },

    create: (actorUserId, input) => serial(() => (input.connection === 'chatgpt' ? createSubscription(actorUserId, input) : createOnKey(actorUserId, input))),

    update: (actorUserId, modelId, change) =>
      serial(async () => {
        const row = await modelRow(modelId);
        const label = change.label === undefined ? row.label : cleanLabel(change.label);
        const vision = row.kind === 'chat' && (change.vision ?? row.vision);
        const enabled = change.enabled ?? row.enabled;
        const settings = await settingsRow();
        if (!vision && [settings.primary_model_id, settings.fallback_model_id].includes(modelId)) {
          throw invalid(`model ${modelId} is primary or fallback and must see images`, 'Модель выбрана основной или запасной — без картинок агенты перестанут читать сканы. Сначала выберите в «Параметрах» другую модель.');
        }
        let prices = pricesOf(row);
        let perMinute = num(row.price_per_minute);
        const pricesChanged = change.prices !== undefined || change.pricePerMinute !== undefined;
        if (pricesChanged) {
          if (row.connection !== 'api_key') throw invalid(`model ${modelId} is a subscription`, 'У модели подписки нет цен.');
          ({ prices, perMinute } = checkPrices(row.kind, change.prices === undefined ? prices : change.prices, change.pricePerMinute === undefined ? perMinute : change.pricePerMinute));
        }
        // The label and «Видит картинки» are ours only; LiteLLM learns of switching and prices.
        if (pricesChanged || enabled !== row.enabled) {
          const state = await syncState();
          await apply({ ...state, models: state.models.map((m) => (m.id === modelId ? { ...m, enabled, prices, pricePerMinute: perMinute } : m)) });
        }
        await inTransaction(db, async (c) => {
          await c.query(
            `UPDATE app.models SET label = $2, vision = $3, enabled = $4, price_input = $5, price_output = $6, price_cache_read = $7, price_cache_write = $8,
                    price_reasoning = $9, price_image = $10, price_per_minute = $11, updated_at = now() WHERE id = $1`,
            [modelId, label, vision, enabled, prices?.input ?? null, prices?.output ?? null, prices?.cacheRead ?? null, prices?.cacheWrite ?? null, prices?.reasoning ?? null, prices?.image ?? null, perMinute],
          );
          await writeAudit(c, { actorUserId, action: 'model.update', target: modelId, details: { ...change } });
        });
        return dtoOf(modelId);
      }),

    remove: (actorUserId, modelId) =>
      serial(async () => {
        await modelRow(modelId);
        const agents = await agentsOf(modelId);
        // Agents use their own model only while «Агенты выбирают модель из каталога» is on.
        if (agents.length > 0 && (await settingsRow()).agents_choose_model) {
          const names = agents.map((id) => deps.agentName(id)).join(', ');
          throw appError('APP_MODEL_IN_USE', `model ${modelId} is the own model of agents ${agents.join(', ')}`, {
            userMessage: `Модель нужна агентам: ${names}. Сначала выберите основную модель организации или другую модель этим агентам.`,
            details: { agentIds: agents },
          });
        }
        const state = await syncState();
        await apply({ ...state, models: state.models.filter((m) => m.id !== modelId), keys: state.keys.filter((k) => k.modelId !== modelId) });
        await inTransaction(db, async (c) => {
          await c.query('DELETE FROM app.models WHERE id = $1', [modelId]);
          await writeAudit(c, { actorUserId, action: 'model.delete', target: modelId });
        });
      }),

    addKey: (actorUserId, modelId, rawKey) =>
      serial(async () => {
        const row = await modelRow(modelId);
        if (row.connection !== 'api_key') throw invalid(`model ${modelId} is a subscription`, 'Модель подписки работает через аккаунты ChatGPT, ключ ей не нужен.');
        const key = cleanKey(rawKey);
        await checkKey({ providerModel: row.provider_model, apiBase: row.api_base, kind: row.kind }, key);
        const keyId = newId('k');
        const state = await syncState();
        await apply({ ...state, keys: [...state.keys, { id: keyId, modelId, secret: key }] });
        const sealed = box.seal(key);
        const { rows: inserted } = await inTransaction(db, async (c) => {
          const res = await c.query<KeyRow>(
            'INSERT INTO app.model_provider_keys (id, model_id, key_ciphertext, key_iv, key_version, key_last4, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [keyId, modelId, sealed.ciphertext, sealed.iv, sealed.keyVersion, key.slice(-KEY_TAIL), actorUserId],
          );
          await writeAudit(c, { actorUserId, action: 'model.key.add', target: modelId, details: { keyId, keyLast4: key.slice(-KEY_TAIL) } });
          return res;
        });
        return { id: inserted[0]!.id, last4: inserted[0]!.key_last4, createdAt: inserted[0]!.created_at.toISOString() };
      }),

    removeKey: (actorUserId, modelId, keyId) =>
      serial(async () => {
        const { rows: keys } = await db.query<{ id: string }>('SELECT id FROM app.model_provider_keys WHERE model_id = $1', [modelId]);
        if (!keys.some((k) => k.id === keyId)) throw notFound(`key ${keyId} of model ${modelId}`);
        if (keys.length === 1) throw invalid(`key ${keyId} is the last key of ${modelId}`, 'Это последний ключ модели — без него она перестанет отвечать. Добавьте новый ключ или удалите модель.');
        const state = await syncState();
        await apply({ ...state, keys: state.keys.filter((k) => k.id !== keyId) });
        await inTransaction(db, async (c) => {
          await c.query('DELETE FROM app.model_provider_keys WHERE id = $1', [keyId]);
          await writeAudit(c, { actorUserId, action: 'model.key.delete', target: modelId, details: { keyId } });
        });
      }),

    updateSettings: (actorUserId, input) =>
      serial(async () => {
        const byId = new Map((await rows()).models.map((m) => [m.id, m]));
        const pick = (id: string | null, kind: ModelKind): ModelRow | null => {
          if (id === null) return null;
          const m = byId.get(id);
          if (!m) throw notFound(`model ${id}`);
          if (m.kind !== kind) throw invalid(`model ${id} is ${m.kind}, not ${kind}`, kind === 'chat' ? 'Для ответов агентов нужна модель чата.' : 'Для распознавания речи нужна модель распознавания.');
          return m;
        };
        for (const m of [pick(input.primaryModelId, 'chat'), pick(input.fallbackModelId, 'chat')]) {
          if (m && !m.vision) throw invalid(`model ${m.id} does not see images`, NO_VISION);
        }
        pick(input.transcriptionModelId, 'transcription');
        if (input.fallbackModelId !== null && input.fallbackModelId === input.primaryModelId) throw invalid('fallback equals primary', 'Запасная модель должна отличаться от основной.');
        await inTransaction(db, async (c) => {
          await c.query(
            'UPDATE app.model_settings SET primary_model_id = $1, fallback_model_id = $2, transcription_model_id = $3, agents_choose_model = $4, updated_by = $5, updated_at = now()',
            [input.primaryModelId, input.fallbackModelId, input.transcriptionModelId, input.agentsChooseModel, actorUserId],
          );
          await writeAudit(c, { actorUserId, action: 'model.settings', target: null, details: { ...input } });
        });
        return input;
      }),

    sync: () =>
      serial(async () => {
        await fillOutputLimits();
        return apply(await syncState());
      }),
  };
}
