// End-to-end through the test LiteLLM (deploy/compose.dev.yaml: litellm-test, mock models).
// This is the only test file that listens on TEST_CALLBACK_PORT for LiteLLM's callbacks, on
// TEST_CHATGPT_PORT as the ChatGPT of the subscription accounts and on TEST_SEARXNG_PORT as the SearXNG of the search.
import { serve, type ServerType } from '@hono/node-server';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { AgentRuntime } from '../loader/registry.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS, MODEL_CALL_MAX_MS } from '../runtime/agent-factory.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { silentWav, startFakeModel } from './fake-openai.ts';
import { createLiteLLMClient } from './litellm-client.ts';
import { createModelGateway } from './gateway.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { startFakeChatGpt, FAKE_SUBSCRIPTION_ANSWER, type FakeChatGpt } from './fake-chatgpt.ts';
import { TEST_CALLBACK_PORT, TEST_CHATGPT_PORT, TEST_SEARXNG_PORT } from './test-catalog.ts';
import { startFakeSearxng, type FakeSearxng } from '../web/fake-searxng.ts';
import { createGatewaySearcher } from '../web/search.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';

const GATEWAY_SILENCE_S = 2;

let t: TestApp;
let server: ServerType;
let openai: FakeChatGpt;
let searxng: FakeSearxng;

beforeAll(async () => {
  openai = await startFakeChatGpt({ port: TEST_CHATGPT_PORT, host: '0.0.0.0' });
  searxng = await startFakeSearxng({ port: TEST_SEARXNG_PORT, host: '0.0.0.0' });
  // A provider that goes silent is cut off by the gateway after GATEWAY_SILENCE_S, not after a minute.
  t = await createTestApp({ chatgpt: { authBase: openai.url, gateway: true }, gatewayTimeouts: { silenceSeconds: GATEWAY_SILENCE_S, requestSeconds: 60 } });
  server = serve({ fetch: t.app.fetch, port: TEST_CALLBACK_PORT, hostname: '0.0.0.0' });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await t.close();
  await openai.close();
  await searxng.close();
});

async function ask(userId: string, model: string, agentId = 'sales'): Promise<string> {
  const agent = new Agent({ id: agentId, name: agentId, instructions: 'Ты помощник.', model: await t.gateway.modelConfig(model, userId, agentId) });
  const result = await agent.generate('привет');
  return result.text;
}

async function askError(userId: string, model: string): Promise<{ code: string; userMessage: string }> {
  try {
    await ask(userId, model);
  } catch (error) {
    return t.gateway.translateError(error, userId);
  }
  throw new Error('expected the model call to fail');
}

async function waitForUsage(userId: string, count: number): Promise<{ model: string; deployment: string; agent_id: string; cost_rub: string; is_subscription: boolean }[]> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await t.db.query<{ model: string; deployment: string; agent_id: string; cost_rub: string; is_subscription: boolean }>(
      'SELECT model, deployment, agent_id, cost_rub, is_subscription FROM app.usage_events WHERE user_id = $1 ORDER BY id',
      [userId],
    );
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`usage for ${userId} did not arrive`);
}

