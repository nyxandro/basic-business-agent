// Which model answers (spec, section 8.1): the order of choice, the daily cap of the subscription,
// an empty installation, and V15 — the fallback model takes over on an error and on silence.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { startFakeModel, type FakeModel } from './fake-openai.ts';
import { chooseModels } from './resolve.ts';
import { AGENT_HEADER } from './usage.ts';

const TZ = 'Europe/Moscow';
let t: TestApp;
let userId: string;

async function settings(patch: { primary?: string | null; fallback?: string | null; choose?: boolean }): Promise<void> {
  await t.db.query('UPDATE app.model_settings SET primary_model_id = $1, fallback_model_id = $2, agents_choose_model = $3', [
    patch.primary === undefined ? 'test-paid' : patch.primary,
    patch.fallback ?? null,
    patch.choose ?? false,
  ]);
}
const ownModel = (agentId: string, modelId: string | null) =>
  t.db.query('INSERT INTO app.agent_overrides (agent_id, model_id) VALUES ($1, $2) ON CONFLICT (agent_id) DO UPDATE SET model_id = EXCLUDED.model_id', [agentId, modelId]);
const enable = (modelId: string, enabled: boolean) => t.db.query('UPDATE app.models SET enabled = $2 WHERE id = $1', [modelId, enabled]);

beforeAll(async () => {
  t = await createTestApp();
  userId = await t.createUser({ email: 'olga@example.com' });
});
afterAll(async () => {
  await t.close();
});

describe('choice of the model', () => {
  it('takes the agent’s own model only while agents choose models and the model is enabled', async () => {
    await ownModel('sales', 'test-ratelimited');
    await settings({ choose: true });
    expect(await chooseModels(t.db, TZ, userId, 'sales')).toEqual({ primary: 'test-ratelimited', fallback: null });
    expect(await chooseModels(t.db, TZ, userId, 'assistant')).toEqual({ primary: 'test-paid', fallback: null });
    await enable('test-ratelimited', false);
    expect((await chooseModels(t.db, TZ, userId, 'sales')).primary).toBe('test-paid');
    await enable('test-ratelimited', true);
    await settings({ choose: false });
    expect((await chooseModels(t.db, TZ, userId, 'sales')).primary).toBe('test-paid');
    await ownModel('sales', null);
  });

  it('puts the fallback second when it is enabled and differs from the chosen model', async () => {
    await settings({ fallback: 'test-down' });
    expect(await chooseModels(t.db, TZ, userId, 'sales')).toEqual({ primary: 'test-paid', fallback: 'test-down' });
    await enable('test-down', false);
    expect((await chooseModels(t.db, TZ, userId, 'sales')).fallback).toBeNull();
    await enable('test-down', true);
    // The agent's own model equal to the fallback leaves no second model.
    await ownModel('sales', 'test-down');
    await settings({ fallback: 'test-down', choose: true });
    expect(await chooseModels(t.db, TZ, userId, 'sales')).toEqual({ primary: 'test-down', fallback: null });
    await ownModel('sales', null);
    await settings({});
  });

  it('answers APP_MODEL_NOT_CONFIGURED without an enabled model', async () => {
    await settings({ primary: null });
    await expect(chooseModels(t.db, TZ, userId, 'sales')).rejects.toMatchObject({ code: 'APP_MODEL_NOT_CONFIGURED', userMessage: 'Модели ещё не настроены. Обратитесь к администратору.' });
    await settings({});
    await enable('test-paid', false);
    await expect(chooseModels(t.db, TZ, userId, 'sales')).rejects.toMatchObject({ code: 'APP_MODEL_NOT_CONFIGURED' });
    await enable('test-paid', true);
  });

  it('applies the daily cap of the subscription: a capped primary refuses, a capped fallback is left out', async () => {
    const capped = await t.createUser({ email: 'daily@example.com' });
    await t.db.query('INSERT INTO app.user_limits (user_id, daily_subscription_tokens) VALUES ($1, 500)', [capped]);
    await t.db.query(
      `INSERT INTO app.usage_events (at, user_id, model, is_subscription, input_tokens, output_tokens, litellm_call_id) VALUES (now(), $1, 'test-sub', true, 400, 200, 'manual-' || $1)`,
      [capped],
    );
    await settings({ primary: 'test-sub' });
    await expect(chooseModels(t.db, TZ, capped, 'sales')).rejects.toMatchObject({ code: 'APP_USAGE_DAILY_CAP_EXCEEDED' });
    expect((await chooseModels(t.db, TZ, userId, 'sales')).primary).toBe('test-sub');
    await settings({ fallback: 'test-sub' });
    expect(await chooseModels(t.db, TZ, capped, 'sales')).toEqual({ primary: 'test-paid', fallback: null });
    expect(await chooseModels(t.db, TZ, userId, 'sales')).toEqual({ primary: 'test-paid', fallback: 'test-sub' });
    await settings({});
  });
});

