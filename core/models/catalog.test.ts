// «Нейросеть» end to end: the admin's routes, our database and the test LiteLLM, which checks keys
// against a fake provider it reaches through host.docker.internal (deploy/compose.dev.yaml).
import type { ModelDto, ModelsResponse } from '@bba/contracts';
import { Agent } from '@mastra/core/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { createTestApp, TEST_ENCRYPTION_KEYS, type TestApp } from '../server/test-app.ts';
import { createModelCatalog } from './catalog.ts';
import { GATEWAY_TIMEOUTS } from './gateway-sync.ts';
import { createGatewayWriter } from './gateway-writer.ts';
import { TEST_MODEL_IDS } from './test-catalog.ts';
import { startFakeModel, type FakeModel } from './fake-openai.ts';
import { createLiteLLMClient, gatewayUnavailable, type LiteLLMClient } from './litellm-client.ts';

const GOOD_KEY = 'sk-test-good-key-7d41';
const PRICES = { input: 35, output: 140, cacheRead: 9, cacheWrite: 35, reasoning: 140, image: 35 };

let t: TestApp;
let provider: FakeModel;
let igor: string;
let igorId: string;
let olga: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorCode = async (res: Response) => (await json<{ error: { code: string; message: string } }>(res)).error;

function newModel(patch: Record<string, unknown> = {}) {
  return { kind: 'chat', label: 'GPT 4.1 mini', connection: 'api_key', providerModel: 'openai/gpt-4.1-mini', apiBase: provider.dockerUrl, vision: true, prices: PRICES, pricePerMinute: null, key: GOOD_KEY, maxOutputTokens: null, ...patch };
}

async function create(patch: Record<string, unknown> = {}): Promise<ModelDto> {
  const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel(patch) });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<ModelDto>(res);
}

// Deployments of this test installation in the shared test LiteLLM.
async function deployments(): Promise<Map<string, Record<string, unknown>>> {
  const all = await t.litellm.listDeployments();
  return new Map(all.filter((d) => d.inDatabase && d.info.bba_owner === t.gatewayOwner).map((d) => [d.id, d.info]));
}

beforeAll(async () => {
  provider = await startFakeModel({ host: '0.0.0.0', acceptKey: GOOD_KEY });
  t = await createTestApp();
  igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
  await provider.close();
});

