// «Основная модель» fills itself (owner's decision 25.11): while no model answers as the primary, a
// model that can — the fallback first, then the earliest added — takes its place at any change of the
// catalog, of «Параметры» or of the ChatGPT accounts. A fresh installation without models, so the
// order of models is the test's own.
import type { ChatGptLoginDto, ChatGptLoginStatus, ModelDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { startFakeChatGpt, type FakeChatGpt } from './fake-chatgpt.ts';
import { startFakeModel, type FakeModel } from './fake-openai.ts';

const GOOD_KEY = 'sk-test-good-key-7d41';
// Given, so a model is added without the gateway's model map.
const MAX_OUTPUT = 4096;
const PRICES = { input: 35, output: 140, cacheRead: 9, cacheWrite: 35, reasoning: 140, image: 35 };

let t: TestApp;
let provider: FakeModel;
let openai: FakeChatGpt;
let igor: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function create(patch: Record<string, unknown>): Promise<ModelDto> {
  const body = { kind: 'chat', connection: 'api_key', providerModel: 'openai/gpt-4.1-mini', apiBase: provider.dockerUrl, vision: true, prices: PRICES, pricePerMinute: null, key: GOOD_KEY, maxOutputTokens: MAX_OUTPUT, ...patch };
  const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<ModelDto>(res);
}

async function change(modelId: string, body: Record<string, unknown>): Promise<void> {
  const res = await t.call('PUT', `/app/api/admin/models/${modelId}`, { cookie: igor, body });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function createSubscription(): Promise<ModelDto> {
  const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: { connection: 'chatgpt', kind: 'chat', label: 'GPT по подписке', providerModel: 'chatgpt/gpt-5.4', vision: true } });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<ModelDto>(res);
}

async function connectAccount(email: string): Promise<void> {
  const login = await json<ChatGptLoginDto>(await t.call('POST', '/app/api/admin/chatgpt/logins', { cookie: igor, body: { accountId: null } }));
  openai.approve(login.userCode, { email });
  const status = await json<ChatGptLoginStatus>(await t.call('GET', `/app/api/admin/chatgpt/logins/${login.id}`, { cookie: igor }));
  expect(status.status).toBe('connected');
}

const saveSettings = (body: { primaryModelId: string | null; fallbackModelId: string | null }) =>
  t.call('PUT', '/app/api/admin/models/settings', { cookie: igor, body: { transcriptionModelId: null, agentsChooseModel: false, ...body } });

async function autoAudit(): Promise<{ target: string; wasFallback: boolean }[]> {
  const { rows } = await t.db.query<{ target: string; wasFallback: boolean }>(
    "SELECT target, (details->>'wasFallback')::boolean AS \"wasFallback\" FROM app.admin_audit WHERE action = 'model.primary.auto' ORDER BY id",
  );
  return rows;
}

async function settings(): Promise<{ primary: string | null; fallback: string | null }> {
  const { rows } = await t.db.query<{ primary: string | null; fallback: string | null }>('SELECT primary_model_id AS primary, fallback_model_id AS fallback FROM app.model_settings');
  return rows[0]!;
}

beforeAll(async () => {
  provider = await startFakeModel({ host: '0.0.0.0', acceptKey: GOOD_KEY });
  openai = await startFakeChatGpt();
  t = await createTestApp({ noModels: true, chatgpt: { authBase: openai.url } });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
  await provider.close();
  await openai.close();
});

describe('«Основная модель» fills itself', () => {
  it('takes a model that can answer: the fallback first, then the earliest added; keeps a working primary', async () => {
    expect(await settings()).toEqual({ primary: null, fallback: null });

    // A model that does not see images is never the primary (section 8.1), nor is recognition.
    const blind = await create({ label: 'Без картинок', vision: false });
    await create({ kind: 'transcription', label: 'Распознавание', providerModel: 'openai/whisper-1', vision: false, prices: null, pricePerMinute: 0.6, maxOutputTokens: null });
    expect((await settings()).primary).toBeNull();

    const first = await create({ label: 'Первая' });
    expect(await settings()).toEqual({ primary: first.id, fallback: null });
    expect(await autoAudit()).toEqual([{ target: first.id, wasFallback: false }]);

    // A working primary stays as it is.
    const second = await create({ label: 'Вторая' });
    const third = await create({ label: 'Третья' });
    expect((await settings()).primary).toBe(first.id);

    // The primary switched off: the admin's fallback takes its place before an earlier model and stops being the fallback.
    expect((await saveSettings({ primaryModelId: first.id, fallbackModelId: third.id })).status).toBe(200);
    await change(first.id, { enabled: false });
    expect(await settings()).toEqual({ primary: third.id, fallback: null });
    expect((await autoAudit()).at(-1)).toEqual({ target: third.id, wasFallback: true });
    await change(first.id, { enabled: true });
    expect((await settings()).primary).toBe(third.id);

    // «Не выбрана» does not stay while a model can answer: the earliest working one comes back at once.
    const emptied = await saveSettings({ primaryModelId: null, fallbackModelId: null });
    expect(emptied.status).toBe(200);
    expect(await json<{ primaryModelId: string | null }>(emptied)).toMatchObject({ primaryModelId: first.id });
    expect((await settings()).primary).toBe(first.id);

    // The primary removed: the earliest working model takes its place.
    expect((await t.call('DELETE', `/app/api/admin/models/${first.id}`, { cookie: igor })).status).toBe(200);
    expect((await settings()).primary).toBe(second.id);

    // The last working model gone: the field is empty until a model can answer again.
    expect((await t.call('DELETE', `/app/api/admin/models/${third.id}`, { cookie: igor })).status).toBe(200);
    await change(second.id, { enabled: false });
    expect((await settings()).primary).toBe(second.id);
    expect((await t.call('DELETE', `/app/api/admin/models/${second.id}`, { cookie: igor })).status).toBe(200);
    expect((await settings()).primary).toBeNull();

    // A subscription model answers only through a connected account: before one it is not the primary.
    const subscription = await createSubscription();
    expect((await settings()).primary).toBeNull();
    await connectAccount('sales.gpt@example.com');
    expect((await settings()).primary).toBe(subscription.id);

    // «Видит картинки» turned on makes a model a candidate too.
    await change(subscription.id, { enabled: false });
    await change(blind.id, { vision: true });
    expect((await settings()).primary).toBe(blind.id);
  });
});