describe('an installation without models', () => {
  it('tells the employee that models are not set up yet', async () => {
    const empty = await createTestApp({ noModels: true });
    try {
      await empty.createUser({ email: 'igor@example.com', roleIds: [await empty.roleId('superadmin')] });
      const cookie = await empty.signIn('igor@example.com');
      const res = await empty.call('POST', '/app/api/copilotkit/agent/sales/run', {
        cookie,
        body: { threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'привет' }], tools: [], context: [], state: {}, forwardedProps: {} },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'APP_MODEL_NOT_CONFIGURED', message: 'Модели ещё не настроены. Обратитесь к администратору.' } });
    } finally {
      await empty.close();
    }
  });
});

// V15: the run goes on the fallback when the primary answers 500 or sends nothing in time; the
// fallback's request still names the agent for the ledger.
describe('the fallback model (V15)', () => {
  let primary: FakeModel;
  let fallback: FakeModel;
  let app: TestApp;
  let cookie: string;

  async function ask(text: string): Promise<string> {
    const res = await app.call('POST', '/app/api/copilotkit/agent/sales/run', {
      cookie,
      body: { threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
    });
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as { type: string; delta?: string });
    return events.filter((e) => e.type === 'TEXT_MESSAGE_CHUNK' || e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta ?? '').join('');
  }

  beforeAll(async () => {
    primary = await startFakeModel();
    fallback = await startFakeModel({ fallback: () => ({ text: 'Ответила запасная' }) });
    app = await createTestApp({ firstChunkMs: 1_000, modelConfig: (id) => ({ url: id === 'test-paid' ? primary.url : fallback.url, apiKey: 'x' }) });
    await app.db.query("UPDATE app.model_settings SET fallback_model_id = 'test-down'");
    await app.createUser({ email: 'igor@example.com', roleIds: [await app.roleId('superadmin')] });
    cookie = await app.signIn('igor@example.com');
  });
  afterAll(async () => {
    await app.close();
    await primary.close();
    await fallback.close();
  });

  it('answers on the primary while it works', async () => {
    primary.script({ text: 'Ответила основная' });
    expect(await ask('привет')).toBe('Ответила основная');
  });

  it('goes on the fallback when the primary fails', async () => {
    primary.script({ status: 500, error: 'provider is down' });
    const before = fallback.requests.length;
    expect(await ask('привет')).toBe('Ответила запасная');
    expect(fallback.requests.length).toBe(before + 1);
    expect(fallback.requests.at(-1)!.headers[AGENT_HEADER]).toBe('sales');
  });

  it('goes on the fallback when the primary sends nothing in time', async () => {
    primary.script({ text: 'Слишком поздно', delayMs: 3_000 });
    const started = Date.now();
    expect(await ask('привет')).toBe('Ответила запасная');
    expect(Date.now() - started).toBeLessThan(2_900);
  });
});
