// End-to-end through the test LiteLLM (deploy/compose.dev.yaml: litellm-test, mock models).
// This is the only test file that listens on TEST_CALLBACK_PORT for LiteLLM's usage callback.
import { serve, type ServerType } from '@hono/node-server';
import { Agent } from '@mastra/core/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { createLiteLLMClient } from './litellm-client.ts';
import { createModelGateway } from './gateway.ts';
import { createSecretBox } from '../crypto/secret-box.ts';
import { TEST_CATALOG, TEST_CALLBACK_PORT } from './test-catalog.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';

let t: TestApp;
let server: ServerType;

beforeAll(async () => {
  t = await createTestApp();
  server = serve({ fetch: t.app.fetch, port: TEST_CALLBACK_PORT, hostname: '0.0.0.0' });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await t.close();
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

  it('recognises a refused provider key in the text of a chat stream error, which has no status', async () => {
    const userId = await t.createUser({ email: 'auth@example.com' });
    // As it reaches the chat in RUN_ERROR: the AI SDK message of LiteLLM's 401, without the response.
    const raw = "AI_APICallError: litellm.AuthenticationError: AuthenticationError: OpenAIException - Incorrect API key provided: sk-x*****. LiteLLM: model group 'main' failed with the error above.";
    expect((await t.gateway.translateError(new Error(raw), userId)).code).toBe('APP_MODEL_AUTH_FAILED');
  });

  it('reports an unreachable LiteLLM as the gateway being down', async () => {
    const userId = await t.createUser({ email: 'gateway@example.com' });
    const config = await t.gateway.modelConfig('test-paid', userId, 'sales');
    const broken = createModelGateway({
      db: t.db,
      client: createLiteLLMClient('http://127.0.0.1:9', 'sk-x'),
      box: createSecretBox(TEST_ENCRYPTION_KEYS),
      catalog: TEST_CATALOG,
      timezone: 'Europe/Moscow',
    });
    const agent = new Agent({ id: 'sales', name: 'sales', instructions: 'x', model: { ...config, url: 'http://127.0.0.1:9/v1' } });
    const error = await agent.generate('привет').then(
      () => null,
      (e: unknown) => broken.translateError(e, userId),
    );
    expect(error?.code).toBe('APP_MODEL_GATEWAY_UNAVAILABLE');
  });

  it('refuses a subscription call past the daily token cap, before calling the model', async () => {
    const userId = await t.createUser({ email: 'daily@example.com' });
    await t.db.query('INSERT INTO app.user_limits (user_id, daily_subscription_tokens) VALUES ($1, 500)', [userId]);
    await t.db.query(
      `INSERT INTO app.usage_events (at, user_id, model, is_subscription, input_tokens, output_tokens, litellm_call_id)
       VALUES (now(), $1, 'test-sub', true, 400, 200, 'manual-' || $1)`,
      [userId],
    );
    await expect(t.gateway.assertCanCall(userId, 'test-sub')).rejects.toMatchObject({ code: 'APP_USAGE_DAILY_CAP_EXCEEDED' });
    await expect(t.gateway.assertCanCall(userId, 'test-paid')).resolves.toBeUndefined();
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

  it('accepts usage records only with the shared secret', async () => {
    const res = await t.app.request('/app/api/internal/usage', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });
});