describe('models of «Нейросеть»', () => {
  it('adds a model once the provider took the key; the key never comes back, only its last 4 characters', async () => {
    const model = await create();
    expect(model).toMatchObject({ kind: 'chat', label: 'GPT 4.1 mini', connection: 'api_key', vision: true, enabled: true, prices: PRICES, agentIds: [] });
    expect(model.keys).toEqual([{ id: expect.stringMatching(/^k-[0-9a-f]{8}$/), last4: '7d41', createdAt: expect.any(String) }]);

    const listed = await (await t.call('GET', '/app/api/admin/models', { cookie: igor })).text();
    expect(listed).not.toContain(GOOD_KEY);
    const stored = await t.db.query<{ c: Buffer }>('SELECT key_ciphertext AS c FROM app.model_provider_keys WHERE model_id = $1', [model.id]);
    expect(stored.rows[0]!.c.toString('latin1')).not.toContain(GOOD_KEY);
    const audit = await t.db.query<{ details: unknown }>("SELECT details FROM app.admin_audit WHERE action = 'model.create' AND target = $1", [model.id]);
    expect(JSON.stringify(audit.rows)).not.toContain(GOOD_KEY);

    // The model is in LiteLLM and answers an employee through it, on the provider's key.
    expect([...(await deployments()).keys()]).toContain(`${model.id}:${model.keys[0]!.id}`);
    const agent = new Agent({ id: 'sales', name: 'sales', instructions: 'Ты помощник.', model: await t.gateway.modelConfig(model.id, igorId, 'sales') });
    provider.script({ text: 'Ответ через шлюз' });
    expect((await agent.generate('привет')).text).toBe('Ответ через шлюз');
    expect(provider.requests.at(-1)!.headers.authorization).toBe(`Bearer ${GOOD_KEY}`);
  });

  it('refuses a key the provider did not take: APP_MODEL_CHECK_FAILED, nothing saved, nothing in LiteLLM', async () => {
    const before = (await deployments()).size;
    const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel({ label: 'С чужим ключом', key: 'sk-wrong-key-0000' }) });
    expect(res.status).toBe(400);
    const error = await errorCode(res);
    expect(error.code).toBe('APP_MODEL_CHECK_FAILED');
    expect(error.message).toBe('Провайдер не принял ключ. Проверьте ключ и модель провайдера.');
    const list = await json<ModelsResponse>(await t.call('GET', '/app/api/admin/models', { cookie: igor }));
    expect(list.models.map((m) => m.label)).not.toContain('С чужим ключом');
    expect((await deployments()).size).toBe(before);
  });

  it('says the provider did not answer when it cannot be reached', async () => {
    const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel({ apiBase: 'http://host.docker.internal:9/v1' }) });
    expect(await errorCode(res)).toMatchObject({ code: 'APP_MODEL_CHECK_FAILED', message: 'Провайдер не ответил. Попробуйте ещё раз.' });
  });

  it('refuses incomplete prices before calling the provider; recognition may be priced per minute', async () => {
    const partial = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel({ prices: { ...PRICES, image: null } }) });
    expect(await errorCode(partial)).toMatchObject({ code: 'APP_VALIDATION_FAILED', message: 'Укажите все цены в рублях — без них расход посчитается неверно.' });
    const perMinuteChat = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel({ prices: null, pricePerMinute: 1.2 }) });
    expect((await errorCode(perMinuteChat)).code).toBe('APP_VALIDATION_FAILED');
    const noProvider = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel({ providerModel: 'gpt-4.1-mini' }) });
    expect((await errorCode(noProvider)).code).toBe('APP_VALIDATION_FAILED');

    const whisper = await create({ kind: 'transcription', label: 'Whisper', providerModel: 'openai/whisper-1', vision: true, prices: null, pricePerMinute: 0.6 });
    expect(whisper).toMatchObject({ kind: 'transcription', vision: false, prices: null, pricePerMinute: 0.6 });
    expect([...(await deployments()).values()].find((i) => i.mode === 'audio_transcription')).toBeDefined();
  });

  it('copies every change into LiteLLM: prices, switching off and on, keys added and removed', async () => {
    const model = await create({ label: 'Для правок' });
    const first = `${model.id}:${model.keys[0]!.id}`;
    const fingerprint = (await deployments()).get(first)!.bba_fingerprint;

    await t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: igor, body: { prices: { ...PRICES, output: 160 } } });
    expect((await deployments()).get(first)!.bba_fingerprint).not.toBe(fingerprint);

    await t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: igor, body: { enabled: false } });
    expect((await deployments()).has(first)).toBe(false);
    await t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: igor, body: { enabled: true } });
    expect((await deployments()).has(first)).toBe(true);

    const added = await json<{ id: string; last4: string }>(await t.call('POST', `/app/api/admin/models/${model.id}/keys`, { cookie: igor, body: { key: GOOD_KEY } }));
    expect(added.last4).toBe('7d41');
    expect((await deployments()).has(`${model.id}:${added.id}`)).toBe(true);
    const wrong = await t.call('POST', `/app/api/admin/models/${model.id}/keys`, { cookie: igor, body: { key: 'sk-wrong-key-1111' } });
    expect((await errorCode(wrong)).code).toBe('APP_MODEL_CHECK_FAILED');

    expect((await t.call('DELETE', `/app/api/admin/models/${model.id}/keys/${model.keys[0]!.id}`, { cookie: igor })).status).toBe(200);
    expect((await deployments()).has(first)).toBe(false);
    const last = await t.call('DELETE', `/app/api/admin/models/${model.id}/keys/${added.id}`, { cookie: igor });
    expect((await errorCode(last)).code).toBe('APP_VALIDATION_FAILED');

    expect((await t.call('DELETE', `/app/api/admin/models/${model.id}`, { cookie: igor })).status).toBe(200);
    expect([...(await deployments()).keys()].some((id) => id.startsWith(`${model.id}:`))).toBe(false);
  });

  it('moves a model to another provider address once its keys work there; a bad address changes nothing', async () => {
    const other = await startFakeModel({ host: '0.0.0.0', acceptKey: GOOD_KEY });
    let created: ModelDto | null = null;
    try {
      const model = (created = await create({ label: 'Переезд' }));
      const deployment = `${model.id}:${model.keys[0]!.id}`;
      const fingerprint = (await deployments()).get(deployment)!.bba_fingerprint;
      const put = (body: Record<string, unknown>) => t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: igor, body });

      for (const apiBase of ['http://host.docker.internal:9/v1', 'не адрес']) {
        const refused = await put({ apiBase });
        expect((await errorCode(refused)).code).toBe(apiBase === 'не адрес' ? 'APP_VALIDATION_FAILED' : 'APP_MODEL_CHECK_FAILED');
        expect((await deployments()).get(deployment)!.bba_fingerprint).toBe(fingerprint);
      }
      const listed = async () => (await json<ModelsResponse>(await t.call('GET', '/app/api/admin/models', { cookie: igor }))).models.find((m) => m.id === model.id)!;
      expect((await listed()).apiBase).toBe(provider.dockerUrl);

      const moved = await put({ apiBase: `  ${other.dockerUrl} ` });
      expect(moved.status, await moved.clone().text()).toBe(200);
      expect((await json<ModelDto>(moved)).apiBase).toBe(other.dockerUrl);
      expect((await listed()).apiBase).toBe(other.dockerUrl);
      expect((await deployments()).get(deployment)!.bba_fingerprint).not.toBe(fingerprint);
      const audit = await t.db.query<{ details: { apiBase?: string } }>("SELECT details FROM app.admin_audit WHERE action = 'model.update' AND target = $1", [model.id]);
      expect(audit.rows.at(-1)!.details.apiBase).toBe(other.dockerUrl);

      // The employee's request now goes to the new address.
      const agent = new Agent({ id: 'sales', name: 'sales', instructions: 'Ты помощник.', model: await t.gateway.modelConfig(model.id, igorId, 'sales') });
      other.script({ text: 'Ответ с нового адреса' });
      expect((await agent.generate('привет')).text).toBe('Ответ с нового адреса');
    } finally {
      // The shared test LiteLLM must not keep a deployment at the port of a stopped provider: another
      // test file may start its own provider on that port.
      if (created) await t.call('DELETE', `/app/api/admin/models/${created.id}`, { cookie: igor });
      await other.close();
    }
  });

  it('lets only the superadmin move a model: the keys go to the new address; any address is http(s)', async () => {
    const other = await startFakeModel({ host: '0.0.0.0', acceptKey: GOOD_KEY });
    try {
      const role = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Модели', '["models"]') RETURNING id`)).rows[0]!.id;
      await t.createUser({ email: 'models.admin@example.com', roleIds: [role] });
      const admin = await t.signIn('models.admin@example.com');
      const model = await create({ label: 'Не переезжает' });
      const refused = await t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: admin, body: { apiBase: other.dockerUrl } });
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toMatchObject({ code: 'APP_ADMIN_FORBIDDEN', message: 'Адрес провайдера меняет только суперадминистратор: на новый адрес уходят ключи модели.' });
      // Not one key went to the address the person chose.
      expect(other.requests).toHaveLength(0);
      // The same address again is no move: the rest of the form saves.
      const same = await t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: admin, body: { label: 'Не переезжает, но названа', apiBase: provider.dockerUrl } });
      expect(same.status, await same.clone().text()).toBe(200);

      for (const apiBase of ['file:///etc/passwd', 'ftp://example.com/v1']) {
        const bad = await t.call('PUT', `/app/api/admin/models/${model.id}`, { cookie: igor, body: { apiBase } });
        expect(await errorCode(bad)).toMatchObject({ code: 'APP_VALIDATION_FAILED', message: 'Адрес провайдера — ссылка вида https://…' });
      }
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('a subscription model has no provider address to change', async () => {
    const res = await t.call('PUT', '/app/api/admin/models/test-sub', { cookie: igor, body: { apiBase: provider.dockerUrl } });
    expect((await errorCode(res)).code).toBe('APP_VALIDATION_FAILED');
  });

  it('brings LiteLLM to our catalog at start: adds what is missing, removes its own extras, leaves others alone', async () => {
    const model = await create({ label: 'Сверка' });
    const id = `${model.id}:${model.keys[0]!.id}`;
    await t.litellm.deleteDeployment(id);
    const stray = { id: 'm-00000000:k-00000000', modelName: 'm-00000000', params: { model: 'openai/x', api_key: 'sk-x', api_base: 'http://127.0.0.1:9/v1' }, info: { bba_owner: t.gatewayOwner, bba_fingerprint: 'x' } };
    const foreign = { ...stray, id: 'm-11111111:k-11111111', modelName: 'm-11111111', info: { bba_owner: 'someone-else', bba_fingerprint: 'x' } };
    await t.litellm.addDeployment(stray);
    await t.litellm.addDeployment(foreign);
    try {
      const result = await t.models.sync();
      expect(result.added).toContain(id);
      expect(result.removed).toEqual(['m-00000000:k-00000000']);
      expect((await t.litellm.listDeployments()).some((d) => d.id === foreign.id)).toBe(true);
    } finally {
      await t.litellm.deleteDeployment(foreign.id);
    }
  });

  it('keeps a model chosen by agents while agents choose models: APP_MODEL_IN_USE names them', async () => {
    const model = await create({ label: 'Модель продаж' });
    const settings = { primaryModelId: 'test-paid', fallbackModelId: null, transcriptionModelId: null, agentsChooseModel: true };
    expect((await t.call('PUT', '/app/api/admin/models/settings', { cookie: igor, body: settings })).status).toBe(200);
    expect((await t.call('PUT', '/app/api/admin/agents/sales/model', { cookie: igor, body: { modelId: model.id } })).status).toBe(200);
    const listed = await json<ModelsResponse>(await t.call('GET', '/app/api/admin/models', { cookie: igor }));
    expect(listed.models.find((m) => m.id === model.id)?.agentIds).toEqual(['sales']);

    const refused = await t.call('DELETE', `/app/api/admin/models/${model.id}`, { cookie: igor });
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toMatchObject({ code: 'APP_MODEL_IN_USE', message: expect.stringContaining('Модель нужна агентам: Продажи.') });

    // With the choice off the agents do not use it: it goes, and so does the agent's reference.
    await t.call('PUT', '/app/api/admin/models/settings', { cookie: igor, body: { ...settings, agentsChooseModel: false } });
    expect((await t.call('DELETE', `/app/api/admin/models/${model.id}`, { cookie: igor })).status).toBe(200);
    expect((await t.db.query("SELECT model_id FROM app.agent_overrides WHERE agent_id = 'sales'")).rows[0]).toEqual({ model_id: null });
  });

  it('checks the organisation’s choice: primary and fallback see images and differ, recognition is a recognition model', async () => {
    const blind = await create({ label: 'Без картинок', vision: false });
    const whisper = await create({ kind: 'transcription', label: 'Распознавание', providerModel: 'openai/whisper-1', prices: null, pricePerMinute: 0.6 });
    const put = (body: Record<string, unknown>) =>
      t.call('PUT', '/app/api/admin/models/settings', { cookie: igor, body: { primaryModelId: 'test-paid', fallbackModelId: null, transcriptionModelId: null, agentsChooseModel: false, ...body } });

    expect(await errorCode(await put({ primaryModelId: blind.id }))).toMatchObject({ code: 'APP_VALIDATION_FAILED', message: expect.stringContaining('не видит картинки') });
    expect(await errorCode(await put({ fallbackModelId: 'test-paid' }))).toMatchObject({ message: 'Запасная модель должна отличаться от основной.' });
    expect((await errorCode(await put({ transcriptionModelId: blind.id }))).code).toBe('APP_VALIDATION_FAILED');
    expect((await errorCode(await put({ primaryModelId: whisper.id }))).code).toBe('APP_VALIDATION_FAILED');
    expect((await put({ fallbackModelId: 'test-sub', transcriptionModelId: whisper.id })).status).toBe(200);

    // A model the organisation answers on keeps «Видит картинки».
    const off = await t.call('PUT', '/app/api/admin/models/test-sub', { cookie: igor, body: { vision: false } });
    expect((await errorCode(off)).code).toBe('APP_VALIDATION_FAILED');
    await put({});
  });

  it('the database itself refuses a model on a key with a missing price and a subscription with prices', async () => {
    await expect(
      t.db.query(`INSERT INTO app.models (id, kind, label, connection, provider_model, price_input, price_output, price_cache_read, price_cache_write, price_reasoning)
                  VALUES ('m-badprice', 'chat', 'x', 'api_key', 'openai/x', 1, 1, 1, 1, 1)`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.db.query(`INSERT INTO app.models (id, kind, label, connection, provider_model, price_input) VALUES ('m-badsub', 'chat', 'x', 'chatgpt', 'chatgpt/x', 1)`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is open only to roles with the right «Нейросеть»', async () => {
    expect((await t.call('GET', '/app/api/admin/models', { cookie: olga })).status).toBe(403);
    expect((await t.call('POST', '/app/api/admin/models', { cookie: olga, body: newModel() })).status).toBe(403);
  });

  it('the database itself refuses a limit of an answer that is not positive or belongs to a recognition or subscription model', async () => {
    const chat = await create({ label: 'Для проверки предела' });
    await expect(t.db.query('UPDATE app.models SET max_output_tokens = 0 WHERE id = $1', [chat.id])).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.db.query(`INSERT INTO app.models (id, kind, label, connection, provider_model, vision, max_output_tokens) VALUES ('m-sublimit', 'chat', 'x', 'chatgpt', 'chatgpt/x', true, 1000)`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('shows the catalog from our database when LiteLLM does not answer', async () => {
    const box = createSecretBox(TEST_ENCRYPTION_KEYS);
    const client = createLiteLLMClient('http://127.0.0.1:9', 'sk-x');
    const writer = createGatewayWriter({ db: t.db, box, client, owner: t.gatewayOwner, fileModelIds: TEST_MODEL_IDS, timeouts: GATEWAY_TIMEOUTS });
    const offline = createModelCatalog({ db: t.db, box, client, writer, accounts: t.accounts, agentName: (id) => id });
    const list = await offline.list();
    expect(list.gateway).toMatchObject({ reachable: false, pendingModelIds: [] });
    expect(list.models.length).toBeGreaterThan(0);
  });
});

describe('the length of an answer (spec, section 8.19)', () => {
  async function lastRequestOf(model: ModelDto) {
    const agent = new Agent({ id: 'sales', name: 'sales', instructions: 'Ты помощник.', model: await t.gateway.modelConfig(model.id, igorId, 'sales') });
    provider.script({ text: 'Ответ' });
    await agent.generate('привет');
    return provider.requests.at(-1)!;
  }

  it('takes the limit of a model the gateway knows and sends it to the provider with every request', async () => {
    const model = await create({ label: 'Предел из шлюза' });
    expect(model.maxOutputTokens).toBe(32_768);
    const request = await lastRequestOf(model);
    expect(request.max_tokens).toBe(32_768);
    expect(request.reasoning_format).toBeUndefined();
  });

  it('asks for the limit of a model the gateway does not know before calling the provider, then takes the one given', async () => {
    const before = { deployments: (await deployments()).size, requests: provider.requests.length };
    const unknown = newModel({ label: 'Неизвестная шлюзу', providerModel: 'openai/bba-unknown-model' });
    const refused = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: unknown });
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toMatchObject({
      code: 'APP_MODEL_OUTPUT_LIMIT_REQUIRED',
      message: 'Шлюз не знает, какой длины ответ даёт эта модель. Укажите наибольшую длину ответа в токенах — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).',
    });
    expect(provider.requests.length).toBe(before.requests);
    expect((await deployments()).size).toBe(before.deployments);
    const list = await json<ModelsResponse>(await t.call('GET', '/app/api/admin/models', { cookie: igor }));
    expect(list.models.map((m) => m.label)).not.toContain('Неизвестная шлюзу');

    const notWhole = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: { ...unknown, maxOutputTokens: 0 } });
    expect((await errorCode(notWhole)).code).toBe('APP_VALIDATION_FAILED');

    const model = await create({ label: 'Неизвестная шлюзу', providerModel: 'openai/bba-unknown-model', maxOutputTokens: 16_384 });
    expect(model.maxOutputTokens).toBe(16_384);
    expect((await lastRequestOf(model)).max_tokens).toBe(16_384);
  });

  it('keeps the reasoning of a Groq model out of the text of its answer', async () => {
    const model = await create({ label: 'Qwen на Groq', providerModel: 'groq/qwen/qwen3.6-27b', maxOutputTokens: 16_384 });
    const request = await lastRequestOf(model);
    expect(request.reasoning_format).toBe('parsed');
    expect(request.max_tokens ?? request.max_completion_tokens).toBe(16_384);
  });

  it('gives no limit to recognition and subscription models', async () => {
    const whisper = t.call('POST', '/app/api/admin/models', { cookie: igor, body: newModel({ kind: 'transcription', providerModel: 'openai/whisper-1', prices: null, pricePerMinute: 0.6, maxOutputTokens: 1000 }) });
    expect((await errorCode(await whisper)).code).toBe('APP_VALIDATION_FAILED');
    expect((await create({ kind: 'transcription', label: 'Распознавание без предела', providerModel: 'openai/whisper-1', prices: null, pricePerMinute: 0.6 })).maxOutputTokens).toBeNull();
  });

  it('gives a model added before the limits its limit at start, when the gateway knows it', async () => {
    const known = await create({ label: 'Заведена до пределов' });
    const unknown = await create({ label: 'Неизвестная, до пределов', providerModel: 'openai/bba-unknown-old', maxOutputTokens: 1000 });
    await t.db.query('UPDATE app.models SET max_output_tokens = NULL WHERE id = ANY($1)', [[known.id, unknown.id]]);
    // Their deployments from before 15.11 had no limit either; the start adds them anew, and the
    // known model's comes with the limit only if the limit is found before the gateway is written.
    for (const m of [known, unknown]) await t.litellm.deleteDeployment(`${m.id}:${m.keys[0]!.id}`);
    await t.models.sync();
    const limits = await t.db.query<{ id: string; max_output_tokens: number | null }>('SELECT id, max_output_tokens FROM app.models WHERE id = ANY($1)', [[known.id, unknown.id]]);
    expect(Object.fromEntries(limits.rows.map((r) => [r.id, r.max_output_tokens]))).toEqual({ [known.id]: 32_768, [unknown.id]: null });
    expect((await lastRequestOf(known)).max_tokens).toBe(32_768);
    expect((await lastRequestOf(unknown)).max_tokens).toBeUndefined();
  });

  // A model without a limit works as before 15.11, so a silent model map must not stop the start
  // from bringing the gateway in line with our database.
  it('still brings the gateway in line at start when the gateway’s model map does not answer', async () => {
    const old = await create({ label: 'До пределов, справочник молчит' });
    await t.db.query('UPDATE app.models SET max_output_tokens = NULL WHERE id = $1', [old.id]);
    await t.litellm.deleteDeployment(`${old.id}:${old.keys[0]!.id}`);
    const box = createSecretBox(TEST_ENCRYPTION_KEYS);
    const client: LiteLLMClient = { ...t.litellm, modelMap: () => Promise.reject(gatewayUnavailable('LiteLLM GET /public/litellm_model_cost_map answered nothing')) };
    const writer = createGatewayWriter({ db: t.db, box, client, owner: t.gatewayOwner, fileModelIds: TEST_MODEL_IDS, timeouts: GATEWAY_TIMEOUTS });
    const silentMap = createModelCatalog({ db: t.db, box, client, writer, accounts: t.accounts, agentName: (id) => id });
    await silentMap.sync();
    expect((await lastRequestOf(old)).max_tokens).toBeUndefined();
    const { rows } = await t.db.query<{ max_output_tokens: number | null }>('SELECT max_output_tokens FROM app.models WHERE id = $1', [old.id]);
    expect(rows[0]!.max_output_tokens).toBeNull();
  });
});
