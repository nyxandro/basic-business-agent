// POST /app/api/internal/account-events: what LiteLLM reports of each failed attempt (spec, 8.1, V20).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { COOLDOWN_SECONDS } from './litellm-config.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

// A minute ago, in LiteLLM's seconds with a fraction.
const STARTED = Math.floor(Date.now() / 1000) - 60 + 0.5;

async function addAccount(id: string, email: string): Promise<void> {
  await t.db.query(`INSERT INTO app.chatgpt_accounts (id, email, auth_ciphertext, auth_iv, auth_key_version) VALUES ($1, $2, '\\x00', '\\x00', 1)`, [id, email]);
}

function failure(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c-1',
    litellm_call_id: 'c-1',
    status: 'failure',
    startTime: STARTED - 2,
    endTime: STARTED,
    model_group: 'm-sub00001',
    model_id: 'm-sub00001:a-0000000a',
    error_str: 'litellm.RateLimitError: usage limit reached',
    error_information: { error_code: '429', error_class: 'RateLimitError', error_message: 'usage limit reached' },
    ...over,
  };
}

function post(body: unknown, secret = t.ledgerSecret): Promise<Response> {
  return Promise.resolve(
    t.app.request('/app/api/internal/account-events', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` } }),
  );
}

interface EventRow {
  account_id: string;
  deployment: string;
  status: number | null;
  code: string | null;
  at: Date;
  cooldown_until: Date | null;
}

async function events(accountId: string): Promise<EventRow[]> {
  const { rows } = await t.db.query<EventRow>('SELECT account_id, deployment, status, code, at, cooldown_until FROM app.account_events WHERE account_id = $1 ORDER BY id', [accountId]);
  return rows;
}

describe('failed attempts of the ChatGPT accounts', () => {
  beforeAll(async () => {
    await addAccount('a-0000000a', 'first@example.com');
    await addAccount('a-0000000b', 'second@example.com');
    await addAccount('a-0000000c', 'third@example.com');
  });

  it('keeps an attempt of an account with its deployment, code and the end of the cooldown', async () => {
    const res = await post(failure());
    expect(res.status).toBe(200);
    const [row] = await events('a-0000000a');
    expect(row).toMatchObject({ deployment: 'm-sub00001:a-0000000a', status: 429, code: 'RateLimitError' });
    expect(row!.at.getTime()).toBe(STARTED * 1000);
    expect(row!.cooldown_until!.getTime()).toBe(STARTED * 1000 + COOLDOWN_SECONDS * 1000);
  });

  it('does not keep the same attempt twice', async () => {
    const event = failure({ id: 'c-2', litellm_call_id: 'c-2', model_id: 'm-sub00001:a-0000000b' });
    await post(event);
    await post([event]);
    expect(await events('a-0000000b')).toHaveLength(1);
  });

  it('marks no cooldown for errors after which LiteLLM keeps sending to the account', async () => {
    await post(failure({ id: 'c-3', litellm_call_id: 'c-3', model_id: 'm-sub00001:a-0000000c', error_information: { error_code: '400', error_class: 'BadRequestError' } }));
    await post(failure({ id: 'c-4', litellm_call_id: 'c-4', model_id: 'm-sub00001:a-0000000c', error_information: { error_code: '500', error_class: 'APIConnectionError' } }));
    const rows = await events('a-0000000c');
    expect(rows.map((r) => [r.status, r.cooldown_until])).toEqual([
      [400, null],
      [500, null],
    ]);
  });

  it('ignores deployments on keys, unknown accounts and successes', async () => {
    await post(failure({ id: 'c-5', litellm_call_id: 'c-5', model_id: 'm-key00001:k-0000000a' }));
    await post(failure({ id: 'c-6', litellm_call_id: 'c-6', model_id: 'm-sub00001:a-ffffffff' }));
    await post(failure({ id: 'c-7', litellm_call_id: 'c-7', model_id: null }));
    await post(failure({ id: 'c-8', litellm_call_id: 'c-8', status: 'success' }));
    const { rows } = await t.db.query<{ n: string }>("SELECT count(*) AS n FROM app.account_events WHERE litellm_call_id IN ('c-5', 'c-6', 'c-7', 'c-8')");
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('forgets attempts older than 30 days', async () => {
    await t.db.query(
      `INSERT INTO app.account_events (at, account_id, deployment, status, code, litellm_call_id) VALUES (now() - interval '31 days', 'a-0000000a', 'm-sub00001:a-0000000a', 429, 'RateLimitError', 'old')`,
    );
    await post(failure({ id: 'c-9', litellm_call_id: 'c-9', endTime: Date.now() / 1000 }));
    const { rows } = await t.db.query<{ litellm_call_id: string }>("SELECT litellm_call_id FROM app.account_events WHERE account_id = 'a-0000000a' ORDER BY id");
    expect(rows.map((r) => r.litellm_call_id)).toEqual(['c-1', 'c-9']);
  });

  it('refuses records without the shared secret', async () => {
    const res = await post(failure({ id: 'c-10', litellm_call_id: 'c-10' }), 'wrong');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_INTERNAL_UNAUTHORIZED' } });
  });

  it('refuses a record LiteLLM did not fill', async () => {
    const res = await post({ status: 'failure' });
    expect(res.status).toBe(400);
  });
});
