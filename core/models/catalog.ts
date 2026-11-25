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
import { logEvent } from '../log/log.ts';
import { fillPrimaryModel } from './auto-primary.ts';
import { checkFailure } from './check-failure.ts';
import type { ChatGptAccounts } from './chatgpt-accounts.ts';
import { answerParams, pendingModels, type SyncModel, type SyncResult } from './gateway-sync.ts';
import type { GatewayWriter } from './gateway-writer.ts';
import type { LiteLLMClient } from './litellm-client.ts';
import { num, pricesOf, type ModelRow } from './model-rows.ts';
import { inputLimitIn, outputLimitIn } from './model-map.ts';

export const LABEL_MAX = 80;
const KEY_MAX = 500;
const KEY_TAIL = 4;
// LiteLLM's way of naming a model: the provider, a slash, the provider's model.
const PROVIDER_MODEL = /^[a-z0-9][a-z0-9_-]*\/\S{1,190}$/;
// A model of the ChatGPT subscription: LiteLLM's provider chatgpt, e.g. chatgpt/gpt-5.4.
const SUBSCRIPTION_MODEL = /^chatgpt\/\S{1,190}$/;

const PRICES_MISSING = 'Укажите все цены в рублях — без них расход посчитается неверно.';
const RECOGNITION_CONTEXT = 'У модели распознавания речи нет размера контекста — оставьте поле пустым.';
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
  // Moving a model to another provider address sends its stored keys there: the superadmin only.
  update(actor: { userId: string; isSuperadmin: boolean }, modelId: string, change: ModelUpdate): Promise<ModelDto>;
  remove(actorUserId: string, modelId: string): Promise<void>;
  addKey(actorUserId: string, modelId: string, key: string): Promise<ModelKeyDto>;
  removeKey(actorUserId: string, modelId: string, keyId: string): Promise<void>;
  updateSettings(actorUserId: string, input: ModelSettings): Promise<ModelSettings>;
  // The full copy into LiteLLM, at the start of the server; models without a limit of an answer or a size of the
  // context get them from the gateway's model map first (sections 8.19, 8.34), an empty «Основная модель» — a model
  // that can answer.
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