describe('model gateway', () => {
  it('gives each employee one key, stored encrypted, even under parallel first requests', async () => {
    const userId = await t.createUser({ email: 'keys@example.com' });
    const configs = await Promise.all([1, 2, 3].map(() => t.gateway.modelConfig('test-paid', userId, 'sales')));
    expect(new Set(configs.map((c) => c.apiKey)).size).toBe(1);
    const { rows } = await t.db.query<{ c: Buffer }>('SELECT litellm_key_ciphertext AS c FROM app.model_keys WHERE user_id = $1', [userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.c.toString('utf8')).not.toContain(configs[0]!.apiKey);
  });

  it('answers through LiteLLM and records the call in our ledger: employee, agent, model, account, roubles', async () => {
    const userId = await t.createUser({ email: 'olga@example.com' });
    expect(await ask(userId, 'test-paid')).toBe('Ответ платной модели');
    const [row] = await waitForUsage(userId, 1);
    expect(row).toMatchObject({ model: 'test-paid', deployment: 'paid-1', agent_id: 'sales', is_subscription: false });
    expect(Number(row!.cost_rub)).toBeGreaterThan(0);
  });

  it('spreads subscription calls over the pool at zero cost', async () => {
    const userId = await t.createUser({ email: 'sub@example.com' });
    for (let i = 0; i < 4; i++) expect(await ask(userId, 'test-sub')).toBe('Ответ подписки');
    const rows = await waitForUsage(userId, 4);
    expect(rows.every((r) => r.is_subscription && Number(r.cost_rub) === 0)).toBe(true);
    expect(rows.every((r) => ['sub-1', 'sub-2'].includes(r.deployment))).toBe(true);
  });

  // The search of the internet (spec, section 8.30; step 0 V29, V32): the gateway's own search on the employee's
  // key, SearXNG behind it asked in Russian; a free search is not counted, and the batch of the usage still is.
  it('searches through the gateway on the employee’s key and does not count the search in the ledger', async () => {
    const userId = await t.createUser({ email: 'searcher@example.com' });
    searxng.setResults([{ title: 'Профнастил С21 — цена', url: 'https://example.com/c21', content: 'от 520 ₽ за лист' }]);
    const hits = await createGatewaySearcher(t.gateway).search({ query: 'профнастил С21 Екатеринбург', maxResults: 5, userId, agentId: 'sales' });
    expect(hits).toEqual([{ title: 'Профнастил С21 — цена', address: 'https://example.com/c21', snippet: 'от 520 ₽ за лист', date: null }]);
    expect(searxng.queries.at(-1)).toEqual({ q: 'профнастил С21 Екатеринбург', language: 'ru', format: 'json' });
    // A model call after it: its record arrives, the search's does not become a row.
    expect(await ask(userId, 'test-paid')).toBe('Ответ платной модели');
    const rows = await waitForUsage(userId, 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await waitForUsage(userId, 1)).map((r) => r.model)).toEqual(rows.map((r) => r.model));
    expect(rows.map((r) => r.model)).toEqual(['test-paid']);
  });

  it('stops an employee at their monthly limit with the date of the new limit', async () => {
    const userId = await t.createUser({ email: 'limited@example.com' });
    await t.db.query('INSERT INTO app.user_limits (user_id, monthly_rub) VALUES ($1, 0.005)', [userId]);
    await t.gateway.modelConfig('test-paid', userId, 'sales'); // the key is created with the current limit
    await ask(userId, 'test-paid'); // one call costs about 0.009 ₽ and goes over the limit
    await waitForUsage(userId, 1);
    const error = await askError(userId, 'test-paid');
    expect(error.code).toBe('APP_USAGE_LIMIT_EXCEEDED');
    expect(error.userMessage).toMatch(/Новый лимит начнётся \d{1,2} [а-я]+\./);
  });

  it('stops everyone when the organisation limit is spent', async () => {
    const userId = await t.createUser({ email: 'org@example.com' });
    await t.db.query('UPDATE app.limit_settings SET org_monthly_rub = 0.0001');
    await t.gateway.syncOrgBudget();
    try {
      const error = await askError(userId, 'test-paid');
      expect(error.code).toBe('APP_USAGE_ORG_LIMIT_EXCEEDED');
    } finally {
      await t.db.query('UPDATE app.limit_settings SET org_monthly_rub = NULL');
      await t.gateway.syncOrgBudget();
    }
  });

  it('translates provider failures into codes for people', async () => {
    const userId = await t.createUser({ email: 'errors@example.com' });
    expect((await askError(userId, 'test-ratelimited')).code).toBe('APP_MODEL_RATE_LIMITED');
    expect((await askError(userId, 'test-down')).code).toBe('APP_MODEL_UNAVAILABLE');
  });

  it('asks the model again when the provider cut its answer off mid-way, and the answer arrives whole (spec, 9.1)', async () => {
    // As Groq on 15.11: a few words, then the connection closes. LiteLLM cannot repeat a stream that
    // has already sent words and reports the break with its own frame inside the stream.
    const key = 'sk-break-mid-answer-7d21';
    const provider = await startFakeModel({ host: '0.0.0.0', acceptKey: key });
    const userId = await t.createUser({ email: 'break@example.com', roleIds: [await t.roleId('superadmin')] });
    const PRICES = { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0, image: 0 };
    try {
      const model = await t.models.create(userId, { kind: 'chat', label: 'Обрыв', connection: 'api_key', providerModel: 'openai/break-test', apiBase: provider.dockerUrl, vision: false, prices: PRICES, pricePerMinute: null, key, maxOutputTokens: 4096 });
      const before = provider.requests.length;
      provider.script({ text: 'Пр', cut: 'drop' }, { text: 'Привет! Чем помочь?' });
      const rt: AgentRuntime = {
        passport: { id: 'sales', name: 'Продажи', description: 'x', plugins: [], readOnly: [], starters: [] },
        dir: '/x',
        instructions: 'Ты помощник.',
        tools: {},
        readOnly: new Set(),
        subagents: [],
        connectorIds: [],
        toolSystems: {},
      };
      const agent = createMastraAgent(rt, { gateway: t.gateway, firstChunkMs: FALLBACK_FIRST_CHUNK_MS, stepMs: MODEL_CALL_MAX_MS, processorsFor: () => ({ input: [], output: [] }) });
      const rc = new RequestContext();
      rc.set(REQUEST_KEYS.userId, userId);
      rc.set(REQUEST_KEYS.modelId, model.id);
      rc.set(REQUEST_KEYS.skillPaths, '[]');
      rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true}');
      const out = await agent.stream('привет', { requestContext: rc });
      expect(await out.text).toBe('Привет! Чем помочь?');
      expect(provider.requests.length - before).toBe(2);
    } finally {
      await provider.close();
    }
  });

  // As neuraldeep on 15.11: 115 tokens, then nothing for five minutes with the connection open; as
  // Groq the same day (#8): the stream opens and no word comes. The gateway cuts the silence itself and
  // reports it inside the stream; the agent repeats the step.
  it.each([
    ['mid-way', 'Пр'],
    ['before its first word', ''],
  ])('asks the model again when the provider went silent %s without closing the connection (owner, 15.11)', async (_, before) => {
    const key = `sk-silent-${before ? 'mid' : 'start'}-3b90`;
    const provider = await startFakeModel({ host: '0.0.0.0', acceptKey: key });
    const userId = await t.createUser({ email: `silent-${before ? 'mid' : 'start'}@example.com`, roleIds: [await t.roleId('superadmin')] });
    const PRICES = { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0, image: 0 };
    try {
      const model = await t.models.create(userId, { kind: 'chat', label: 'Тишина', connection: 'api_key', providerModel: 'openai/silent-test', apiBase: provider.dockerUrl, vision: false, prices: PRICES, pricePerMinute: null, key, maxOutputTokens: 4096 });
      const sent = provider.requests.length;
      provider.script({ text: before, cut: 'hang' }, { text: 'Привет! Чем помочь?' });
      const rt: AgentRuntime = {
        passport: { id: 'sales', name: 'Продажи', description: 'x', plugins: [], readOnly: [], starters: [] },
        dir: '/x',
        instructions: 'Ты помощник.',
        tools: {},
        readOnly: new Set(),
        subagents: [],
        connectorIds: [],
        toolSystems: {},
      };
      const agent = createMastraAgent(rt, { gateway: t.gateway, firstChunkMs: FALLBACK_FIRST_CHUNK_MS, stepMs: MODEL_CALL_MAX_MS, processorsFor: () => ({ input: [], output: [] }) });
      const rc = new RequestContext();
      rc.set(REQUEST_KEYS.userId, userId);
      rc.set(REQUEST_KEYS.modelId, model.id);
      rc.set(REQUEST_KEYS.skillPaths, '[]');
      rc.set(REQUEST_KEYS.abilities, '{"web":true,"commands":true}');
      const started = Date.now();
      const out = await agent.stream('привет', { requestContext: rc });
      expect(await out.text).toBe('Привет! Чем помочь?');
      expect(provider.requests.length - sent).toBe(2);
      // Cut after the silence, not after the five minutes of one model call.
      expect(Date.now() - started).toBeLessThan(GATEWAY_SILENCE_S * 1000 * 5);
    } finally {
      await provider.close();
    }
  });

  it('recognises a refused provider key in the text of a chat stream error, which has no status', async () => {
    const userId = await t.createUser({ email: 'auth@example.com' });
    // As it reaches the chat in RUN_ERROR: the AI SDK message of LiteLLM's 401, without the response.
    const raw = "AI_APICallError: litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect API key provided: sk-x*****. LiteLLM: model group 'main' failed with the error above.";
    expect((await t.gateway.translateError(new Error(raw), userId)).code).toBe('APP_MODEL_AUTH_FAILED');
  });

  it('says the conversation is too long when the provider asks to shorten the messages', async () => {
    const userId = await t.createUser({ email: 'long@example.com' });
    // Groq's words for a request over the model's window, as they come through LiteLLM.
    const raw = 'AI_APICallError: litellm.BadRequestError: GroqException - {"error":{"message":"Please reduce the length of the messages or completion.","type":"invalid_request_error","param":"messages"}}';
    expect((await t.gateway.translateError(new Error(raw), userId)).code).toBe('APP_MODEL_CONTEXT_EXCEEDED');
  });

  it('reports an unreachable LiteLLM as the gateway being down', async () => {
    const userId = await t.createUser({ email: 'gateway@example.com' });
    const config = await t.gateway.modelConfig('test-paid', userId, 'sales');
    const broken = createModelGateway({
      db: t.db,
      client: createLiteLLMClient('http://127.0.0.1:9', 'sk-x'),
      box: createSecretBox(TEST_ENCRYPTION_KEYS),
      timezone: 'Europe/Moscow',
    });
    const agent = new Agent({ id: 'sales', name: 'sales', instructions: 'x', model: { ...config, url: 'http://127.0.0.1:9/v1' } });
    const error = await agent.generate('привет').then(
      () => null,
      (e: unknown) => broken.translateError(e, userId),
    );
    expect(error?.code).toBe('APP_MODEL_GATEWAY_UNAVAILABLE');
  });

  it('keeps our ledger equal to what LiteLLM charged the employee', async () => {
    const userId = await t.createUser({ email: 'ledger@example.com' });
    for (let i = 0; i < 3; i++) await ask(userId, 'test-paid');
    const rows = await waitForUsage(userId, 3);
    const ours = rows.reduce((s, r) => s + Number(r.cost_rub), 0);
    const key = (await t.gateway.modelConfig('test-paid', userId, 'sales')).apiKey;
    let theirs = 0;
    for (let i = 0; i < 40 && Math.abs(theirs - ours) > 1e-9; i++) {
      theirs = (await t.litellm.keyBalance(key)).spend;
      if (Math.abs(theirs - ours) > 1e-9) await new Promise((r) => setTimeout(r, 500));
    }
    expect(theirs).toBeCloseTo(ours, 8);
  });

  // V16: recognition is counted in roubles whether priced per token (gpt-4o-*-transcribe reports
  // tokens) or per minute (LiteLLM measures the audio itself); a paid call at zero is reported.
  it('records speech recognition in our ledger for both price forms (V16)', async () => {
    const key = 'sk-voice-ledger-key-5e10';
    const provider = await startFakeModel({ host: '0.0.0.0', acceptKey: key });
    const userId = await t.createUser({ email: 'voice@example.com', roleIds: [await t.roleId('superadmin')] });
    const cookie = await t.signIn('voice@example.com');
    const PRICES = { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0, image: 0 };
    const add = (providerModel: string, pricing: { prices: typeof PRICES | null; pricePerMinute: number | null }) =>
      t.models.create(userId, { kind: 'transcription', label: providerModel, connection: 'api_key', providerModel, apiBase: provider.dockerUrl, vision: false, ...pricing, key, maxOutputTokens: null });
    const speak = async (modelId: string) => {
      await t.db.query('UPDATE app.model_settings SET transcription_model_id = $1', [modelId]);
      const form = new FormData();
      form.append('agentId', 'sales');
      form.append('file', new File([silentWav(3)], 'запись', { type: 'audio/wav' }));
      const res = await t.app.request('/app/api/voice/transcribe', { method: 'POST', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } });
      expect(res.status).toBe(200);
    };
    const log = vi.spyOn(console, 'log');
    try {
      const tokens = await add('openai/gpt-4o-mini-transcribe', { prices: PRICES, pricePerMinute: null });
      const minutes = await add('openai/whisper-1', { prices: null, pricePerMinute: 0.6 });
      // Priced per token, but the provider reports no tokens: LiteLLM counts nothing.
      const uncounted = await add('openai/whisper-large', { prices: PRICES, pricePerMinute: null });
      await speak(tokens.id);
      await speak(minutes.id);
      await speak(uncounted.id);
      const rows = await waitForUsage(userId, 3);
      const cost = (id: string) => Number(rows.find((r) => r.model === id)?.cost_rub);
      expect(cost(tokens.id)).toBeCloseTo(0.07, 6); // 50 × 1000/1e6 + 10 × 2000/1e6
      expect(cost(minutes.id)).toBeCloseTo(0.03, 6); // 3 s × 0.6/60
      expect(rows.find((r) => r.model === tokens.id)?.agent_id).toBe('sales');
      expect(cost(uncounted.id)).toBe(0);
      expect(log.mock.calls.some(([line]) => String(line).includes('"usage_cost_missing"') && String(line).includes(uncounted.id))).toBe(true);
    } finally {
      log.mockRestore();
      await t.db.query('UPDATE app.model_settings SET transcription_model_id = NULL');
      await provider.close();
    }
  });

  it('accepts usage records only with the shared secret', async () => {
    const res = await t.app.request('/app/api/internal/usage', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  // V18, V20 and check 23: two accounts serve one subscription model in the standard LiteLLM; each
  // failed attempt comes with its deployment, even when the retry on the other account answered.
  it('serves a subscription model through both accounts and leaves the revoked one (V18, V20)', async () => {
    const adminId = await t.createUser({ email: 'pool-admin@example.com', roleIds: [await t.roleId('superadmin')] });
    const userId = await t.createUser({ email: 'pool-user@example.com' });
    const model = await t.models.create(adminId, { connection: 'chatgpt', kind: 'chat', label: 'GPT по подписке', providerModel: 'chatgpt/gpt-5.4', vision: true });
    const connect = async (email: string) => {
      const login = await t.accounts.startLogin(adminId, null);
      openai.approve(login.userCode, { email });
      const done = await t.accounts.pollLogin(adminId, login.id);
      if (done.status !== 'connected') throw new Error(`login of ${email} is ${done.status}`);
      return done.account.id;
    };
    const first = await connect('pool-first@example.com');
    const second = await connect('pool-second@example.com');
    const stateOf = async (id: string) => (await t.accounts.list()).find((a) => a.id === id)!;

    for (let i = 0; i < 12; i++) expect(await ask(userId, model.id)).toBe(FAKE_SUBSCRIPTION_ANSWER);
    expect(new Set(openai.calls)).toEqual(new Set(['pool-first@example.com', 'pool-second@example.com']));
    const rows = await waitForUsage(userId, 12);
    expect(new Set(rows.map((r) => r.deployment))).toEqual(new Set([`${model.id}:${first}`, `${model.id}:${second}`]));
    expect(rows.every((r) => r.is_subscription && Number(r.cost_rub) === 0)).toBe(true);
    expect((await stateOf(first)).state).toBe('works');

    // The second account's login is revoked: its failed attempt is reported, the retry answers
    // through the first, and the server takes the second out of LiteLLM. Its first 401 is put a
    // minute back, after its last success; the live one confirms it.
    const secondDeployment = `${model.id}:${second}`;
    await t.db.query("UPDATE app.usage_events SET at = at - interval '10 minutes' WHERE deployment = $1", [secondDeployment]);
    await t.db.query("UPDATE app.chatgpt_accounts SET auth_updated_at = now() - interval '10 minutes' WHERE id = $1", [second]);
    await t.db.query(
      `INSERT INTO app.account_events (at, account_id, deployment, status, code, litellm_call_id) VALUES (now() - interval '61 seconds', $1, $2, 401, 'AuthenticationError', 'first-401')`,
      [second, secondDeployment],
    );
    openai.answer('pool-second@example.com', { status: 401, code: 'token_revoked' });
    for (let i = 0; i < 20 && (await stateOf(second)).state !== 'auth_error'; i++) {
      expect(await ask(userId, model.id)).toBe(FAKE_SUBSCRIPTION_ANSWER);
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(await stateOf(second)).toMatchObject({ state: 'auth_error', failureStatus: 401 });
    const { rows: reported } = await t.db.query<{ deployment: string; status: number }>("SELECT deployment, status FROM app.account_events WHERE account_id = $1 AND litellm_call_id <> 'first-401'", [second]);
    expect(reported[0]).toMatchObject({ deployment: secondDeployment, status: 401 });
    const callsBefore = openai.calls.length;
    for (let i = 0; i < 6; i++) expect(await ask(userId, model.id)).toBe(FAKE_SUBSCRIPTION_ANSWER);
    expect(new Set(openai.calls.slice(callsBefore))).toEqual(new Set(['pool-first@example.com']));

    // The first one hits its limit: the attempt is reported with the end of the cooldown.
    openai.answer('pool-first@example.com', { status: 429, code: 'usage_limit_reached' });
    await askError(userId, model.id);
    for (let i = 0; i < 30 && (await stateOf(first)).state !== 'cooldown'; i++) await new Promise((r) => setTimeout(r, 300));
    expect(await stateOf(first)).toMatchObject({ state: 'cooldown', failureStatus: 429 });
  });
});
