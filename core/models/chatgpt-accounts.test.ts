// The pool of ChatGPT accounts in «Нейросеть» (spec, scenario 9, section 8.1): login by a device
// code against a fake OpenAI, the login files, LiteLLM's deployments, the states of the accounts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatGptAccountDto, ChatGptLoginDto, ChatGptLoginStatus, ModelDto, ModelsResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { fakeJwt, startFakeChatGpt, type FakeChatGpt } from './fake-chatgpt.ts';
import { GATEWAY_AUTH_DIR } from './gateway-sync.ts';

let t: TestApp;
let openai: FakeChatGpt;
let igor: string;
let olga: string;
let model: ModelDto;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorOf = async (res: Response) => (await json<{ error: { code: string; message: string } }>(res)).error;

async function startLogin(accountId: string | null = null): Promise<ChatGptLoginDto> {
  const res = await t.call('POST', '/app/api/admin/chatgpt/logins', { cookie: igor, body: { accountId } });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<ChatGptLoginDto>(res);
}

const poll = (loginId: string) => t.call('GET', `/app/api/admin/chatgpt/logins/${loginId}`, { cookie: igor });

async function connect(email: string, workspace?: string): Promise<ChatGptAccountDto> {
  const login = await startLogin();
  openai.approve(login.userCode, { email, ...(workspace ? { workspace } : {}) });
  const res = await poll(login.id);
  expect(res.status, await res.clone().text()).toBe(200);
  const status = await json<ChatGptLoginStatus>(res);
  if (status.status !== 'connected') throw new Error(`login of ${email} is still ${status.status}`);
  return status.account;
}

async function accounts(): Promise<ChatGptAccountDto[]> {
  return (await json<ModelsResponse>(await t.call('GET', '/app/api/admin/models', { cookie: igor }))).accounts;
}

// Deployments of this test installation in the shared test LiteLLM.
async function deployments(): Promise<Set<string>> {
  const all = await t.litellm.listDeployments();
  return new Set(all.filter((d) => d.inDatabase && d.info.bba_owner === t.gatewayOwner).map((d) => d.id));
}

beforeAll(async () => {
  openai = await startFakeChatGpt();
  t = await createTestApp({ chatgpt: { authBase: openai.url } });
  await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: { connection: 'chatgpt', kind: 'chat', label: 'GPT по подписке', providerModel: 'chatgpt/gpt-5.4', vision: true } });
  expect(res.status, await res.clone().text()).toBe(201);
  model = await json<ModelDto>(res);
});
afterAll(async () => {
  await t.close();
  await openai.close();
});