// The provider's address of a model on a key; empty — the provider's standard address. Only http(s):
// LiteLLM sends the keys there.
const API_BASE_PROTOCOLS = new Set(['http:', 'https:']);
function cleanApiBase(value: string | null): string | null {
  const apiBase = value?.trim() || null;
  if (apiBase !== null && !(URL.canParse(apiBase) && API_BASE_PROTOCOLS.has(new URL(apiBase).protocol))) throw invalid(`api base "${apiBase}"`, 'Адрес провайдера — ссылка вида https://…');
  return apiBase;
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

function hideKey(text: string, key: string): string {
  return text.split(key).join(`…${key.slice(-KEY_TAIL)}`);
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

  // The probe of a new model carries what every request of it carries (answerParams, section 8.19): a model
  // the provider would refuse on every message is not saved (#7). The limit of a model does not change
  // after it is added, so a second key and a new address are checked by LiteLLM's short probe — a refused
  // limit there would leave the admin nothing to do but remove the model.
  async function checkKey(m: Pick<SyncModel, 'providerModel' | 'apiBase' | 'kind' | 'maxOutputTokens'>, key: string, checkLimit: boolean): Promise<void> {
    const limit = checkLimit && m.kind === 'chat' && m.maxOutputTokens !== null ? m.maxOutputTokens : undefined;
    const params = { model: m.providerModel, api_key: key, ...(m.apiBase ? { api_base: m.apiBase } : {}), ...answerParams({ ...m, maxOutputTokens: limit ?? null }) };
    const res = await client.checkConnection(params, m.kind === 'transcription' ? 'audio_transcription' : 'chat', limit);
    if (res.ok) return;
    const failure = checkFailure(hideKey(res.error, key), m.providerModel, limit);
    logEvent('warn', 'model_check_failed', { providerModel: m.providerModel, keyLast4: key.slice(-KEY_TAIL), code: failure.code, error: failure.message });
    throw failure;
  }

  // The gateway's model map is about 3 MB: one request serves all that one change or one start needs of it.
  function mapOnce(): () => Promise<Record<string, unknown>> {
    let map: Promise<Record<string, unknown>> | null = null;
    return () => (map ??= client.modelMap());
  }

  // The admin's limit, or the one the gateway knows; none — the admin is asked for it (section 8.19).
  async function outputLimit(input: Extract<ModelCreate, { connection: 'api_key' }>, providerModel: string, map: () => Promise<Record<string, unknown>>): Promise<number | null> {
    if (input.kind === 'transcription') {
      if (input.maxOutputTokens !== null) throw invalid('a recognition model with a limit of an answer', 'У модели распознавания речи нет длины ответа — оставьте поле пустым.');
      return null;
    }
    if (input.maxOutputTokens !== null) return input.maxOutputTokens;
    const known = outputLimitIn(await map(), providerModel);
    if (known === null) throw appError('APP_MODEL_OUTPUT_LIMIT_REQUIRED', `the gateway does not know the limit of an answer of ${providerModel}`);
    return known;
  }

  // The size of the context (section 8.34): the admin's number, else the one the gateway knows, else none — then the
  // chat shows no indicator (decision of the owner 25.11: the admin is never made to give it). Being optional, it does
  // not stop a change when the map does not answer: it stays empty and the next start looks for it again.
  async function contextSize(kind: ModelKind, providerModel: string, given: number | null | undefined, map: () => Promise<Record<string, unknown>>): Promise<number | null> {
    const own = given ?? null;
    if (kind === 'transcription') {
      if (own !== null) throw invalid('a recognition model with a size of the context', RECOGNITION_CONTEXT);
      return null;
    }
    if (own !== null) return own;
    try {
      return inputLimitIn(await map(), providerModel);
    } catch (error) {
      logEvent('warn', 'model_context_size_unavailable', { providerModel, code: isAppError(error) ? error.code : 'APP_MODEL_GATEWAY_UNAVAILABLE', error });
      return null;
    }
  }

  // Chat models without a size of the context — added before 25.11.2026, or when the map did not answer — get the
  // size the gateway knows; a model it does not know stays without one.
  async function fillContextSizes(map: () => Promise<Record<string, unknown>>): Promise<void> {
    const { rows: missing } = await db.query<{ id: string; provider_model: string }>("SELECT id, provider_model FROM app.models WHERE kind = 'chat' AND max_input_tokens IS NULL");
    if (missing.length === 0) return;
    let known: Record<string, unknown>;
    try {
      known = await map();
    } catch (error) {
      logEvent('error', 'model_context_sizes_unavailable', { code: isAppError(error) ? error.code : 'APP_MODEL_GATEWAY_UNAVAILABLE', modelIds: missing.map((m) => m.id), error });
      return;
    }
    for (const m of missing) {
      const size = inputLimitIn(known, m.provider_model);
      if (size === null) continue;
      await db.query('UPDATE app.models SET max_input_tokens = $2, updated_at = now() WHERE id = $1 AND max_input_tokens IS NULL', [m.id, size]);
      logEvent('info', 'model_context_size_filled', { modelId: m.id, providerModel: m.provider_model, maxInputTokens: size });
    }
  }

  // Models added before 15.11.2026 have no limit: the gateway's model map gives what it knows.
  async function fillOutputLimits(mapOf: () => Promise<Record<string, unknown>>): Promise<void> {
    const missing = (await syncState()).models.filter((m) => m.connection === 'api_key' && m.kind === 'chat' && m.maxOutputTokens === null);
    if (missing.length === 0) return;
    let map: Record<string, unknown>;
    try {
      map = await mapOf();
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
      maxInputTokens: r.max_input_tokens,
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
    const apiBase = cleanApiBase(input.apiBase);
    const { prices, perMinute } = checkPrices(input.kind, input.prices, input.pricePerMinute);
    const key = cleanKey(input.key);
    // Before the provider is called: a model without a known limit waits for the admin's number.
    const map = mapOnce();
    const maxOutputTokens = await outputLimit(input, providerModel, map);
    const maxInputTokens = await contextSize(input.kind, providerModel, input.maxInputTokens, map);
    const model: SyncModel = { id: newId('m'), kind: input.kind, connection: 'api_key', providerModel, apiBase, enabled: true, prices, pricePerMinute: perMinute, maxOutputTokens };
    await checkKey(model, key, true);
    const keyId = newId('k');
    const state = await syncState();
    await apply({ ...state, models: [...state.models, model], keys: [...state.keys, { id: keyId, modelId: model.id, secret: key }] });
    const sealed = box.seal(key);
    const vision = input.kind === 'chat' && input.vision;
    await inTransaction(db, async (c) => {
      await c.query(
        `INSERT INTO app.models (id, kind, label, connection, provider_model, api_base, vision, price_input, price_output, price_cache_read,
                                 price_cache_write, price_reasoning, price_image, price_per_minute, max_output_tokens, max_input_tokens, created_by)
         VALUES ($1, $2, $3, 'api_key', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [model.id, model.kind, label, providerModel, apiBase, vision, prices?.input ?? null, prices?.output ?? null, prices?.cacheRead ?? null, prices?.cacheWrite ?? null, prices?.reasoning ?? null, prices?.image ?? null, perMinute, maxOutputTokens, maxInputTokens, actorUserId],
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
      await writeAudit(c, { actorUserId, action: 'model.create', target: model.id, details: { label, kind: model.kind, providerModel, maxOutputTokens, maxInputTokens, keyLast4: key.slice(-KEY_TAIL) } });
      await fillPrimaryModel(c, actorUserId);
    });
    return dtoOf(model.id);
  }

  // A subscription model: no key and no prices; LiteLLM gets one deployment per active account.
  async function createSubscription(actorUserId: string, input: Extract<ModelCreate, { connection: 'chatgpt' }>): Promise<ModelDto> {
    const label = cleanLabel(input.label);
    const providerModel = input.providerModel.trim();
    if (!SUBSCRIPTION_MODEL.test(providerModel)) throw invalid(`subscription model "${providerModel}"`, 'Модель подписки пишется как chatgpt/ и название модели, например chatgpt/gpt-5.4.');
    const model: SyncModel = { id: newId('m'), kind: 'chat', connection: 'chatgpt', providerModel, apiBase: null, enabled: true, prices: null, pricePerMinute: null, maxOutputTokens: null };
    const maxInputTokens = await contextSize('chat', providerModel, input.maxInputTokens, mapOnce());
    const state = await syncState();
    await apply({ ...state, models: [...state.models, model] });
    await inTransaction(db, async (c) => {
      await c.query(`INSERT INTO app.models (id, kind, label, connection, provider_model, vision, max_input_tokens, created_by) VALUES ($1, 'chat', $2, 'chatgpt', $3, $4, $5, $6)`, [
        model.id,
        label,
        providerModel,
        input.vision,
        maxInputTokens,
        actorUserId,
      ]);
      await writeAudit(c, { actorUserId, action: 'model.create', target: model.id, details: { label, kind: 'chat', providerModel, connection: 'chatgpt', maxInputTokens } });
      await fillPrimaryModel(c, actorUserId);
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

    update: ({ userId: actorUserId, isSuperadmin }, modelId, change) =>
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
        let apiBase = row.api_base;
        if (change.apiBase !== undefined) {
          if (row.connection !== 'api_key') throw invalid(`model ${modelId} is a subscription`, 'У модели подписки нет адреса провайдера: её запросы идут через аккаунты ChatGPT.');
          apiBase = cleanApiBase(change.apiBase);
        }
        const moved = apiBase !== row.api_base;
        // Ours only: the gateway does not use it (section 8.34).
        const maxInputTokens = change.maxInputTokens === undefined ? row.max_input_tokens : await contextSize(row.kind, row.provider_model, change.maxInputTokens, mapOnce());
        // The keys of a model are never shown to anyone; a new address would receive them all.
        if (moved && !isSuperadmin) {
          throw appError('APP_ADMIN_FORBIDDEN', `model ${modelId}: only a superadmin moves a model to another address`, {
            userMessage: 'Адрес провайдера меняет только суперадминистратор: на новый адрес уходят ключи модели.',
          });
        }
        // The label and «Видит картинки» are ours only; LiteLLM learns of switching, prices and the address.
        if (pricesChanged || enabled !== row.enabled || moved) {
          const state = await syncState();
          // Every key of the model must work at the new address before LiteLLM goes there: a wrong
          // address would otherwise break the model for everyone at the next answer.
          if (moved) for (const k of state.keys.filter((key) => key.modelId === modelId)) await checkKey({ providerModel: row.provider_model, apiBase, kind: row.kind, maxOutputTokens: row.max_output_tokens }, k.secret, false);
          await apply({ ...state, models: state.models.map((m) => (m.id === modelId ? { ...m, enabled, prices, pricePerMinute: perMinute, apiBase } : m)) });
        }
        await inTransaction(db, async (c) => {
          await c.query(
            `UPDATE app.models SET label = $2, vision = $3, enabled = $4, price_input = $5, price_output = $6, price_cache_read = $7, price_cache_write = $8,
                    price_reasoning = $9, price_image = $10, price_per_minute = $11, api_base = $12, max_input_tokens = $13, updated_at = now() WHERE id = $1`,
            [modelId, label, vision, enabled, prices?.input ?? null, prices?.output ?? null, prices?.cacheRead ?? null, prices?.cacheWrite ?? null, prices?.reasoning ?? null, prices?.image ?? null, perMinute, apiBase, maxInputTokens],
          );
          await writeAudit(c, { actorUserId, action: 'model.update', target: modelId, details: { ...change, ...(change.apiBase !== undefined ? { apiBase } : {}), ...(change.maxInputTokens !== undefined ? { maxInputTokens } : {}) } });
          await fillPrimaryModel(c, actorUserId);
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
          await fillPrimaryModel(c, actorUserId);
        });
      }),

    addKey: (actorUserId, modelId, rawKey) =>
      serial(async () => {
        const row = await modelRow(modelId);
        if (row.connection !== 'api_key') throw invalid(`model ${modelId} is a subscription`, 'Модель подписки работает через аккаунты ChatGPT, ключ ей не нужен.');
        const key = cleanKey(rawKey);
        await checkKey({ providerModel: row.provider_model, apiBase: row.api_base, kind: row.kind, maxOutputTokens: row.max_output_tokens }, key, false);
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
          await fillPrimaryModel(c, actorUserId);
        });
        // «Не выбрана» does not stay while a model can answer: the saved choice may differ from the input.
        const saved = await settingsRow();
        return { primaryModelId: saved.primary_model_id, fallbackModelId: saved.fallback_model_id, transcriptionModelId: saved.transcription_model_id, agentsChooseModel: saved.agents_choose_model };
      }),

    sync: () =>
      serial(async () => {
        const map = mapOnce();
        await fillOutputLimits(map);
        await fillContextSizes(map);
        await fillPrimaryModel(db, null);
        return apply(await syncState());
      }),
  };
}
