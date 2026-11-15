// Voice input (spec, scenario 8, section 8.14): the recording goes through LiteLLM on the employee's
// key to the recognition model chosen in «Нейросеть»; the test LiteLLM reaches a fake provider.
import type { MeResponse, ModelDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_TRANSCRIPT, silentWav, startFakeModel, type FakeModel } from '../models/fake-openai.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';

const KEY = 'sk-voice-test-key-91ab';
let t: TestApp;
let provider: FakeModel;
let igorId: string;
let olgaId: string;
let olga: string;
let sales: string;
let whisper: ModelDto;

async function speak(cookie: string, opts: { agentId?: string; type?: string; bytes?: Uint8Array } = {}): Promise<Response> {
  const form = new FormData();
  form.append('agentId', opts.agentId ?? 'sales');
  form.append('file', new File([opts.bytes ?? silentWav(3)], 'запись', { type: opts.type ?? 'audio/wav' }));
  return t.app.request('/app/api/voice/transcribe', { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
}

async function addRecognition(apiBase: string, providerModel = 'openai/whisper-1'): Promise<ModelDto> {
  return t.models.create(igorId, { kind: 'transcription', label: 'Распознавание', connection: 'api_key', providerModel, apiBase, vision: false, prices: null, pricePerMinute: 0.6, key: KEY, maxOutputTokens: null });
}

const setRecognition = (modelId: string | null) => t.db.query('UPDATE app.model_settings SET transcription_model_id = $1', [modelId]);
const voiceAvailable = async (cookie: string) => ((await (await t.call('GET', '/app/api/me', { cookie })).json()) as MeResponse).voiceAvailable;

beforeAll(async () => {
  provider = await startFakeModel({ host: '0.0.0.0', acceptKey: KEY });
  t = await createTestApp();
  igorId = await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [sales, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olga = await t.signIn('olga@example.com');
  whisper = await addRecognition(provider.dockerUrl);
});
afterAll(async () => {
  await t.close();
  await provider.close();
});

describe('voice input', () => {
  it('has no microphone until the admin chooses a recognition model', async () => {
    expect(await voiceAvailable(olga)).toBe(false);
    const res = await speak(olga);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_VOICE_NOT_CONFIGURED', message: 'Голосовой ввод в этой установке не настроен.' } });
    await setRecognition(whisper.id);
    expect(await voiceAvailable(olga)).toBe(true);
    await t.db.query('UPDATE app.models SET enabled = false WHERE id = $1', [whisper.id]);
    expect(await voiceAvailable(olga)).toBe(false);
    await t.db.query('UPDATE app.models SET enabled = true WHERE id = $1', [whisper.id]);
  });

  it('turns a recording into text through LiteLLM; the recording is not kept', async () => {
    await setRecognition(whisper.id);
    const before = provider.transcriptions.length;
    const res = await speak(olga);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: FAKE_TRANSCRIPT });
    expect(provider.transcriptions.length).toBe(before + 1);
    expect(provider.transcriptions.at(-1)!.authorization).toBe(`Bearer ${KEY}`);
  });

  it('takes only audio, and only for an agent open to the employee', async () => {
    await setRecognition(whisper.id);
    expect((await speak(olga, { type: 'application/pdf' })).status).toBe(400);
    expect((await speak(olga, { agentId: 'assistant' })).status).toBe(403);
  });

  it('refuses before calling the provider when the employee’s monthly limit is spent', async () => {
    await setRecognition(whisper.id);
    const spent = await t.createUser({ email: 'spent@example.com', departmentIds: [sales] });
    await t.db.query('INSERT INTO app.user_limits (user_id, monthly_rub) VALUES ($1, 1)', [spent]);
    await t.db.query(`INSERT INTO app.usage_events (at, user_id, model, cost_rub, litellm_call_id) VALUES (now(), $1, 'test-paid', 5, 'spent-' || $1)`, [spent]);
    const before = provider.transcriptions.length;
    const res = await speak(await t.signIn('spent@example.com'));
    expect(await res.json()).toMatchObject({ error: { code: 'APP_USAGE_LIMIT_EXCEEDED' } });
    expect(provider.transcriptions.length).toBe(before);
  });

  it('says the recording was not recognised when the provider fails', async () => {
    const broken = await startFakeModel({ host: '0.0.0.0', acceptKey: KEY });
    const model = await addRecognition(broken.dockerUrl);
    await broken.close();
    await setRecognition(model.id);
    const res = await speak(olga);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_VOICE_FAILED', message: 'Не удалось распознать запись. Попробуйте ещё раз или напишите текстом.' } });
    await setRecognition(whisper.id);
  });
});