describe('subscription models', () => {
  it('are added without a key and prices', () => {
    expect(model).toMatchObject({ connection: 'chatgpt', providerModel: 'chatgpt/gpt-5.4', prices: null, pricePerMinute: null, keys: [] });
  });

  it('are named chatgpt/<model>', async () => {
    const res = await t.call('POST', '/app/api/admin/models', { cookie: igor, body: { connection: 'chatgpt', kind: 'chat', label: 'x', providerModel: 'openai/gpt-5.4', vision: true } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain('chatgpt/');
  });
});

describe('the login to a ChatGPT account', () => {
  it('shows the code and OpenAI page, waits, then connects the account', async () => {
    const login = await startLogin();
    expect(login).toMatchObject({ userCode: expect.stringMatching(/^CODE-/), verifyUrl: `${openai.url}/codex/device`, intervalSeconds: 1 });
    expect(new Date(login.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await json<ChatGptLoginStatus>(await poll(login.id))).toEqual({ status: 'pending', expiresAt: login.expiresAt });

    openai.approve(login.userCode, { email: 'sales.gpt@example.com' });
    // Asked again sooner than the interval: OpenAI is not asked, the answer is still «ждём».
    expect((await json<ChatGptLoginStatus>(await poll(login.id))).status).toBe('pending');
    await new Promise((r) => setTimeout(r, 1100));
    const done = await json<ChatGptLoginStatus>(await poll(login.id));
    expect(done).toMatchObject({ status: 'connected', account: { email: 'sales.gpt@example.com', state: 'no_requests', tokensToday: 0 } });
    if (done.status !== 'connected') return;
    const id = done.account.id;

    // The tokens: encrypted in the database, as LiteLLM's login file in the folder.
    const { rows } = await t.db.query<{ c: Buffer }>('SELECT auth_ciphertext AS c FROM app.chatgpt_accounts WHERE id = $1', [id]);
    expect(rows[0]!.c.toString('latin1')).not.toContain('refresh-sales.gpt@example.com');
    const file = JSON.parse(readFileSync(join(t.chatgptAuthDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({ refresh_token: 'refresh-sales.gpt@example.com', account_id: 'ws-sales.gpt@example.com', expires_at: expect.any(Number) });

    // LiteLLM serves the subscription model through the account, reading its file where it sees the volume.
    expect((await deployments()).has(`${model.id}:${id}`)).toBe(true);
    const state = await t.accounts.list();
    expect(state.map((a) => a.id)).toContain(id);
    expect(GATEWAY_AUTH_DIR).toBe('/chatgpt-auth');
    // The login is over: asking again finds nothing.
    expect((await poll(login.id)).status).toBe(404);
  });

  it('says the time is out after 15 minutes', async () => {
    const login = await startLogin();
    await t.db.query("UPDATE app.chatgpt_logins SET expires_at = now() - interval '1 second' WHERE id = $1", [login.id]);
    const res = await poll(login.id);
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: 'APP_CHATGPT_LOGIN_EXPIRED', message: 'Время на вход вышло. Начните заново.' });
    expect((await t.db.query('SELECT 1 FROM app.chatgpt_logins WHERE id = $1', [login.id])).rows).toHaveLength(0);
  });

  it('says the login failed when OpenAI refused it', async () => {
    const login = await startLogin();
    openai.refuse(login.userCode);
    const res = await poll(login.id);
    expect(await errorOf(res)).toMatchObject({ code: 'APP_CHATGPT_LOGIN_FAILED', message: 'Вход не выполнен. Попробуйте ещё раз.' });
  });

  it('does not connect the same account twice, but a team subscription of the same person is another account', async () => {
    const login = await startLogin();
    openai.approve(login.userCode, { email: 'Sales.GPT@example.com', workspace: 'ws-sales.gpt@example.com' });
    const res = await poll(login.id);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe('Этот аккаунт уже подключён: sales.gpt@example.com.');
    expect((await accounts()).filter((a) => a.email.toLowerCase() === 'sales.gpt@example.com')).toHaveLength(1);

    const team = await connect('sales.gpt@example.com', 'ws-team');
    expect(team.email).toBe('sales.gpt@example.com');
    expect((await accounts()).filter((a) => a.email === 'sales.gpt@example.com')).toHaveLength(2);
  });

  it('is open only to roles with the right «Нейросеть»', async () => {
    expect((await t.call('POST', '/app/api/admin/chatgpt/logins', { cookie: olga, body: { accountId: null } })).status).toBe(403);
    expect((await t.call('DELETE', '/app/api/admin/chatgpt/accounts/a-00000000', { cookie: olga })).status).toBe(403);
  });
});

describe('an account in the pool', () => {
  it('leaves LiteLLM on an access error and comes back after «Войти заново» into the same account only', async () => {
    const account = await connect('revoked@example.com');
    const deployment = `${model.id}:${account.id}`;
    const res = await t.app.request('/app/api/internal/account-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.ledgerSecret}` },
      body: JSON.stringify({ litellm_call_id: 'c-401', status: 'failure', startTime: Date.now() / 1000, model_id: deployment, error_information: { error_code: '401', error_class: 'AuthenticationError' } }),
    });
    expect(res.status).toBe(200);
    expect((await accounts()).find((a) => a.id === account.id)).toMatchObject({ state: 'auth_error', failureStatus: 401 });
    expect((await deployments()).has(deployment)).toBe(false);

    const wrong = await startLogin(account.id);
    openai.approve(wrong.userCode, { email: 'someone.else@example.com' });
    expect((await errorOf(await poll(wrong.id))).message).toBe('Вы вошли в someone.else@example.com, а входили заново в revoked@example.com. Войдите в нужный аккаунт.');

    const again = await startLogin(account.id);
    openai.approve(again.userCode, { email: 'revoked@example.com' });
    const back = await json<ChatGptLoginStatus>(await poll(again.id));
    expect(back).toMatchObject({ status: 'connected', account: { id: account.id } });
    expect((await accounts()).find((a) => a.id === account.id)?.state).not.toBe('auth_error');
    expect((await deployments()).has(deployment)).toBe(true);
  });

  it('stays in LiteLLM after a rate limit and shows the cooldown', async () => {
    const account = await connect('busy@example.com');
    await t.accounts.attemptFailed(account.id, 429);
    expect((await deployments()).has(`${model.id}:${account.id}`)).toBe(true);
    await t.db.query(
      `INSERT INTO app.account_events (at, account_id, deployment, status, code, cooldown_until, litellm_call_id)
       VALUES (now(), $1, $2, 429, 'RateLimitError', now() + interval '60 seconds', 'c-429')`,
      [account.id, `${model.id}:${account.id}`],
    );
    expect((await accounts()).find((a) => a.id === account.id)).toMatchObject({ state: 'cooldown', failureStatus: 429, cooldownUntil: expect.any(String) });
  });

  it('works when it answered within 30 days, with today\'s tokens', async () => {
    const account = await connect('works@example.com');
    const deployment = `${model.id}:${account.id}`;
    await t.db.query(
      `INSERT INTO app.usage_events (at, model, deployment, is_subscription, input_tokens, output_tokens, cost_rub, litellm_call_id)
       VALUES (now() - interval '2 days', $1, $2, true, 1000, 500, 0, 'u-old'), (now(), $1, $2, true, 100, 20, 0, 'u-today')`,
      [model.id, deployment],
    );
    // A failure before the last success does not cool it down.
    await t.db.query(
      `INSERT INTO app.account_events (at, account_id, deployment, status, code, cooldown_until, litellm_call_id)
       VALUES (now() - interval '10 seconds', $1, $2, 429, 'RateLimitError', now() + interval '50 seconds', 'c-before')`,
      [account.id, deployment],
    );
    expect((await accounts()).find((a) => a.id === account.id)).toMatchObject({ state: 'works', tokensToday: 120, lastSuccessAt: expect.any(String) });
  });

  it('is disconnected with its deployments and login file', async () => {
    const account = await connect('leaving@example.com');
    const file = join(t.chatgptAuthDir, `${account.id}.json`);
    expect(existsSync(file)).toBe(true);
    const res = await t.call('DELETE', `/app/api/admin/chatgpt/accounts/${account.id}`, { cookie: igor });
    expect(res.status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await deployments()).has(`${model.id}:${account.id}`)).toBe(false);
    expect((await accounts()).some((a) => a.id === account.id)).toBe(false);
  });
});

describe('the start of the server', () => {
  it('keeps the token LiteLLM refreshed in the file and restores a lost file (V19)', async () => {
    const refreshed = await connect('refreshed@example.com');
    const lost = await connect('lost@example.com');
    const refreshedFile = join(t.chatgptAuthDir, `${refreshed.id}.json`);
    const saved = JSON.parse(readFileSync(refreshedFile, 'utf8')) as { expires_at: number };
    // LiteLLM refreshed the token: a newer one in the file, the refresh token replaced.
    const newer = { ...saved, access_token: fakeJwt({ exp: saved.expires_at + 3600 }), refresh_token: 'refresh-rotated', expires_at: saved.expires_at + 3600 };
    writeFileSync(refreshedFile, JSON.stringify(newer));
    const lostFile = join(t.chatgptAuthDir, `${lost.id}.json`);
    writeFileSync(lostFile, '{ broken');
    const orphan = join(t.chatgptAuthDir, 'a-0badf00d.json');
    writeFileSync(orphan, '{}');

    await t.accounts.prepare();
    // A second start with the same files changes nothing.
    await t.accounts.prepare();

    expect(JSON.parse(readFileSync(refreshedFile, 'utf8'))).toMatchObject({ refresh_token: 'refresh-rotated' });
    expect(JSON.parse(readFileSync(lostFile, 'utf8'))).toMatchObject({ refresh_token: 'refresh-lost@example.com' });
    expect(existsSync(orphan)).toBe(false);
    // The database took the fresher token: losing the volume would not bring back the replaced one.
    writeFileSync(refreshedFile, '');
    await t.accounts.prepare();
    expect(JSON.parse(readFileSync(refreshedFile, 'utf8'))).toMatchObject({ refresh_token: 'refresh-rotated' });
  });
});
